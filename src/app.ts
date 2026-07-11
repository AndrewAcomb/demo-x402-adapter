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
        description: 'Buy a product from the vitamins adapter and queue it for fulfillment.',
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
