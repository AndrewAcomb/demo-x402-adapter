/**
 * In-process fake x402 merchant, used when MOCK_MERCHANT=1.
 *
 * It is a drop-in replacement for `globalThis.fetch` that intercepts EVERY
 * request (host is ignored) and answers with the same wire shapes the real
 * BuyWith402 adapter uses:
 *
 *   GET  /                       -> agent-readable guide (name, tags, payment)
 *   GET  /products               -> { pricing_note, products: [...] }
 *   GET  /products/:id           -> one product
 *   POST /products/:id/purchase  -> 402 x402 challenge, or 200 order when an
 *                                   X-PAYMENT header is present (payment made)
 *   GET  /orders/:id?since=N     -> canned 8-event fulfillment stream with
 *                                   placeholder checkout screenshots
 *
 * The whole point: `buy` + `track_order` run end-to-end with zero network.
 */

const NETWORK = (process.env.X402_NETWORK ?? 'eip155:84532').trim();
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia USDC
const PAY_TO = '0x000000000000000000000000000000000000dEaD';

interface MockProduct {
  id: string;
  name: string;
  description: string;
  price_usd: string;
  merchant_price_usd?: string;
  tags?: string[];
}

const PRODUCTS: MockProduct[] = [
  {
    id: 'mcmaster:92224A100',
    name: 'Steel Pan Head Phillips Screw 2-56 x 1/8 inch (pack of 100)',
    description: 'Black-Oxide Steel, 2-56 thread, fully threaded. McMaster-Carr part 92224A100.',
    price_usd: '$35.09',
    merchant_price_usd: '$13.39',
  },
  {
    id: 'mcmaster:92224A111',
    name: 'Steel Pan Head Phillips Screw 4-40 x 3/16 inch (pack of 100)',
    description: 'Black-Oxide Steel, 4-40 thread, fully threaded. McMaster-Carr part 92224A111.',
    price_usd: '$23.23',
    merchant_price_usd: '$5.49',
  },
  {
    id: 'test-item',
    name: 'Test Item (integration test, no fulfillment)',
    description: 'A ten-cent item for testing the x402 purchase flow end to end.',
    price_usd: '$0.10',
  },
];

function priceToAtomic(price: string): string {
  const dollars = Number(price.replace(/[^0-9.]/g, ''));
  return String(Math.round(dollars * 1e6));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function guide() {
  return {
    name: 'BuyWith402',
    description:
      'Buy real physical products (currently McMaster-Carr hardware) with one x402 USDC payment on Base. ' +
      'No account needed — the payment is the identity. Prices are all-inclusive (US shipping + tax).',
    tags: ['commerce', 'shopping', 'physical', 'hardware', 'marketplace'],
    payment: { protocol: 'x402', x402_version: 2, scheme: 'exact', network: NETWORK, currency: 'USDC' },
  };
}

function challenge(product: MockProduct) {
  return {
    x402Version: 2,
    error: 'payment_required',
    resource: {
      resource: `/products/${product.id}/purchase`,
      description: `BuyWith402: buy ${product.name} with one x402 USDC payment.`,
      serviceName: 'BuyWith402',
    },
    accepts: [
      {
        scheme: 'exact',
        network: NETWORK,
        asset: USDC,
        amount: priceToAtomic(product.price_usd),
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: 'USDC', decimals: 6 },
      },
    ],
  };
}

// A canned fulfillment run: 8 events, a few carrying checkout screenshots of
// the browser agent working the merchant site.
const SHOT = 'https://buywith402.com/demo/shots';
function fulfillmentEvents(orderId: string, productId: string) {
  return [
    { stage: 'queued', message: `Order ${orderId} queued for fulfillment.` },
    { stage: 'launching', message: 'Launching H Company browser agent.' },
    { stage: 'navigating', message: `Opening merchant product page for ${productId}.`, screenshot_url: `${SHOT}/01-product.png` },
    { stage: 'cart', message: 'Added item to cart; proceeding to checkout.', screenshot_url: `${SHOT}/02-cart.png` },
    { stage: 'shipping', message: 'Entering shipping address on merchant checkout.' },
    { stage: 'review', message: 'Reached merchant order-review screen.', screenshot_url: `${SHOT}/03-review.png` },
    { stage: 'placing', message: 'Placing the order with the merchant.' },
    { stage: 'placed', message: 'Order placed. Merchant confirmation received.', screenshot_url: `${SHOT}/04-confirmation.png` },
  ];
}

const TOTAL_EVENTS = 8;

export const mockFetch: typeof globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.toString());
  const path = url.pathname.replace(/\/$/, '') || '/';
  const method = (init?.method ?? 'GET').toUpperCase();

  // GET /
  if (path === '/' && method === 'GET') return Promise.resolve(json(guide()));

  // GET /health
  if (path === '/health' && method === 'GET') {
    return Promise.resolve(json({ ok: true, network: NETWORK, mock: true }));
  }

  // GET /products
  if (path === '/products' && method === 'GET') {
    return Promise.resolve(
      json({
        pricing_note: 'All prices are all-inclusive: US shipping and tax are included.',
        products: PRODUCTS,
      }),
    );
  }

  // POST /products/:id/purchase
  const purchase = path.match(/^\/products\/(.+)\/purchase$/);
  if (purchase && method === 'POST') {
    const product = PRODUCTS.find((p) => p.id === decodeURIComponent(purchase[1]));
    if (!product) return Promise.resolve(json({ error: 'not_found' }, 404));

    const headers = new Headers(init?.headers);
    const paid = headers.has('x-payment') || headers.has('X-Payment');
    if (!paid) {
      // Emit the x402 challenge in the body (like the real adapter's shim).
      return Promise.resolve(json(challenge(product), 402));
    }
    const orderId = `mock-${Math.random().toString(16).slice(2, 10)}`;
    return Promise.resolve(
      json({
        order_id: orderId,
        product_id: product.id,
        quantity: 1,
        dry_run: false,
        status: 'queued',
        message: `Payment received. Fulfillment queued for ${product.name}.`,
      }),
    );
  }

  // GET /products/:id
  const one = path.match(/^\/products\/([^/]+)$/);
  if (one && method === 'GET') {
    const product = PRODUCTS.find((p) => p.id === decodeURIComponent(one[1]));
    return Promise.resolve(product ? json(product) : json({ error: 'not_found' }, 404));
  }

  // GET /orders/:id?since=N  — reveal 2 more events per poll (deterministic).
  const order = path.match(/^\/orders\/([^/]+)$/);
  if (order && method === 'GET') {
    const orderId = decodeURIComponent(order[1]);
    const productId = 'mcmaster:92224A100';
    const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
    const visible = Math.min(TOTAL_EVENTS, since + 2);
    const all = fulfillmentEvents(orderId, productId);
    const events = all.slice(since, visible).map((e, i) => ({
      seq: since + i,
      t: new Date().toISOString(),
      ...e,
    }));
    const final = visible >= TOTAL_EVENTS;
    return Promise.resolve(
      json({
        order_id: orderId,
        product_id: productId,
        quantity: 1,
        dry_run: false,
        status: final ? 'placed' : 'running',
        final,
        outcome: final ? 'success' : undefined,
        events,
        next_since: visible,
      }),
    );
  }

  return Promise.resolve(json({ error: 'not_found', hint: 'mock merchant' }, 404));
};
