import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { OrderEvent } from '../src/orders.js';
import { renderProofStoryboard } from '../src/proof-view.js';
import {
  canonicalJson,
  evidencePayload,
  evidenceRoot,
  hashEvidenceEvent,
  verifyEvidenceChain,
} from '../src/proof.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/evidence-chain-v1.json', import.meta.url), 'utf8'),
) as { order_id: string; root: string; events: OrderEvent[] };

assert.equal(await evidenceRoot(fixture.order_id), fixture.root, 'fixture root must be stable');
for (const event of fixture.events) {
  assert.equal(
    await hashEvidenceEvent(event as Parameters<typeof hashEvidenceEvent>[0]),
    event.event_hash,
    `event ${event.seq} hash must match the cross-runtime fixture`,
  );
}

assert.equal(
  canonicalJson(
    evidencePayload(
      fixture.events[1] as Parameters<typeof evidencePayload>[0],
    ) as unknown as Parameters<typeof canonicalJson>[0],
  ),
  '{"evidence_version":"buywith402/evidence-chain/v1","message":"place-order-review",' +
    '"order_id":"demo-order-π-001","previous_hash":' +
    '"a9ecf1a1b0a18e7f0f84b103a4c5dd2cb0379caa8894547abe41665d516ccfdb",' +
    '"screenshot_sha256":"b70afcbb48339163dd19430809ca06607e284574c00d7abb6d1cfa5f32dea8b2",' +
    '"screenshot_url":"https://example.test/review.png","seq":1,"stage":"checkpoint",' +
    '"t":"2026-07-12T08:00:04+00:00"}',
  'canonical payload must be recursively key-sorted with no whitespace',
);

const valid = await verifyEvidenceChain(fixture.order_id, fixture.events);
assert.equal(valid.status, 'verified');
assert.equal(valid.verified, true);
assert.equal(valid.event_count, 2);
assert.equal(valid.verified_event_count, 2);
assert.equal(valid.head, fixture.events[1].event_hash);

const tampered = structuredClone(fixture.events);
tampered[1].message = 'order-confirmed';
const tamperedResult = await verifyEvidenceChain(fixture.order_id, tampered);
assert.equal(tamperedResult.status, 'invalid');
assert.match(tamperedResult.errors.join(' '), /content hash/);

const reordered = [fixture.events[1], fixture.events[0]];
assert.equal((await verifyEvidenceChain(fixture.order_id, reordered)).status, 'invalid');

const truncated = await verifyEvidenceChain(fixture.order_id, fixture.events.slice(0, 1), {
  head: fixture.events[1].event_hash,
  eventCount: 2,
});
assert.equal(truncated.status, 'invalid');
assert.match(truncated.errors.join(' '), /anchor/);

const legacy: OrderEvent[] = [
  { seq: 0, t: '2026-07-12T07:59:00+00:00', stage: 'worker', message: 'legacy event' },
];
const legacyResult = await verifyEvidenceChain(fixture.order_id, legacy);
assert.equal(legacyResult.status, 'unavailable');
assert.equal(legacyResult.verified, false);
assert.equal(legacyResult.event_count, 1);

const stripped = structuredClone(fixture.events);
delete stripped[1].event_hash;
assert.equal((await verifyEvidenceChain(fixture.order_id, stripped)).status, 'invalid');

const deletedAll = await verifyEvidenceChain(fixture.order_id, [], {
  head: fixture.events[1].event_hash,
  eventCount: 2,
});
assert.equal(deletedAll.status, 'invalid');

const html = renderProofStoryboard(
  {
    order_id: fixture.order_id,
    product_id: 'mcmaster:92224A112',
    quantity: 1,
    dry_run: true,
    status: 'ready_to_place',
    created_at: '2026-07-12T08:00:00+00:00',
    updated_at: '2026-07-12T08:00:04+00:00',
    shipping: {
      name: 'Demo Buyer',
      address_1: '123 Demo St',
      city: 'San Francisco',
      state: 'CA',
      zip: '94114',
      country: 'US',
    },
  },
  fixture.events,
  valid,
  'f'.repeat(64),
);
assert.match(html, /Proof, not just/);
assert.match(html, /CHAIN VERIFIED/);
assert.match(html, /https:\/\/example\.test\/review\.png/);
assert.doesNotMatch(html, /<script/);

// Exercise both free HTTP proof surfaces against a deterministic Redis REST
// stand-in. This also guards route ordering around the paid middleware.
process.env.X402_PAY_TO = `0x${'1'.repeat(40)}`;
process.env.KV_REST_API_URL = 'https://redis.fixture.test';
process.env.KV_REST_API_TOKEN = 'fixture-token';
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  if (!init?.body) {
    return new Response(
      JSON.stringify({
        kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }],
        extensions: [],
        signers: {},
      }),
    );
  }
  const command = JSON.parse(String(init?.body)) as string[];
  if (command[0] === 'HGETALL') {
    return new Response(
      JSON.stringify({
        result: [
          'order_id',
          fixture.order_id,
          'product_id',
          'mcmaster:92224A112',
          'quantity',
          '1',
          'dry_run',
          '1',
          'status',
          'ready_to_place',
          'created_at',
          '2026-07-12T08:00:00+00:00',
          'updated_at',
          '2026-07-12T08:00:04+00:00',
          'shipping',
          JSON.stringify({
            name: 'Demo Buyer',
            address_1: '123 Demo St',
            city: 'San Francisco',
            state: 'CA',
            zip: '94114',
            country: 'US',
          }),
          'evidence_head',
          fixture.events[1].event_hash,
          'evidence_count',
          '2',
        ],
      }),
    );
  }
  if (command[0] === 'LRANGE') {
    return new Response(
      JSON.stringify({ result: fixture.events.map((event) => JSON.stringify(event)) }),
    );
  }
  return new Response(JSON.stringify({ error: `unexpected fixture command ${command[0]}` }));
}) as typeof fetch;
try {
  const app = (await import('../src/app.js')).default;
  const proofResponse = await app.request(
    `/orders/${encodeURIComponent(fixture.order_id)}/proof`,
  );
  assert.equal(proofResponse.status, 200);
  const proofBody = (await proofResponse.json()) as {
    proof: { verified: boolean; event_count: number; root: string };
    receipt: { receipt_hash: string };
  };
  assert.equal(proofBody.proof.verified, true);
  assert.equal(proofBody.proof.event_count, 2);
  assert.equal(proofBody.proof.root, fixture.root);
  assert.match(proofBody.receipt.receipt_hash, /^[a-f0-9]{64}$/);

  const viewResponse = await app.request(
    `/orders/${encodeURIComponent(fixture.order_id)}/proof/view`,
  );
  assert.equal(viewResponse.status, 200);
  assert.match(await viewResponse.text(), /CHAIN VERIFIED/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(
  `verified TypeScript canonicalization + tamper cases: ${valid.event_count} events, head=${valid.head}`,
);
