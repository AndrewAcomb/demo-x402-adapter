#!/usr/bin/env node
/**
 * End-to-end smoke test for the fully-mocked demo flow.
 *
 * Spawns the server with all mocks forced, then drives the browser
 * WebSocket protocol programmatically:
 *   speak (typed) -> intent -> discovery -> catalog -> choice ->
 *   confirmation ("yes") -> simulated x402 payment -> canned fulfillment
 *   with screenshots -> final confirmation.
 *
 * Exit 0 iff every assertion passes.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.SMOKE_PORT || '4102';
const BASE = `http://localhost:${PORT}`;
const UTTERANCE = 'order a pack of 4-40 quarter-inch screws to the office';
const EXPECTED_PRODUCT = 'mcmaster:92224A112';

const failures = [];
const passes = [];
function check(name, ok, detail = '') {
  (ok ? passes : failures).push(name + (detail ? ` — ${detail}` : ''));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const server = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT,
    MOCK_VOICE: '1',
    MOCK_LLM: '1',
    MOCK_MERCHANT: '1',
    MOCK_PAY: '1',
    DEMO_DRY_RUN: '1',
    MOCK_EVENT_MS: '120', // fast canned fulfillment for CI-speed smoke
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

function cleanup(code) {
  server.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300).unref();
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up; log:\n${serverLog}`);
}

try {
  const health = await waitForServer();
  check('healthz responds', health.ok === true);
  check(
    'all subsystems mocked',
    ['voice', 'llm', 'merchant', 'pay'].every((k) => ['mock'].includes(health.modes[k])),
    JSON.stringify(health.modes),
  );

  const page = await (await fetch(`${BASE}/`)).text();
  check('UI served', page.includes('Voice Concierge') || page.includes('Voice <span>Concierge'));

  const products = await (await fetch(`${BASE}/mock-merchant/products`)).json();
  check('mock merchant lists products', (products.products?.length ?? 0) >= 3);

  const unpaid = await fetch(`${BASE}/mock-merchant/products/${EXPECTED_PRODUCT}/purchase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  check('unpaid purchase gets 402 challenge', unpaid.status === 402);
  check('402 carries PAYMENT-REQUIRED header', !!unpaid.headers.get('payment-required'));

  // --- Drive the full flow over the browser WebSocket protocol ---------------
  const msgs = [];
  const byType = (t) => msgs.filter((m) => m.type === t);
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('flow timed out after 45s')), 45_000);
    let confirmed = false;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      msgs.push(m);
      if (m.type === 'await_confirmation' && !confirmed) {
        confirmed = true;
        // Confirm by "voice" (typed), exercising the yes/no matcher.
        ws.send(JSON.stringify({ type: 'text_input', text: 'yes, go ahead' }));
      }
      if (m.type === 'done') {
        clearTimeout(timeout);
        resolve(m);
      }
      if (m.type === 'error') console.log('  [server error msg]', m.message);
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'text_input', text: UTTERANCE })));
    ws.on('error', reject);
  });

  const final = await done;
  ws.close();

  check('config message received', byType('config').length === 1);
  const choice = byType('choice')[0];
  check('a product was chosen', !!choice, choice?.product?.id);
  check('chose the 4-40 x 1/4" screws', choice?.product?.id === EXPECTED_PRODUCT);
  check('choice includes a spoken justification', (choice?.reason ?? '').length > 10, choice?.reason);
  check('confirmation was requested', byType('await_confirmation').length === 1);
  const order = byType('order')[0];
  check('order created after voice confirmation', !!order?.order_id, order?.order_id);
  check('order is a dry run', order?.dry_run === true);
  const events = byType('fulfillment_event').map((m) => m.event);
  check('at least 8 fulfillment events streamed', events.length >= 8, `${events.length} events`);
  const shots = events.filter((e) => e.screenshot_url);
  check('at least 2 screenshot events', shots.length >= 2, `${shots.length} screenshots`);
  check(
    'screenshots are data URIs (offline)',
    shots.every((e) => e.screenshot_url.startsWith('data:image/')),
  );
  check(
    'checkout checkpoints present',
    ['cart-cleared', 'product-in-cart', 'place-order-review'].every((cp) =>
      events.some((e) => e.stage === 'checkpoint' && e.message === cp),
    ),
  );
  check('flow finished successfully', final.outcome === 'success', `outcome=${final.outcome}`);
  const sayLines = byType('say').map((m) => m.text);
  check('narration lines spoken', sayLines.length >= 6, `${sayLines.length} lines`);
  check(
    'payment simulation logged server-side',
    serverLog.includes('payment SIMULATED'),
  );

  console.log('\n--- narration transcript ---');
  for (const line of sayLines) console.log('  🗣', line);

  console.log(`\n${passes.length} passed, ${failures.length} failed`);
  cleanup(failures.length ? 1 : 0);
} catch (e) {
  console.error('SMOKE FATAL:', e.message);
  console.error('server log tail:\n' + serverLog.split('\n').slice(-20).join('\n'));
  cleanup(1);
}
