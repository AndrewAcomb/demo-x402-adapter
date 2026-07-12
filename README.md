# demo-x402-adapter

An x402-enabled HTTP adapter that wraps a merchant which doesn't
speak x402 or MPP natively. Autonomous agents pay in USDC on Base;
this server settles, then drives fulfillment against the real
merchant on their behalf.

Built for HCompany's computer-use hackathon.

## Quick start

```bash
cp .env.example .env  # then set X402_PAY_TO to an EVM address you control
npm install
npm run dev
```

Server listens on `:3000`.

```bash
# Browse the catalog (free)
curl http://localhost:3000/products

# See a single product (free)
curl http://localhost:3000/products/vit-d-30

# Trigger the 402 challenge (no payment attached)
curl -X POST http://localhost:3000/products/vit-d-30/purchase \
  -H 'Content-Type: application/json' \
  -d '{"quantity":1,"shipping":{"name":"You","address_1":"123 Main","city":"SF","state":"CA","zip":"94114"}}'
```

The last call returns HTTP 402 with the x402 payment challenge. To
settle it, use any x402 client — Coinbase's `@x402/fetch` and
`@x402/evm`, `x402-axios`, or the merchant-agnostic `mppx` CLI — with
a Base wallet holding USDC.

## Mission Control (live dashboard)

A self-contained ops dashboard, served by the same Hono app, that
shows the whole loop live: order arrives via x402, payment proof
(USDC amount, payer, tx hash with a Basescan link), the browser
agent's fulfillment timeline with checkout screenshots as they
stream in, and the final outcome.

| Route | What it does |
| --- | --- |
| `GET /live` | Live dashboard. Polls the order feed every ~3s and the selected order every ~2s. |
| `GET /live/orders/:id` | Deep link with one order pre-selected. |
| `GET /live?replay=ORDER_ID` | Replay a past order: re-animates its full event history with original relative timing (gaps over 8s compressed to 2s). Badged REPLAY. |
| `GET /orders?limit=N` | JSON feed of recent orders (newest first, max 50), including payment summary. Free, never 402s. |

Notes:

- Orders land in the feed via the `orders:recent` Redis index;
  payment proof is captured by an `onAfterSettle` hook and appended
  to the order's timeline as a `payment` event.
- Without Redis configured (`KV_REST_API_URL`/`TOKEN` unset), `/live`
  runs on built-in synthetic data and is badged DEMO DATA, so the
  page is fully reviewable offline.
- The dashboard is one embedded HTML string (`src/dashboard.ts`) —
  no build step, no external assets, works unchanged on Vercel.
- The order feed is public by design (it is the demo). It exposes
  order ids, statuses, and payment proof, but not shipping details.

## Deploy

Ships anywhere Hono runs: Node (`npm start`), Bun (`bun src/server.ts`),
Cloudflare Workers (via `hono/cloudflare-workers`), or Vercel (drop
into `api/[[...route]].ts`).

## Docs for contributors

See [AGENTS.md](./AGENTS.md).
