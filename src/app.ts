/**
 * Hono app definition — shared by local dev (src/server.ts) and
 * Vercel serverless (api/index.ts).
 *
 * Keep this file free of any runtime-specific concerns (no `serve()`
 * from `@hono/node-server`, no Vercel handle wrapping). The two
 * entrypoints handle their own wiring.
 */

import { Hono } from 'hono';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import type { Network } from '@x402/core/types';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { createFacilitatorConfig } from '@coinbase/x402';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

import { getProduct, listProducts } from './catalog.js';
import { PurchaseBody, type OrderResponse } from './schemas.js';
import { enqueueFulfillment, getFulfillment } from './fulfillment.js';

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

// Flat demo price for every SKU. Overridable via env for testing.
const DEMO_PRICE = process.env.X402_PRICE ?? '$0.10';

// --- App -------------------------------------------------------------------

const app = new Hono();

app.get('/health', (c) =>
  c.json({ ok: true, network: NETWORK, facilitator: EFFECTIVE_FACILITATOR_URL, pay_to: PAY_TO }),
);

app.get('/products', (c) => c.json({ products: listProducts() }));

app.get('/products/:id', (c) => {
  const product = getProduct(c.req.param('id'));
  if (!product) return c.json({ error: 'not_found' }, 404);
  const { source_url, ...safe } = product;
  return c.json(safe);
});

app.get('/orders/:orderId', (c) => {
  const intent = getFulfillment(c.req.param('orderId'));
  if (!intent) return c.json({ error: 'not_found' }, 404);
  return c.json({
    order_id: intent.order_id,
    product_id: intent.product.id,
    quantity: intent.body.quantity,
    status: 'processing' as const,
    created_at: intent.created_at,
  });
});

app.use(
  paymentMiddleware(
    {
      'POST /products/:id/purchase': {
        accepts: {
          scheme: 'exact',
          price: DEMO_PRICE,
          network: NETWORK,
          payTo: PAY_TO,
        },
        description:
          'BuyWith402 (buywith402.com): buy any product from the catalog with one x402 ' +
          'USDC payment and get an order id with queued fulfillment. Browse products free ' +
          'at GET /products; check status at GET /orders/{order_id}.',
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
              email: 'buyer@example.com',
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

app.post('/products/:id/purchase', async (c) => {
  const product = getProduct(c.req.param('id'));
  if (!product) return c.json({ error: 'not_found' }, 404);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = PurchaseBody.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  }

  const intent = enqueueFulfillment(product, parsed.data);
  const response: OrderResponse = {
    order_id: intent.order_id,
    product_id: product.id,
    quantity: parsed.data.quantity,
    status: 'queued',
    message: `Payment received. Fulfillment queued for ${product.name}.`,
  };
  return c.json(response, 200);
});

export default app;
export { NETWORK, PAY_TO, FACILITATOR_URL };
