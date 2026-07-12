# demo-x402-adapter

An x402-enabled HTTP adapter that wraps a merchant which doesn't
speak x402 or MPP natively. Autonomous agents pay in USDC on Base;
this server settles, then drives fulfillment against the real
merchant on their behalf.

Built for HCompany's computer-use hackathon.

## Why proof-carrying checkout

An API saying `order confirmed` is easy. This adapter also returns the
inspectable execution trail produced while an H computer-use agent operates a
merchant that never implemented x402: progress events, checkout checkpoints,
and the SHA-256 hash of each locally captured screenshot.

Every new worker event commits to its canonical payload and the preceding
event hash. The result is a tamper-evident chain from a deterministic,
order-bound root through the latest browser action. Existing order polling is
unchanged; proof fields are additive.

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
curl http://localhost:3000/products/mcmaster%3A92224A112

# Trigger the 402 challenge (no payment attached)
curl -X POST http://localhost:3000/products/mcmaster%3A92224A112/purchase \
  -H 'Content-Type: application/json' \
  -d '{"quantity":1,"shipping":{"name":"You","address_1":"123 Main","city":"SF","state":"CA","zip":"94114"}}'
```

The last call returns HTTP 402 with the x402 payment challenge. To
settle it, use any x402 client — Coinbase's `@x402/fetch` and
`@x402/evm`, `x402-axios`, or the merchant-agnostic `mppx` CLI — with
a Base wallet holding USDC.

## 90-second demo path

After a paid request returns `order_id`, open two free URLs:

```text
GET /orders/{order_id}                 incremental agent progress (JSON)
GET /orders/{order_id}/proof/view      live checkout storyboard (HTML)
GET /orders/{order_id}/proof           verifiable receipt artifact (JSON)
GET /orders/{order_id}/proof?download=1
```

The storyboard refreshes while fulfillment is running. Each H checkout
checkpoint becomes a frame with its screenshot content hash and event hash;
the event trail underneath makes the transition from payment to merchant
review or placement visible. End on the green `CHAIN VERIFIED` seal, then save
the JSON artifact. This makes the differentiation concrete: x402 is the
payment rail, H is the computer-use fulfillment layer, and the evidence chain
shows what that agent actually did.

The JSON proof includes explicit `verified`, `event_count`, `root`, `head`,
and redundant stored-anchor fields. An old order with pre-chain events remains
pollable but reports `status: "unavailable"`; it is never mislabeled as
verified. A malformed, reordered, modified, or locally truncated chain reports
`status: "invalid"`.

## Evidence format

`buywith402/evidence-chain/v1` uses recursively key-sorted JSON, UTF-8, and no
insignificant whitespace. The canonical event payload is:

```json
{
  "evidence_version": "buywith402/evidence-chain/v1",
  "message": "place-order-review",
  "order_id": "...",
  "previous_hash": "...",
  "screenshot_sha256": "... when local bytes were available",
  "screenshot_url": "... when upload succeeded",
  "seq": 3,
  "stage": "checkpoint",
  "t": "2026-07-12T08:00:04+00:00"
}
```

The root is `SHA256("buywith402:evidence-root:v1\n" + order_id)`. Each
`event_hash` is
`SHA256("buywith402:evidence-event:v1\n" + canonical_json(payload))`.
Screenshot bytes are hashed before upload; proof requests never download or
trust remote blob content in their request path.

Run the deterministic cross-runtime fixture checks:

```bash
npm run typecheck
npm run test:proof
cd python
direnv exec .. uv run python evidence_chain.py \
  --verify-fixture ../fixtures/evidence-chain-v1.json
```

## Threat-model boundary

The chain detects content changes, deletion, and reordering relative to a
previously saved root/head or the redundant order anchor. It makes corruption
and after-the-fact edits evident. The downloadable receipt provides a compact
head an agent or operator can retain for later comparison.

It is not a digital signature, trusted timestamp, blockchain commitment, or
third-party attestation. Someone able to rewrite both Redis records can
recompute an entirely new unsigned chain. The screenshot hash proves that the
event committed to particular bytes; it does not prove those pixels were true,
when they were captured, or that the merchant fulfilled the shipment. A
production design should sign or externally anchor receipt heads and retain
artifacts in immutable storage.

## Deploy

Ships anywhere Hono runs: Node (`npm start`), Bun (`bun src/server.ts`),
Cloudflare Workers (via `hono/cloudflare-workers`), or Vercel (drop
into `api/[[...route]].ts`).

## Docs for contributors

See [AGENTS.md](./AGENTS.md).
