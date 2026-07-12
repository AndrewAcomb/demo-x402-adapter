/**
 * Hono app definition — shared by local dev (src/server.ts) and
 * Vercel serverless (api/index.ts).
 *
 * Keep this file free of any runtime-specific concerns (no `serve()`
 * from `@hono/node-server`, no Vercel handle wrapping). The two
 * entrypoints handle their own wiring.
 */

import { Hono, type Context } from 'hono';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import type { Network } from '@x402/core/types';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { createFacilitatorConfig } from '@coinbase/x402';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

import { getMergedProduct, listMergedProducts } from './catalogStore.js';
import { OnboardMerchantBody, PurchaseBody, type OrderResponse } from './schemas.js';
import { enqueueFulfillment, getFulfillment } from './fulfillment.js';
import { FINAL_STATUSES, createOrder, getOrder, getOrderEvents, ordersConfigured } from './orders.js';
import {
  ONBOARD_FINAL_STATUSES,
  createOnboardJob,
  getOnboardEvents,
  getOnboardJob,
  listOnboardedMerchants,
} from './onboarding.js';

const NETWORK = (process.env.X402_NETWORK ?? 'eip155:84532') as Network;
const PAY_TO = process.env.X402_PAY_TO as `0x${string}` | undefined;
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator';
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET;

if (!PAY_TO || !PAY_TO.startsWith('0x')) {
  throw new Error(
    'X402_PAY_TO is required and must be an EVM address (0x...). ' +
      'Set it as a Vercel env var, or copy .env.example → .env for local dev.',
  );
}

// --- x402 wiring -----------------------------------------------------------

// Base mainnet (eip155:8453) can only be settled via Coinbase's CDP
// facilitator, which requires authenticated requests. When CDP credentials
// are present we build a facilitator config that signs each verify/settle
// call with the CDP API key. Otherwise we fall back to the plain
// URL-configured facilitator — the public x402.org one, which is testnet-only.
const facilitatorConfig =
  CDP_API_KEY_ID && CDP_API_KEY_SECRET
    ? createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET)
    : { url: FACILITATOR_URL };

const EFFECTIVE_FACILITATOR_URL = facilitatorConfig.url ?? FACILITATOR_URL;

const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme())
  .onVerifyFailure(async (ctx) => {
    console.error('[x402] verify failed:', ctx.error?.message);
  })
  .onSettleFailure(async (ctx) => {
    console.error('[x402] settle failed:', ctx.error?.message);
  });

// Fallback price when the product id can't be resolved from the path. A paid
// request for an unknown product 404s in the handler, which cancels the
// verified payment before settlement — so no money moves on the fallback.
const FALLBACK_PRICE = process.env.X402_PRICE ?? '$0.10';

/**
 * Per-product price resolved from the merged (static + dynamic) catalog at
 * challenge time. @x402/core awaits DynamicPrice functions, so the async
 * Redis-backed lookup is safe here. The same lookup runs again on the paid
 * retry; a payment whose amount no longer matches is rejected, and unknown
 * ids fall back to a price whose payment the handler cancels via 404.
 */
const priceForRequest = async (ctx: { path: string }) => {
  const match = ctx.path.match(/^\/products\/([^/]+)\/purchase$/);
  const product = match ? await getMergedProduct(decodeURIComponent(match[1])) : undefined;
  return product?.price_usd ?? FALLBACK_PRICE;
};

// --- App -------------------------------------------------------------------

const app = new Hono();

