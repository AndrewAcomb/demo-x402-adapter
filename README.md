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

## Deploy

Ships anywhere Hono runs: Node (`npm start`), Bun (`bun src/server.ts`),
Cloudflare Workers (via `hono/cloudflare-workers`), or Vercel (drop
into `api/[[...route]].ts`).

## Docs for contributors

See [AGENTS.md](./AGENTS.md).
