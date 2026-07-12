# demo-x402-adapter

An x402-enabled HTTP adapter that wraps a merchant which doesn't
speak x402 or MPP natively. Autonomous agents pay in USDC on Base;
this server settles, then drives fulfillment against the real
merchant on their behalf.

Built for HCompany's computer-use hackathon.

## Open merchant adapter factory

The demo can turn a merchant's ordinary ordering page into a self-hosted x402
catalog without hand-editing TypeScript. H's computer-use agent performs a
strictly browse-only discovery run; a deterministic publisher validates the
result, preserves durable product IDs across refreshes, records the merchant
and source URL needed for fulfillment, computes an auditable all-inclusive
price, and regenerates the storefront.

The adapter factory and canonical merchant manifests are open and live in your
repository. A merchant does not need to join a centralized catalog or
implement x402.

```bash
cd python
./h402 merchant onboard 'https://merchant.example/ordering-page' \
  --nickname demo-shop --count 5 --publish
```

That one command discovers, validates, registers, and publishes. It never adds
an item to a cart or begins checkout during onboarding. Use
`--publish-dry-run` to run the complete H discovery and preview the publish
without changing the canonical source or TypeScript.

For a previously captured validated catalog, publishing is fast and offline:

```bash
./h402 catalog publish runtime/catalogs/001-...-demo-shop.json --dry-run
./h402 catalog publish runtime/catalogs/001-...-demo-shop.json
```

The publisher rejects non-HTTPS sources, non-USD prices, duplicate or
wrong-merchant durable IDs, zero prices, and provenance that does not prove
discovery was browse-only. Pricing is broken into merchant subtotal, estimated
tax buffer, shipping buffer, and service fee; the public x402 price is their
all-inclusive total. Canonical inputs live in `catalog/merchant-catalogs/` and
generated-file drift is CI-friendly:

```bash
npm run catalog:generate
npm run catalog:check
npm run test:publisher
```

### 90-second demo script

- **0:00–0:15 — problem.** “Most merchants will not implement an agent payment
  protocol tomorrow. We make their existing web checkout x402-addressable.”
- **0:15–0:35 — H discovery.** Show the running `merchant onboard ...
  --publish` command and its menu/checkpoint evidence. Point out the explicit
  no-cart/no-checkout policy.
- **0:35–0:55 — factory reveal.** Publish the already validated run with
  `./h402 catalog publish <artifact> --dry-run`, then without `--dry-run`. Show
  the product count and price range; regenerate again to prove idempotence.
- **0:55–1:15 — agent-facing result.** `curl /products`; highlight merchant
  identity, durable ID, and transparent price breakdown. Trigger the purchase
  endpoint without payment and show the standards-compliant 402.
- **1:15–1:30 — close.** “H turns the messy web into fulfillment. x402 turns
  it into an agent-native economic API. The adapter stays open and self-hosted.”

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
curl http://localhost:3000/products/test-item

# Trigger the 402 challenge (no payment attached)
curl -X POST http://localhost:3000/products/test-item/purchase \
  -H 'Content-Type: application/json' \
  -d '{"quantity":1,"shipping":{"name":"You","address_1":"123 Main","city":"SF","state":"CA","zip":"94114"}}'
```

The last call returns HTTP 402 with the x402 payment challenge. To
settle it, use any x402 client — Coinbase's `@x402/fetch` and
`@x402/evm`, `x402-axios`, or the merchant-agnostic `mppx` CLI — with
a Base wallet holding USDC.

## Deploy

Ships anywhere Hono runs: Node (`npm start`), Bun (`bun src/server.ts`),
Cloudflare Workers (via `hono/cloudflare-workers`), or Vercel (drop
into `api/[[...route]].ts`).

## Docs for contributors

See [AGENTS.md](./AGENTS.md).
