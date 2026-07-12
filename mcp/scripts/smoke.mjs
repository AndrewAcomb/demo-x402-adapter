/**
 * End-to-end smoke test: launches the x402 Shopper MCP server over stdio and
 * drives it with a REAL MCP client session. Fully mocked (MOCK_MERCHANT +
 * MOCK_PAY) so it runs offline with no wallet key.
 *
 * Flow: initialize -> list tools -> wallet_status -> discover_merchants ->
 * list_products -> inspect_purchase -> buy (dry-run) -> buy (confirm) ->
 * track_order (asserts progress notifications streamed, with screenshots).
 *
 *   node scripts/smoke.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, '..', 'src', 'server.ts');

const log = (...a) => console.log(...a);
const section = (t) => log(`\n=== ${t} ===`);

function parse(result) {
  const txt = result?.content?.find((c) => c.type === 'text')?.text ?? '{}';
  try {
    return JSON.parse(txt);
  } catch {
    return { _raw: txt };
  }
}

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', 'tsx', serverPath],
  env: {
    ...process.env,
    MOCK_MERCHANT: '1',
    MOCK_PAY: '1',
    ALLOW_REAL_PURCHASE: '1',
    MAX_SPEND_USD: '50',
    SESSION_BUDGET_USD: '100',
    MERCHANT_URLS: 'https://buywith402.com',
  },
});

const client = new Client({ name: 'smoke-test', version: '0.0.0' });

async function main() {
  await client.connect(transport);
  section('initialize');
  log('connected. server:', JSON.stringify(client.getServerVersion()));

  section('tools/list');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  log('tools:', names.join(', '));
  for (const t of ['wallet_status', 'discover_merchants', 'list_products', 'inspect_purchase', 'buy', 'track_order']) {
    assert.ok(names.includes(t), `missing tool ${t}`);
  }

  section('wallet_status');
  const status = parse(await client.callTool({ name: 'wallet_status', arguments: {} }));
  log(JSON.stringify(status, null, 2));
  assert.equal(status.max_spend_usd, 50);
  assert.equal(status.session_budget_usd, 100);

  section('discover_merchants');
  const disc = parse(await client.callTool({ name: 'discover_merchants', arguments: { query: 'screw' } }));
  log(JSON.stringify(disc, null, 2));
  assert.ok(disc.count >= 1, 'expected >=1 merchant');
  const merchant = disc.merchants[0];
  assert.ok(merchant.sample_products.length >= 1, 'expected sample products');

  section('list_products');
  const list = parse(await client.callTool({ name: 'list_products', arguments: { merchant_url: merchant.base_url } }));
  log(`merchant=${list.merchant_url} count=${list.count}`);
  const product = list.products.find((p) => p.price_usd && p.price_usd <= 50);
  log('chosen product:', JSON.stringify(product));
  assert.ok(product, 'expected an affordable product');

  section('inspect_purchase (no payment)');
  const shipping = { name: 'Ada Lovelace', address_1: '1 Analytical Way', city: 'London', state: 'CA', zip: '94000', country: 'US' };
  const inspect = parse(
    await client.callTool({ name: 'inspect_purchase', arguments: { merchant_url: merchant.base_url, product_id: product.id, shipping } }),
  );
  log(JSON.stringify(inspect, null, 2));
  assert.equal(inspect.spends_now, false);
  assert.ok(inspect.would_charge_usd > 0, 'expected a positive quote');

  section('buy (DRY-RUN — confirm omitted)');
  const dry = parse(
    await client.callTool({ name: 'buy', arguments: { merchant_url: merchant.base_url, product_id: product.id, shipping } }),
  );
  log(JSON.stringify(dry, null, 2));
  assert.equal(dry.mode, 'dry_run');
  assert.equal(dry.spent, false);
  assert.ok(dry.to_confirm?.arguments?.confirm === true, 'dry-run should return confirm args');

  section('buy (CONFIRMED — mock settlement)');
  const bought = parse(
    await client.callTool({
      name: 'buy',
      arguments: { merchant_url: merchant.base_url, product_id: product.id, shipping, confirm: true },
    }),
  );
  log(JSON.stringify(bought, null, 2));
  assert.equal(bought.mode, 'purchased');
  assert.equal(bought.spent, true);
  assert.ok(bought.order_id, 'expected an order_id');
  assert.ok(bought.session_remaining_usd < 100, 'budget should have been debited');

  section('track_order (streaming progress notifications)');
  const progressEvents = [];
  const tracked = parse(
    await client.callTool(
      { name: 'track_order', arguments: { merchant_url: merchant.base_url, order_id: bought.order_id, poll_interval_ms: 30 } },
      undefined,
      {
        onprogress: (p) => {
          progressEvents.push(p);
          log(`  >> progress ${p.progress}: ${p.message}`);
        },
      },
    ),
  );
  log('\nfinal summary:', JSON.stringify(tracked, null, 2));

  // --- assertions on the signature feature: streamed fulfillment + shots ---
  assert.ok(progressEvents.length >= 4, `expected >=4 streamed progress notifications, got ${progressEvents.length}`);
  const withShots = progressEvents.filter((p) => typeof p.message === 'string' && p.message.includes('screenshot:'));
  assert.ok(withShots.length >= 2, `expected >=2 progress notifications carrying screenshots, got ${withShots.length}`);
  assert.equal(tracked.final, true, 'order should reach a final state');
  assert.equal(tracked.outcome, 'success');
  assert.ok(tracked.screenshots.length >= 2, 'final summary should list screenshots');
  assert.equal(tracked.streamed_as_progress, true);

  section('RESULT');
  log(`PASS — ${progressEvents.length} progress notifications streamed (${withShots.length} with screenshots).`);
  log(`Screenshots seen: ${tracked.screenshots.join(', ')}`);

  await client.close();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nSMOKE FAILED:', err);
  try {
    await client.close();
  } catch {}
  process.exit(1);
});