// Agent-friendly API guide at the root: crawlers and agents that probe the
// bare domain should find a machine-readable map, not a 404.
app.get('/', (c) =>
  c.json({
    name: 'BuyWith402',
    description:
      'Buy real physical products (currently McMaster-Carr hardware) with one x402 ' +
      'USDC payment on Base. No account needed — the payment is the identity. All ' +
      'prices are all-inclusive: US shipping and tax are included.',
    payment: {
      protocol: 'x402',
      x402_version: 2,
      scheme: 'exact',
      network: NETWORK,
      currency: 'USDC',
    },
    endpoints: [
      { method: 'GET', path: '/', description: 'This guide.' },
      { method: 'GET', path: '/health', description: 'Service status.' },
      {
        method: 'GET',
        path: '/products',
        description:
          'List all products (free). Optional ?query=<text> filters by case-insensitive ' +
          'substring across id, name, description, and merchant (e.g. ?query=cookie).',
      },
      { method: 'GET', path: '/products/{id}', description: 'One product (free).' },
      {
        method: 'POST',
        path: '/products/{id}/purchase',
        description:
          'Buy a product. Returns a 402 x402 challenge; retry with payment to receive ' +
          'an order_id. Body: { quantity?, email?, shipping: { name, address_1, ' +
          'address_2?, city, state, zip, country? }, gift_note?, dry_run? }. ' +
          'email is optional and used for order records only — it is NOT entered at ' +
          'the merchant; omit it unless you want it on file.',
      },
      {
        method: 'GET',
        path: '/orders/{order_id}',
        description:
          'Order status + live fulfillment progress events (free). Poll with ' +
          '?since=<next_since> for incremental updates, including screenshots of the ' +
          'agent checking out on the underlying merchant. Keep polling while ' +
          'final=false (statuses: queued, running, retrying — transient attempt ' +
          'failures retry automatically). When final=true, outcome is "success" ' +
          '(status ready_to_place or placed) or "failure" (status failed, only after ' +
          'all retries are exhausted).',
      },
      {
        method: 'POST',
        path: '/merchants',
        description:
          'Merchant Factory: onboard any store URL as agent-buyable products. Paid ' +
          'endpoint ($5.00 x402 charge — you are funding the browser-agent run). A ' +
          'browser agent extracts a validated catalog, estimates tax/fulfillment ' +
          'economics, and its products go live in GET /products within minutes. Body: ' +
          '{ url, nickname?, display_name?, max_products? }. The response includes a ' +
          'poll URL — same live-events contract as orders.',
      },
    ],
    pricing:
      'Prices are all-inclusive and itemized per product: merchant item price + our ' +
      'service fee (10% + $0.25, service_fee_usd) + estimated tax + fulfillment cost.',
    dry_run:
      'Purchases are REAL by default: fulfillment places the merchant order and the ' +
      'product ships to your address. Send dry_run=true for a rehearsal that stops at ' +
      'the merchant order-review screen without placing the order.',
    how_to_buy: [
      'GET /products (?query=<text> to search) and pick a product id',
      'Nothing suitable? POST /merchants with any store URL ($5.00 x402) — a browser ' +
        'agent onboards its catalog in minutes, then buy from it',
      'POST /products/{id}/purchase with your shipping address — receive a 402 challenge',
      'Pay the challenge with any x402 client (exact scheme, USDC on Base)',
      'Poll GET /orders/{order_id} to watch fulfillment live',
    ],
  }),
);

app.get('/health', (c) =>
  c.json({ ok: true, network: NETWORK, facilitator: EFFECTIVE_FACILITATOR_URL, pay_to: PAY_TO }),
);

const PRICING_NOTE =
  'All prices are all-inclusive: the merchant item price, our service fee (10% of ' +
  'the item + $0.25, shown as service_fee_usd), estimated tax, and the item’s ' +
  'fulfillment cost (shipping or delivery; zero for pickup). The price shown is ' +
  'the full x402 charge. Each item’s fulfillment field says how it reaches you — ' +
  'fixed per item, not selectable at purchase.';

app.get('/products', async (c) => {
  let products = await listMergedProducts();
  const query = c.req.query('query')?.trim().toLowerCase();
  if (query) {
    const hit = (v: unknown) => typeof v === 'string' && v.toLowerCase().includes(query);
    products = products.filter(
      (p) =>
        hit(p.id) ||
        hit(p.name) ||
        hit(p.description) ||
        hit((p as { merchant?: string }).merchant),
    );
  }
  return c.json({
    pricing_note: PRICING_NOTE,
    query: query || undefined,
    products,
    not_finding_it:
      'Any web store can become products here: POST /merchants with { url } (x402-paid, ' +
      '$5.00) and a browser agent onboards its catalog within minutes — then buy from it.',
  });
});

app.get('/products/:id', async (c) => {
  const product = await getMergedProduct(c.req.param('id'));
  if (!product)
    return c.json(
      {
        error: 'not_found',
        hint:
          'Browse GET /products (?query=<text> to search). Missing merchandise can be ' +
          'onboarded: POST /merchants with { url } ($5.00 x402) adds any web store.',
      },
      404,
    );
  const { source_url, ...safe } = product;
  return c.json({ ...safe, pricing_note: PRICING_NOTE });
});

/**
 * Order status + live fulfillment progress. Poll-friendly: pass ?since=<seq>
 * to receive only events newer than the ones already seen. Free (never 402s)
 * so the buying agent can narrate the fulfillment run in real time.
 */
app.get('/orders/:orderId', async (c) => {
  const orderId = c.req.param('orderId');

  if (ordersConfigured) {
    const order = await getOrder(orderId);
    if (!order) return c.json({ error: 'not_found' }, 404);
    const since = Math.max(0, Number(c.req.query('since') ?? 0) || 0);
    const events = await getOrderEvents(orderId, since);
    const final = FINAL_STATUSES.has(order.status);
    return c.json({
      order_id: order.order_id,
      product_id: order.product_id,
      quantity: order.quantity,
      dry_run: order.dry_run,
      status: order.status,
      // Explicit success semantics so pollers never interpret status names:
      // keep polling while final=false; outcome is set once final=true.
      final,
      outcome: final ? (order.status === 'failed' ? 'failure' : 'success') : undefined,
      created_at: order.created_at,
      updated_at: order.updated_at,
      result: order.result,
      events,
      next_since: since + events.length,
    });
  }

  // Fallback when the store isn't configured: legacy in-memory lookup.
  const intent = getFulfillment(orderId);
  if (!intent) return c.json({ error: 'not_found' }, 404);
  return c.json({
    order_id: intent.order_id,
    product_id: intent.product.id,
    quantity: intent.body.quantity,
    status: 'queued' as const,
    created_at: intent.created_at,
  });
});

