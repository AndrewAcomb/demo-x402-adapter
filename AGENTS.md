# AGENTS.md — demo-x402-adapter

Read this before making non-trivial changes. Everything here is
intentionally minimal because the goal is an MMVP demo, not a
production adapter.

## What this project is

An HTTP API that:

1. Exposes a catalog of vitamin products.
2. Charges via the **x402 payment protocol** (crypto rail, USDC on
   Base) when a buyer POSTs to `/products/:id/purchase`.
3. On successful settlement, queues fulfillment — the real code will
   eventually drive a computer-use / browser-automation flow to check
   out on the underlying merchant's site. For now, fulfillment is a
   stub that returns an `order_id` immediately.

The point of the demo: an autonomous agent finds this API on the
x402 Bazaar (Coinbase CDP's discovery layer), pays for a product with
one signed USDC transfer, and receives an order confirmation — without
the underlying merchant having implemented x402 themselves.

## Stack

- **Language:** TypeScript, strict mode.
- **Runtime:** Node with `tsx` for hot-reload during dev.
- **HTTP:** [Hono](https://hono.dev/) — chosen over Express for type
  inference and cross-runtime portability. Deploys unchanged on Node,
  Bun, Deno, Cloudflare Workers, Vercel.
- **x402 middleware:** [`@x402/hono`](https://www.npmjs.com/package/@x402/hono)
  v2 (not `x402-hono`, which is v1 and deprecated). Handles 402
  issuance, `X-Payment` header parsing, EIP-3009 signature verification
  via the facilitator, and settlement.
- **EVM scheme:** [`@x402/evm`](https://www.npmjs.com/package/@x402/evm)'s
  `ExactEvmScheme` — the exact-amount signed-transfer scheme.
- **Facilitator:** by default the `x402.org` public testnet facilitator.
  For mainnet, switch to Coinbase CDP:
  `https://api.cdp.coinbase.com/platform/v2/x402/facilitator`. See
  `.env.example`.
- **Validation:** Zod for request-body parsing. Types are inferred from
  the schemas — do not maintain parallel `interface` declarations.

## File layout

```
src/
  server.ts        Hono app, routes, middleware wiring, entry point.
  catalog.ts       Static product data (2 SKUs).
  schemas.ts       Zod schemas + inferred types.
  fulfillment.ts   In-memory queue stub. Replace with real worker.
AGENTS.md          You are here.
CLAUDE.md          Symlink-esque pointer for Claude Code.
README.md          Human-facing usage docs.
.env.example       Env-var template (network, pay-to, facilitator).
```

## Behavioral contract

- **Free endpoints** (`/health`, `/products`, `/products/:id`,
  `/orders/:orderId`) never 402. They exist so agents can browse the
  catalog and check status without paying.
- **Paid endpoint** (`POST /products/:id/purchase`) is behind the x402
  middleware. Any request without a valid `X-Payment` header gets 402
  with a challenge; a request with a valid header gets settlement plus
  the handler's response.
- **Fulfillment is fire-and-forget** for MMVP. The order gets an ID
  and a `queued` status; there is no retry logic and no operator UI.
  A production adapter would need both.

## Extending the demo

- **Per-product pricing:** the current middleware config uses one flat
  `$0.10` price for every product. To vary prices per SKU, either
  register one middleware entry per route pattern (
  `"POST /products/vit-d-30/purchase": { accepts: { price: "$2.99", ... } }`),
  or leave the middleware config alone with a `$10.00` ceiling and use
  `setSettlementOverrides(c, { amount: cents })` inside the handler to
  charge the actual per-product amount at settle-time.
- **Bazaar auto-listing:** the CDP facilitator catalogs your endpoint
  on the first successful settlement — no explicit registration step.
  To seed it before the demo, do one manual `/purchase` call yourself.
- **MPP compatibility:** MPP treats `x402/exact` as one of the schemes
  it accepts inside its multi-rail 402 challenges. If you later want
  MPP clients (`mppx`, `@stripe/link-cli`) to also settle here, wrap
  the x402 challenge inside an MPP-style envelope — no code change on
  the settlement side.

## Non-goals for the MMVP

- Persisting orders past process restart.
- Authenticating buyers (x402 makes the payment the identity).
- Handling refunds, disputes, or partial failures.
- Rate limiting or abuse controls.
- Real computer-use fulfillment (out of scope for this repo; happens
  in a separate demo agent).

## Local dev

```bash
cp .env.example .env
# edit .env — at minimum set X402_PAY_TO
npm install
npm run dev
```

Server listens on `http://localhost:3000`. Sanity check:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/products
```

## Type-check

```bash
npm run typecheck
```

Should complete with zero errors before committing.
