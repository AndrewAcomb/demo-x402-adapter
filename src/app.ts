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

import { getProduct, listProducts } from './catalog.js';
import { PurchaseBody, type OrderResponse } from './schemas.js';
import { enqueueFulfillment, getFulfillment } from './fulfillment.js';

const NETWORK = (process.env.X402_NETWORK ?? 'eip155:84532') as Network;
const PAY_TO = process.env.X402_PAY_TO as `0x${string}` | undefined;
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator';

if (!PAY_TO || !PAY_TO.startsWith('0x')) {
  throw new Error(
    'X402_PAY_TO is required and must be an EVM address (0x...). ' +
      'Set it as a Vercel env var, or copy .env.example → .env for local dev.',
  );
}

// --- x402 wiring -----------------------------------------------------------

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new ExactEvmScheme(),
);

const DEMO_PRICE = '$0.10';

// --- App -------------------------------------------------------------------

const app = new Hono();

app.get('/health', (c) =>
  c.json({ ok: true, network: NETWORK, facilitator: FACILITATOR_URL, pay_to: PAY_TO }),
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
