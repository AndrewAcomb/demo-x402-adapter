/**
 * x402 Shopper — a local stdio MCP server that acts as a USDC wallet for any
 * MCP agent (Claude Code, Cursor, Codex, ...).
 *
 * What makes it different from the other x402 MCP wallets:
 *   1. `buy` is DRY-RUN BY DEFAULT — it previews the exact charge and only
 *      spends on explicit confirm + within caps + ALLOW_REAL_PURCHASE=1.
 *   2. `track_order` STREAMS live fulfillment events (including checkout
 *      screenshots) back to the agent over MCP progress notifications, so the
 *      agent watches the merchant checkout happen in its own context.
 *
 * The wallet key stays on this machine. The only thing on the wire between the
 * agent's wallet and the merchant is HTTP 402.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { config, budget, spendDecision } from './config.js';
import { payFetch, plainFetch } from './http.js';
import { fetchGuide, fetchProducts, readChallenge, parseUsd } from './merchant.js';

const shippingShape = {
  name: z.string().describe("Recipient full name, e.g. 'Jane Doe'."),
  address_1: z.string().describe('Street address line 1.'),
  address_2: z.string().optional().describe('Street address line 2 (optional).'),
  city: z.string(),
  state: z.string().length(2).describe('Two-letter state code, e.g. CA.'),
  zip: z.string(),
  country: z.string().length(2).default('US').describe('Two-letter country code.'),
};
const shippingSchema = z.object(shippingShape);
type Shipping = z.infer<typeof shippingSchema>;

const SAMPLE_SHIPPING: Shipping = {
  name: 'Jane Doe',
  address_1: '123 Main St',
  city: 'San Francisco',
  state: 'CA',
  zip: '94114',
  country: 'US',
};

function text(obj: unknown) {
  return { content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}
function errorText(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

const server = new McpServer({ name: 'x402-shopper', version: '0.1.0' });

// --- wallet_status ---------------------------------------------------------

server.registerTool(
  'wallet_status',
  {
    title: 'Wallet status',
    description:
      'Show the wallet the agent is spending from: its public address (the private key never leaves this machine and is never returned), the network, the per-purchase cap, and how much of the per-session budget remains. Call this first to see your spending limits.',
    inputSchema: {},
  },
  async () => {
    return text({
      address: config.walletAddress ?? '(no key configured — running in mock/preview mode)',
      network: config.network,
      mode: {
        mock_merchant: config.mockMerchant,
        mock_pay: config.mockPay,
        real_purchases_enabled: config.allowRealPurchase,
      },
      max_spend_usd: config.maxSpendUsd,
      session_budget_usd: config.sessionBudgetUsd,
      session_spent_usd: Number(budget.spent().toFixed(4)),
      session_remaining_usd: Number(budget.remaining().toFixed(4)),
      note: 'buy is dry-run by default; real spend requires confirm=true, within caps, and ALLOW_REAL_PURCHASE=1.',
    });
  },
);

// --- discover_merchants ----------------------------------------------------

server.registerTool(
  'discover_merchants',
  {
    title: 'Discover x402 merchants',
    description:
      'List x402-enabled merchants the wallet knows about (from MERCHANT_URLS, default https://buywith402.com — our own x402 Bazaar listing). For each merchant returns its name, base URL, tags, description, and a few sample products. Optionally filter by a free-text query or a tag.',
    inputSchema: {
      query: z.string().optional().describe('Free-text filter matched against merchant name, description, tags, and product names.'),
      tag: z.string().optional().describe("Only return merchants advertising this tag, e.g. 'hardware'."),
    },
  },
  async ({ query, tag }) => {
    const q = query?.toLowerCase().trim();
    const results = [];
    for (const url of config.merchantUrls) {
      try {
        const guide = await fetchGuide(url);
        let products = await fetchProducts(url).catch(() => []);
        const sample = products.slice(0, 3);
        if (tag && !guide.tags.map((t) => t.toLowerCase()).includes(tag.toLowerCase())) continue;
        if (q) {
          const hay = [guide.name, guide.description ?? '', guide.tags.join(' '), products.map((p) => p.name).join(' ')]
            .join(' ')
            .toLowerCase();
          if (!hay.includes(q)) continue;
        }
        results.push({
          name: guide.name,
          base_url: guide.base_url,
          tags: guide.tags,
          description: guide.description,
          payment: guide.payment,
          sample_products: sample,
          product_count: products.length,
        });
      } catch (e) {
        results.push({ base_url: url, error: `Could not reach merchant: ${(e as Error).message}` });
      }
    }
    return text({ merchants: results, count: results.length });
  },
);

// --- list_products ---------------------------------------------------------

server.registerTool(
  'list_products',
  {
    title: 'List products',
    description:
      "Browse a merchant's catalog for free (GET /products). Returns each product's id, name, the x402 price you'd pay in USD, and — when the merchant discloses it — the underlying merchant price so you can comparison-shop.",
    inputSchema: {
      merchant_url: z.string().describe('Merchant base URL, e.g. https://buywith402.com'),
    },
  },
  async ({ merchant_url }) => {
    try {
      const products = await fetchProducts(merchant_url);
      return text({ merchant_url: merchant_url.replace(/\/$/, ''), count: products.length, products });
    } catch (e) {
      return errorText((e as Error).message);
    }
  },
);

// --- inspect_purchase ------------------------------------------------------

server.registerTool(
  'inspect_purchase',
  {
    title: 'Inspect a purchase (no payment)',
    description:
      'Preview what a purchase would cost by POSTing the purchase and reading the HTTP 402 x402 challenge WITHOUT paying. Returns the exact amount, asset, network, and pay-to address that a real buy would settle. This never spends.',
    inputSchema: {
      merchant_url: z.string().describe('Merchant base URL.'),
      product_id: z.string().describe('Product id from list_products.'),
      shipping: shippingSchema.partial().optional().describe('Optional shipping details; a sample is used if omitted.'),
    },
  },
  async ({ merchant_url, product_id, shipping }) => {
    try {
      const body = { quantity: 1, shipping: { ...SAMPLE_SHIPPING, ...(shipping ?? {}) } };
      const quote = await readChallenge(merchant_url, product_id, body);
      return text({
        merchant_url: merchant_url.replace(/\/$/, ''),
        product_id,
        would_charge_usd: Number(quote.price_usd.toFixed(6)),
        asset: quote.asset,
        network: quote.network,
        pay_to: quote.pay_to,
        scheme: quote.scheme,
        spends_now: false,
        within_max_spend: quote.price_usd <= config.maxSpendUsd,
      });
    } catch (e) {
      return errorText((e as Error).message);
    }
  },
);

// --- buy -------------------------------------------------------------------

server.registerTool(
  'buy',
  {
    title: 'Buy a product (dry-run by default)',
    description:
      'Purchase a product with USDC over x402. SAFE BY DEFAULT: unless you pass confirm=true — and the charge is within MAX_SPEND_USD, the session budget has room, and the server has ALLOW_REAL_PURCHASE=1 — this only PREVIEWS the buy and returns the exact arguments to re-call with to actually spend. On a real buy it pays the 402 challenge and returns the order_id (track it with track_order).',
    inputSchema: {
      merchant_url: z.string().describe('Merchant base URL.'),
      product_id: z.string().describe('Product id to buy.'),
      shipping: shippingSchema.describe('Where to ship the physical goods.'),
      quantity: z.number().int().min(1).max(12).default(1),
      confirm: z.boolean().default(false).describe('Must be true to actually spend. Defaults to false (preview only).'),
    },
  },
  async ({ merchant_url, product_id, shipping, quantity, confirm }) => {
    const b = merchant_url.replace(/\/$/, '');
    const body = { quantity, shipping, dry_run: false };

    // Authoritative price: read the live 402 challenge (no payment).
    let estUsd: number;
    let quoteExtra: Record<string, unknown> = {};
    try {
      const quote = await readChallenge(merchant_url, product_id, body);
      estUsd = quote.price_usd;
      quoteExtra = { asset: quote.asset, network: quote.network, pay_to: quote.pay_to };
    } catch (e) {
      // Fall back to catalog price if the challenge could not be read.
      const products = await fetchProducts(merchant_url).catch(() => []);
      const p = products.find((x) => x.id === product_id);
      if (!p || p.price_usd === undefined) return errorText(`Could not price ${product_id}: ${(e as Error).message}`);
      estUsd = p.price_usd;
    }

    const decision = spendDecision(estUsd, confirm);
    if (!decision.ok) {
      return text({
        mode: 'dry_run',
        spent: false,
        reason: decision.reason,
        quote: {
          merchant_url: b,
          product_id,
          quantity,
          estimated_charge_usd: Number(estUsd.toFixed(6)),
          ...quoteExtra,
        },
        budget: {
          max_spend_usd: config.maxSpendUsd,
          session_remaining_usd: Number(budget.remaining().toFixed(4)),
          real_purchases_enabled: config.allowRealPurchase,
        },
        to_confirm: {
          tool: 'buy',
          arguments: { merchant_url: b, product_id, shipping, quantity, confirm: true },
          note: 'Re-call buy with these arguments to actually spend (requires ALLOW_REAL_PURCHASE=1 on the server).',
        },
      });
    }

    // Real (or mock-pay) settlement.
    try {
      const pf = payFetch();
      const res = await pf(`${b}/products/${encodeURIComponent(product_id)}/purchase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || !data.order_id) {
        return errorText(`Purchase failed: HTTP ${res.status}. ${JSON.stringify(data).slice(0, 300)}`);
      }
      budget.commit(estUsd);
      return text({
        mode: 'purchased',
        spent: true,
        order_id: data.order_id,
        merchant_url: b,
        product_id,
        quantity,
        charged_usd: Number(estUsd.toFixed(6)),
        settlement: config.mockPay ? 'mock-pay (no real settlement)' : 'x402 exact / USDC',
        session_remaining_usd: Number(budget.remaining().toFixed(4)),
        next_step: { tool: 'track_order', arguments: { merchant_url: b, order_id: data.order_id } },
        message: `Payment settled. Order ${data.order_id} placed. Call track_order to watch fulfillment live.`,
      });
    } catch (e) {
      // Never surface anything that could embed the key.
      return errorText(`Purchase failed during settlement: ${(e as Error).message}`);
    }
  },
);

// --- track_order (streaming) -----------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function formatEvent(e: Record<string, unknown>): string {
  const seq = typeof e.seq === 'number' ? `#${e.seq} ` : '';
  const stage = e.stage ? `[${e.stage}] ` : '';
  const shot = e.screenshot_url ? ` — screenshot: ${e.screenshot_url}` : '';
  return `${seq}${stage}${e.message ?? ''}${shot}`;
}

server.registerTool(
  'track_order',
  {
    title: 'Track an order (live stream)',
    description:
      "Follow an order's fulfillment in real time. Polls the merchant's free order endpoint and STREAMS each new event — including screenshots of the browser agent checking out on the underlying merchant — back to you as MCP progress notifications. Returns a final summary with the full event log and the success/failure outcome.",
    inputSchema: {
      merchant_url: z.string().describe('Merchant base URL.'),
      order_id: z.string().describe('order_id returned by buy.'),
      poll_interval_ms: z.number().int().min(0).max(10000).default(150).describe('Delay between polls.'),
    },
  },
  async ({ merchant_url, order_id, poll_interval_ms }, extra) => {
    const b = merchant_url.replace(/\/$/, '');
    const progressToken = extra._meta?.progressToken;
    const collected: Array<Record<string, unknown>> = [];
    const screenshots: string[] = [];
    let cursor = 0;
    let final = false;
    let outcome: string | undefined;
    let lastStatus: string | undefined;

    for (let poll = 0; poll < 60 && !final; poll++) {
      let res: Response;
      try {
        res = await plainFetch(`${b}/orders/${encodeURIComponent(order_id)}?since=${cursor}`);
      } catch (e) {
        return errorText(`track_order failed: ${(e as Error).message}`);
      }
      if (!res.ok) return errorText(`GET /orders/${order_id} returned HTTP ${res.status}`);
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const events = Array.isArray(data.events) ? (data.events as Array<Record<string, unknown>>) : [];
      lastStatus = typeof data.status === 'string' ? data.status : lastStatus;

      for (const e of events) {
        collected.push(e);
        if (typeof e.screenshot_url === 'string') screenshots.push(e.screenshot_url);
        const line = formatEvent(e);
        if (progressToken !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: typeof e.seq === 'number' ? e.seq + 1 : collected.length,
              message: line,
            },
          });
        }
      }

      cursor = typeof data.next_since === 'number' ? data.next_since : cursor + events.length;
      final = data.final === true;
      if (typeof data.outcome === 'string') outcome = data.outcome;
      if (!final) await sleep(poll_interval_ms);
    }

    return text({
      order_id,
      merchant_url: b,
      final,
      status: lastStatus,
      outcome: outcome ?? (final ? 'success' : 'incomplete'),
      event_count: collected.length,
      screenshots,
      events: collected.map(formatEvent),
      streamed_as_progress: progressToken !== undefined,
    });
  },
);

// --- boot ------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP transport and must stay clean.
  console.error(
    `x402-shopper MCP ready — network=${config.network} mockMerchant=${config.mockMerchant} mockPay=${config.mockPay} allowReal=${config.allowRealPurchase}`,
  );
}

main().catch((err) => {
  console.error('x402-shopper failed to start:', err);
  process.exit(1);
});
