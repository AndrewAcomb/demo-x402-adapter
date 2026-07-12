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

## Merchant Factory

Turn any store URL into live x402 products, no redeploy: an H browser
agent browses the store, extracts a validated catalog, and the products
appear in `GET /products` — priced, purchasable, and Bazaar-discoverable
— while you watch progress events.

### Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/merchants` | `X-Admin-Key` header | Queue an onboarding job. Body: `{ url, nickname?, display_name?, max_products? }`. Returns `job_id` + poll URL. |
| `GET` | `/merchants/jobs/{job_id}` | none | Job status + live events. Same poll contract as `/orders/{id}`: pass `?since=<next_since>`, poll while `final=false`. |
| `GET` | `/merchants` | none | Onboarded merchants with product counts. |

The admin key is `ONBOARD_ADMIN_KEY` on the server: unset → `POST
/merchants` answers 503 (feature disabled); wrong key → 401. Products are
priced like the static catalog: merchant package price × 1.5 + $15
shipping/tax buffer.

### Run the onboarding worker

From `python/` (needs the same Upstash env as the fulfillment worker, plus
H credentials via direnv for real browsing):

```bash
uv run python onboard_worker.py                 # real H browse
ONBOARD_MOCK=1 uv run python onboard_worker.py  # canned catalog, no H
```

Mock mode skips only the browser session: the event stream and every
Redis write (dynamic catalog, merchants index, job status) go through the
same code paths, so the API side behaves identically.

### Offline dev loop (no Upstash, no H)

```bash
node scripts/dev-redis-stub.mjs   # in-memory Upstash-REST stub on :8199

KV_REST_API_URL=http://localhost:8199 KV_REST_API_TOKEN=dev \
X402_PAY_TO=0x0000000000000000000000000000000000000001 \
ONBOARD_ADMIN_KEY=demo-key npm run dev

cd python && KV_REST_API_URL=http://localhost:8199 KV_REST_API_TOKEN=dev \
ONBOARD_MOCK=1 uv run python onboard_worker.py

ONBOARD_ADMIN_KEY=demo-key scripts/demo-onboard.sh \
  https://some-store.example/order
```

`scripts/demo-onboard.sh` posts the job, streams its events, and prints
the enlarged live catalog when the job succeeds.

## Deploy

Ships anywhere Hono runs: Node (`npm start`), Bun (`bun src/server.ts`),
Cloudflare Workers (via `hono/cloudflare-workers`), or Vercel (drop
into `api/[[...route]].ts`).

## Docs for contributors

See [AGENTS.md](./AGENTS.md).
