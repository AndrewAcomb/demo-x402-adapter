/**
 * Built-in fake BuyWith402 merchant for offline demos (MOCK_MERCHANT=1).
 *
 * Mirrors the real API surface exactly:
 *   GET  /products
 *   POST /products/:id/purchase  -> 402 challenge, then order on "payment"
 *   GET  /orders/:orderId?since=N
 *
 * The 402 challenge is shape-compatible with x402 v2 (header + body); any
 * X-PAYMENT header is accepted, so a mock-pay client can "settle" with a
 * placeholder and a real x402 client at least gets a well-formed challenge.
 * Fulfillment is a canned 8-event run with embedded-SVG screenshots.
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { OrderEvent, Product } from './types.js';
import { SCREEN_CART_CLEARED, SCREEN_ORDER_REVIEW, SCREEN_PRODUCT_IN_CART } from './mockScreens.js';

export const MOCK_PRODUCTS: Product[] = [
  {
    id: 'mcmaster:92224A112',
    name: 'Steel Pan Head Phillips Screw 4-40 x 1/4 inch (pack of 100)',
    description:
      'Steel Pan Head Phillips Screw, 4-40 thread, 1/4 inch length, Black-Oxide Steel, ' +
      'Fully Threaded Package of 100. McMaster-Carr part 92224A112.',
    price_usd: '$23.04',
    merchant_price_usd: '$5.36',
  },
  {
    id: 'mcmaster:92224A111',
    name: 'Steel Pan Head Phillips Screw 4-40 x 3/16 inch (pack of 100)',
    description:
      'Steel Pan Head Phillips Screw, 4-40 thread, 3/16 inch length, Black-Oxide Steel, ' +
      'Fully Threaded Package of 100. McMaster-Carr part 92224A111.',
    price_usd: '$23.23',
    merchant_price_usd: '$5.49',
  },
  {
    id: 'mcmaster:92224A102',
    name: 'Steel Pan Head Phillips Screw 2-56 x 1/4 inch (pack of 100)',
    description:
      'Steel Pan Head Phillips Screw, 2-56 thread, 1/4 inch length, Black-Oxide Steel, ' +
      'Fully Threaded Package of 100. McMaster-Carr part 92224A102.',
    price_usd: '$30.18',
    merchant_price_usd: '$10.12',
  },
  {
    id: 'test-item',
    name: 'Test Item (integration test, no fulfillment)',
    description: 'A ten-cent item for testing the x402 purchase flow end to end.',
    price_usd: '$0.10',
  },
];

interface MockOrder {
  order_id: string;
  product_id: string;
  quantity: number;
  dry_run: boolean;
  status: string;
  created_at: string;
  updated_at: string;
  events: OrderEvent[];
}

const FINAL_STATUSES = new Set(['ready_to_place', 'placed', 'failed']);

/** Canned fulfillment script: [stage, message, screenshot?][] */
function cannedRun(product: Product, dryRun: boolean): Array<[string, string, string?]> {
  const part = product.id.split(':')[1] ?? product.id;
  return [
    ['worker', `Fulfillment started for ${product.name} (${dryRun ? 'dry run — stops at order review' : 'REAL ORDER'}).`],
    ['agent', 'started'],
    ['live_view', 'Watch the agent live: https://live.example.invalid/session/mock'],
    ['checkpoint', 'cart-cleared', SCREEN_CART_CLEARED],
    ['agent', `navigate: opening product page for part ${part}`],
    ['checkpoint', 'product-in-cart', SCREEN_PRODUCT_IN_CART],
    ['agent', 'checkout: filling shipping address and reviewing totals'],
    ['checkpoint', 'place-order-review', SCREEN_ORDER_REVIEW],
  ];
}

export function createMockMerchant(opts: { network: string; eventIntervalMs: number }) {
  const app = new Hono();
  const orders = new Map<string, MockOrder>();

  const pushEvent = (order: MockOrder, stage: string, message: string, screenshot?: string) => {
    const event: OrderEvent = {
      seq: order.events.length,
      t: new Date().toISOString(),
      stage,
      message,
      ...(screenshot ? { screenshot_url: screenshot } : {}),
    };
    order.events.push(event);
    order.updated_at = event.t;
  };

  const runFulfillment = (order: MockOrder, product: Product) => {
    order.status = 'running';
    const script = cannedRun(product, order.dry_run);
    let i = 0;
    const tick = () => {
      if (i < script.length) {
        const [stage, message, screenshot] = script[i++];
        pushEvent(order, stage, message, screenshot);
        setTimeout(tick, opts.eventIntervalMs);
      } else {
        order.status = order.dry_run ? 'ready_to_place' : 'placed';
        pushEvent(order, 'worker', `Fulfillment finished: ${order.status}.`);
      }
    };
    setTimeout(tick, opts.eventIntervalMs);
  };

  app.get('/products', (c) =>
    c.json({
      pricing_note: 'Mock merchant — no real charges, no real shipments.',
      products: MOCK_PRODUCTS,
    }),
  );

  app.get('/products/:id', (c) => {
    const product = MOCK_PRODUCTS.find((p) => p.id === c.req.param('id'));
    return product ? c.json(product) : c.json({ error: 'not_found' }, 404);
  });

  app.post('/products/:id/purchase', async (c) => {
    const product = MOCK_PRODUCTS.find((p) => p.id === c.req.param('id'));
    if (!product) return c.json({ error: 'not_found' }, 404);

    // x402-shaped challenge when unpaid; accept any X-PAYMENT value.
    if (!c.req.header('x-payment')) {
      const amountAtomic = String(Math.round(parseFloat(product.price_usd.replace('$', '')) * 1e6));
      const challenge = {
        x402Version: 2,
        error: 'payment_required',
        accepts: [
          {
            scheme: 'exact',
            network: opts.network,
            maxAmountRequired: amountAtomic,
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC (Base Sepolia)
            payTo: '0x000000000000000000000000000000000000dEaD',
            resource: c.req.url,
            description: `Mock purchase of ${product.name}`,
            maxTimeoutSeconds: 300,
            extra: { name: 'USDC', version: '2' },
          },
        ],
      };
      c.header('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
      return c.json(challenge, 402);
    }

    const body = await c.req.json().catch(() => ({}));
    const order: MockOrder = {
      order_id: randomUUID(),
      product_id: product.id,
      quantity: Number(body.quantity ?? 1),
      dry_run: body.dry_run !== false,
      status: 'queued',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      events: [],
    };
    orders.set(order.order_id, order);
    runFulfillment(order, product);

    return c.json({
      order_id: order.order_id,
      product_id: product.id,
      quantity: order.quantity,
      dry_run: order.dry_run,
      status: 'queued',
      message: `Payment received (mock). Fulfillment queued for ${product.name}.`,
    });
  });

  app.get('/orders/:orderId', (c) => {
    const order = orders.get(c.req.param('orderId'));
    if (!order) return c.json({ error: 'not_found' }, 404);
    const since = Math.max(0, Number(c.req.query('since') ?? 0) || 0);
    const events = order.events.slice(since);
    const final = FINAL_STATUSES.has(order.status);
    return c.json({
      order_id: order.order_id,
      product_id: order.product_id,
      quantity: order.quantity,
      dry_run: order.dry_run,
      status: order.status,
      final,
      outcome: final ? (order.status === 'failed' ? 'failure' : 'success') : undefined,
      created_at: order.created_at,
      updated_at: order.updated_at,
      events,
      next_since: since + events.length,
    });
  });

  return app;
}