// --- Merchant Factory: onboard any store as x402 products ------------------

/**
 * Admin gate for onboarding. Returns an error Response when the request must
 * be rejected, undefined when it may proceed. 503 when the feature is not
 * configured at all, 401 on a bad key.
 */
const onboardingDenied = (c: Context) => {
  const expected = process.env.ONBOARD_ADMIN_KEY;
  if (!expected) {
    return c.json({ error: 'onboarding_disabled', message: 'ONBOARD_ADMIN_KEY is not set on the server.' }, 503);
  }
  if (c.req.header('x-admin-key') !== expected) {
    return c.json({ error: 'unauthorized', message: 'Missing or wrong X-Admin-Key header.' }, 401);
  }
  return undefined;
};

/**
 * Shared onboarding-job creation used by both the public paid route
 * (POST /merchants, behind the x402 middleware) and the undocumented free
 * admin bypass (POST /admin/merchants, X-Admin-Key).
 */
const handleOnboardRequest = async (c: Context) => {
  if (!ordersConfigured) {
    return c.json({ error: 'store_unavailable', message: 'Redis order store is not configured.' }, 503);
  }
  const raw = await c.req.json().catch(() => ({}));
  const parsed = OnboardMerchantBody.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  }
  try {
    const job = await createOnboardJob(parsed.data);
    return c.json(
      {
        job_id: job.job_id,
        status: job.status,
        url: job.url,
        poll: `/merchants/jobs/${job.job_id}`,
        message: 'Onboarding queued. Poll the job URL to watch the browser agent build the catalog.',
      },
      202,
    );
  } catch (e) {
    console.error('[onboard] job create failed:', (e as Error).message);
    return c.json({ error: 'store_unavailable', message: 'Could not queue the onboarding job.' }, 503);
  }
};

/** Undocumented free admin bypass; not matched by the payment middleware. */
app.post('/admin/merchants', async (c) => {
  const denied = onboardingDenied(c);
  if (denied) return denied;
  return handleOnboardRequest(c);
});

/**
 * Onboarding-job status + live progress events. Same poll contract as
 * GET /orders/{id}: pass ?since=<next_since>, keep polling while final=false.
 */
app.get('/merchants/jobs/:jobId', async (c) => {
  if (!ordersConfigured) return c.json({ error: 'not_found' }, 404);
  const jobId = c.req.param('jobId');
  const job = await getOnboardJob(jobId);
  if (!job) return c.json({ error: 'not_found' }, 404);
  const since = Math.max(0, Number(c.req.query('since') ?? 0) || 0);
  const events = await getOnboardEvents(jobId, since);
  const final = ONBOARD_FINAL_STATUSES.has(job.status);
  return c.json({
    job_id: job.job_id,
    url: job.url,
    status: job.status,
    final,
    outcome: final ? (job.status === 'failed' ? 'failure' : 'success') : undefined,
    created_at: job.created_at,
    updated_at: job.updated_at,
    result: job.result,
    events,
    next_since: since + events.length,
  });
});

/** Onboarded merchants with product counts (free). */
app.get('/merchants', async (c) => {
  if (!ordersConfigured) return c.json({ merchants: [] });
  try {
    return c.json({ merchants: await listOnboardedMerchants() });
  } catch (e) {
    console.error('[onboard] merchants list failed:', (e as Error).message);
    return c.json({ merchants: [] });
  }
});

// Client-compat shim: our payment middleware emits the 402 challenge only in
// the PAYMENT-REQUIRED header with an empty JSON body, but some official x402
// client wrappers (e.g. @x402/fetch) parse the challenge from the response
// BODY and silently retry unpaid when it's missing. Echo the decoded header
// challenge into the body so both styles of client can pay.
app.use(async (c, next) => {
  await next();
  if (c.res?.status !== 402) return;
  const header = c.res.headers.get('payment-required');
  if (!header) return;
  try {
    const body = await c.res.clone().text();
    if (body && body !== '{}') return; // body already populated
    const challenge = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const headers = new Headers(c.res.headers);
    headers.delete('content-length');
    c.res = new Response(JSON.stringify(challenge), { status: 402, headers });
  } catch {
    // Never break the challenge over a body nicety.
  }
});

