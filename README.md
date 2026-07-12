# demo-x402-adapter

An x402-enabled HTTP adapter that wraps a merchant which doesn't
speak x402 or MPP natively. Autonomous agents pay in USDC on Base;
this server settles, then drives fulfillment against the real
merchant on their behalf.

Built for HCompany's computer-use hackathon.

## Voice Workshop

Open [`http://localhost:3000/workshop`](http://localhost:3000/workshop) for a
human-facing demo layered over the same agent API:

1. Speak an interrupted, natural workshop request (or use the clearly labeled
   typed fallback).
2. Gradium STT turns the recording into text while its API key stays on the
   server.
3. A deterministic resolver matches thread, length, drive, finish, and package
   quantity against the free catalog, then shows the all-in USDC price.
4. The user reviews the SKU and shipping details and explicitly approves the
   handoff.
5. The page prepares the existing endpoint's real x402 challenge. A wallet
   agent can copy the handoff, pay, and receive the order ID; the existing H
   Company worker then drives the merchant checkout.

The UI defaults to `dry_run=true`, so the H Company worker stops at merchant
review. This is intentional two-key safety: the user must uncheck it and the
worker must separately have `ALLOW_REAL_ORDERS=1` before a merchant order can
be placed.

### Voice setup

Create a Gradium key, then add it to `.env` (or the deployment's server-side
environment):

```bash
GRADIUM_API_KEY=your_server_side_key
```

The integration follows Gradium's current official [STT POST
contract](https://docs.gradium.ai/api-reference/endpoint/stt-post): binary WAV
audio is sent to `POST https://api.gradium.ai/api/post/speech/asr` with the
`x-api-key` header, and the server parses the NDJSON transcript stream. The
browser never receives the key. If the key is absent or transcription fails,
the page says so and falls back to typed input; it never labels browser-native
speech or typed text as a Gradium invocation.

### 90-second demo script

- **0:00–0:12 — Problem.** “My hands are on a cabinet jig. The merchant does
  not speak agent protocols, and I should not have to hunt through a catalog.”
- **0:12–0:28 — Speak.** Tap the mic and say: “I need—hang on—one hundred
  black screws for the cabinet jig. Pan head Phillips, four-forty… quarter-inch
  long.” Tap again to finish. Point out the live **Gradium transcription** badge.
- **0:28–0:43 — Resolve.** Click **Resolve request**. Show the exact McMaster
  SKU, constraints, pack math, and all-inclusive USDC price. The same catalog
  was available to the agent for free.
- **0:43–1:02 — Trust boundary.** Review the dry-run toggle and shipping
  details. Check the explicit approval box; explain that speech alone can never
  trigger payment.
- **1:02–1:15 — Protocol handoff.** Click **Prepare x402 challenge**. Show the
  HTTP 402 amount/network and copy the agent handoff. No payment has moved yet.
- **1:15–1:30 — Close the loop.** Run the prepared request with the demo wallet
  (or show the prior successful run), receive an order ID, and show H Company
  fulfillment events/screenshots through merchant review.

### Differentiation story

Rye is a strong hosted universal-checkout API: its documented flow starts with
a product URL and buyer identity, then uses an API credential plus tokenized
payment to complete checkout. This demo explores a different boundary:

- **Need in, not URL in.** The user can state messy domain constraints; the
  free catalog turns them into a precise, reviewable SKU.
- **Open payment protocol.** The merchant adapter is an x402 resource in the
  Coinbase Bazaar. Any compliant wallet agent can discover and pay it without
  a bilateral checkout-platform account.
- **Payment is the agent's identity.** One exact USDC authorization settles at
  the HTTP boundary before fulfillment is queued.
- **Inspectable fulfillment.** H Company handles the long-tail merchant site,
  while free order events and screenshots let the buyer observe what happens
  after settlement.

The claim is not that an overnight demo has broader merchant coverage or
reliability than Rye. The novelty is the composable, protocol-native boundary:
voice intent → free product resolution → explicit approval → x402 payment →
observable computer-use fulfillment.

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

## Verification

```bash
npm run typecheck
npm test
```
