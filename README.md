# BuyWith402

BuyWith402 makes ordinary online stores available to x402-native agents. A
buyer pays USDC on Base, this API settles the payment, and an H browser agent
checks out on the underlying merchant's site. The merchant does not need to
integrate x402.

Built for H Company's computer-use hackathon.

## How it works

1. An agent browses `GET /products` and chooses an item.
2. `POST /products/{id}/purchase` returns an x402 payment challenge.
3. After payment, the API queues fulfillment and returns an `order_id`.
4. The buyer polls `GET /orders/{order_id}` for status, agent events, and
   checkout screenshots.

Purchases are real by default. Send `"dry_run": true` to stop safely at the
merchant's order-review screen. Prices are all-inclusive: item price, service
fee, estimated tax, and fulfillment cost.

The Merchant Factory extends the same flow to new stores. A $5 x402-paid
`POST /merchants` starts a browser agent that extracts a small validated
catalog and publishes it to `GET /products` without a redeploy.

## Architecture

```
buyer agent ──x402 USDC──▶ API (Hono, one Vercel function)
                              │ settle via Coinbase CDP facilitator (Base)
                              ▼
                        Upstash Redis  ◀─ poll ─  Python workers (operator box)
                 orders · job queues · live            │
                 events · dynamic catalog              ▼
                              ▲            H Company cloud browser agents
   screenshots ─▶ Vercel Blob ┘                        │
                                            real merchant checkouts
                                          (McMaster-Carr, Square, Toast…)
```

- **API** — TypeScript/Hono on Vercel; per-product pricing from a merged
  static + Redis catalog; x402 challenges carried in both header and body.
- **State** — Upstash Redis over REST is the only database: durable orders,
  onboarding jobs, work queues, event streams, dynamic catalog.
- **Workers** — two Python loops (fulfillment, merchant onboarding) pop the
  queues and drive H computer-use agents; screenshots land in Vercel Blob,
  progress events in Redis for buyers to poll.
- **Safety** — a real Place Order needs buyer intent (`dry_run: false`) AND a
  worker env flag AND a local tool that validates the visible part, quantity,
  and total before authorizing exactly one click; ambiguous failures never
  auto-retry.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Machine-readable guide |
| `GET` | `/products` | Browse or search with `?query=<text>` |
| `GET` | `/products/{id}` | View one product |
| `POST` | `/products/{id}/purchase` | Pay and queue fulfillment |
| `GET` | `/orders/{order_id}` | Poll fulfillment progress |
| `POST` | `/merchants` | Pay $5 and onboard a store |
| `GET` | `/merchants/jobs/{job_id}` | Poll onboarding progress |

All `GET` routes are free. Paid product routes declare the x402 Bazaar
discovery extension so compatible agents can discover how to call them.

## Local sanity check

Requires Node.js 24.

```bash
cp .env.example .env
# Set X402_PAY_TO to an EVM address you control.
npm install
npm run dev
```

Then browse the catalog and request a challenge:

```bash
curl 'http://localhost:3000/products?query=screw'

curl -X POST http://localhost:3000/products/mcmaster:92224A100/purchase \
  -H 'Content-Type: application/json' \
  -d '{"quantity":1,"dry_run":true,"shipping":{"name":"You","address_1":"123 Main St","city":"San Francisco","state":"CA","zip":"94114"}}'
```

The second request intentionally returns HTTP 402. A compatible x402 client
can sign the challenge and retry the request to create the order.

Durable orders, live events, and dynamic catalogs require an Upstash-compatible
Redis REST store. Without one, the static catalog and in-memory demo fallback
still work. The Node and Vercel entry points are `src/server.ts` and
`api/index.ts`.

The browser workers and their setup live in [python/](./python/README.md). For
the onboarding demo without H credentials, run `ONBOARD_MOCK=1 uv run python
onboard_worker.py` from that directory.

## Check

```bash
npm run typecheck
```