const ONBOARDING_PRICE = process.env.X402_ONBOARDING_PRICE ?? '$5.00';

app.use(
  paymentMiddleware(
    {
      'POST /merchants': {
        accepts: {
          scheme: 'exact',
          price: ONBOARDING_PRICE,
          network: NETWORK,
          payTo: PAY_TO,
        },
        description:
          'Onboard any store URL as live, agent-buyable products. Pay once; a browser ' +
          'agent reads the store, estimates its economics, and publishes an itemized ' +
          'catalog within minutes. Body: { url, nickname?, display_name?, max_products? }.',
        serviceName: 'BuyWith402',
      },
      'POST /products/:id/purchase': {
        accepts: {
          scheme: 'exact',
          price: priceForRequest,
          network: NETWORK,
          payTo: PAY_TO,
        },
        description:
          'BuyWith402 (buywith402.com): buy any product from the catalog with one x402 ' +
          'USDC payment and get an order id with queued fulfillment. Prices are ' +
          'all-inclusive (US shipping and tax included). Browse products free at ' +
          'GET /products (?query=<text> to search); check status at ' +
          'GET /orders/{order_id}. Missing merchandise? POST /merchants with any store ' +
          'URL ($5.00 x402) onboards its catalog within minutes.',
        serviceName: 'BuyWith402',
        // Max 5 tags (32 chars each) — extras are dropped by sanitizeTags.
        tags: ['commerce', 'shopping', 'physical', 'hardware', 'marketplace'],
        // Opt in to x402 Bazaar discovery: tells agents how to call this
        // endpoint (body shape mirrors PurchaseBody in schemas.ts). Browse
        // free endpoints: GET /products lists ids, GET /orders/:id status.
        // NOTE: declareDiscoveryExtension already returns `{ bazaar: ... }`.
        extensions: {
          ...declareDiscoveryExtension({
            bodyType: 'json',
            input: {
              quantity: 1,
              shipping: {
                name: 'Jane Doe',
                address_1: '123 Main St',
                city: 'San Francisco',
                state: 'CA',
                zip: '94114',
                country: 'US',
              },
            },
            inputSchema: {
              properties: {
                quantity: { type: 'integer', minimum: 1, maximum: 12 },
                email: { type: 'string' },
                shipping: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    address_1: { type: 'string' },
                    address_2: { type: 'string' },
                    city: { type: 'string' },
                    state: { type: 'string' },
                    zip: { type: 'string' },
                    country: { type: 'string' },
                  },
                  required: ['name', 'address_1', 'city', 'state', 'zip'],
                },
                gift_note: { type: 'string' },
              },
              required: ['shipping'],
            },
            output: {
              example: {
                order_id: '5461d889-dac7-456b-846f-3332a2929104',
                product_id: 'example-product-id',
                quantity: 1,
                status: 'queued',
                message: 'Payment received. Fulfillment queued.',
              },
            },
          }),
        },
      },
    },
    resourceServer,
  ),
);

/** Public paid onboarding: settlement runs before this handler executes. */
app.post('/merchants', handleOnboardRequest);

app.post('/products/:id/purchase', async (c) => {
  // Merged lookup (static wins). If a dynamic product vanished from Redis or
  // the cache since the challenge was issued, this 404 cancels the verified
  // payment before settlement — we never settle against a price we can no
  // longer prove.
  const product = await getMergedProduct(c.req.param('id'));
  if (!product) return c.json({ error: 'not_found' }, 404);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = PurchaseBody.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  }

  const intent = enqueueFulfillment(product, parsed.data);

  // Durable order + fulfillment-queue entry for the python worker. If the
  // store write fails after payment settled, surface a queued-but-degraded
  // message rather than failing the paid request.
  let queued = false;
  if (ordersConfigured) {
    try {
      await createOrder(intent.order_id, product, parsed.data);
      queued = true;
    } catch (e) {
      console.error('[orders] store write failed:', (e as Error).message);
    }
  }

  const mode = parsed.data.dry_run
    ? 'Dry run: fulfillment will stop at the merchant order-review screen.'
    : 'Live order: fulfillment will place the merchant order.';
  const response: OrderResponse = {
    order_id: intent.order_id,
    product_id: product.id,
    quantity: parsed.data.quantity,
    dry_run: parsed.data.dry_run,
    status: 'queued',
    message:
      `Payment received. Fulfillment queued for ${product.name}. ${mode} ` +
      (queued
        ? `Poll GET /orders/${intent.order_id} for live progress.`
        : 'Live progress tracking is temporarily unavailable.'),
  };
  return c.json(response, 200);
});

// Point lost agents at the guide instead of a bare 404.
app.notFound((c) => c.json({ error: 'not_found', hint: 'GET / for the API guide' }, 404));

export default app;
export { NETWORK, PAY_TO, FACILITATOR_URL };
