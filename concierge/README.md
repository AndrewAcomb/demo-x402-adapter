# Voice Concierge

A voice-driven autonomous buyer. You speak an order ("order a pack of
4-40 quarter-inch screws to the office"); the concierge transcribes it,
reasons with H Company's Holo3 model, finds BuyWith402 on the x402
Bazaar, pays real USDC in one signed transfer, and then narrates the
H browser agent's checkout — screenshots streaming on screen — until it
speaks the final order confirmation.

Agents on both sides of one payment: an H-model buyer pays an
x402 merchant whose fulfillment is an H browser agent.

## Quick start (fully offline, no keys)

```bash
cd concierge
npm install
npm run demo        # open http://localhost:4020
```

Type an order in the text box (voice is mocked without a key), press
Enter, then confirm with "yes" or the Confirm button. You get the whole
flow: intent parsing, Bazaar discovery, catalog browsing, product
choice with a spoken justification, simulated x402 payment, and a
canned 8-event fulfillment run with screenshots.

Verify end-to-end without a browser:

```bash
npm run smoke       # 20 assertions over the real WebSocket protocol
npm run typecheck
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4020` | HTTP + WebSocket port. |
| `GRADIUM_API_KEY` | — | Gradium STT (websocket ASR) + TTS. Absent → voice mocked. |
| `GRADIUM_VOICE_ID` | `YTpq7expH9539ERJ` (Emma) | TTS voice. |
| `HAI_API_KEY` | — | H Company Models API (Holo3 = the buyer's brain). Absent → deterministic mock. |
| `HAI_MODEL` | `holo3-1-35b-a3b` | H model name. |
| `X402_BUYER_PRIVATE_KEY` | — | EVM key holding testnet USDC. Absent → payment simulated. |
| `X402_NETWORK` | `eip155:84532` | Base Sepolia by default. |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | Also used for Bazaar discovery. |
| `MERCHANT_URL` | `https://buywith402.com` | Real merchant. Setting it flips the merchant live. |
| `MOCK_VOICE` / `MOCK_LLM` / `MOCK_MERCHANT` / `MOCK_PAY` | auto | `1`/`0` to force; default is auto-detect from the keys above. |
| `DEMO_DRY_RUN` | `1` | Send `dry_run=true` to the merchant (fulfillment stops at order review). |
| `ALLOW_REAL_PURCHASE` | `0` | Must be `1` for any non-dry-run order. |
| `MAX_SPEND_USD` | `50` | Hard cap; pricier picks are forced back to dry run. |
| `MOCK_EVENT_MS` | `1800` | Pacing of the canned mock fulfillment events. |

Keys live only in the server process. The browser sees transcripts,
narration text/audio, and fulfillment events — never a key.

## Mock matrix

Each subsystem un-mocks independently — flip one at a time and re-test:

| Subsystem | Mocked (default, no keys) | Live |
| --- | --- | --- |
| Voice | Text box input; narration rendered as text + browser `speechSynthesis` | Mic → 24 kHz PCM → Gradium ASR websocket; narration via Gradium TTS WAV |
| Brain | Keyword/fraction matching + template narration | Holo3 parses intent, picks the product, writes narration lines |
| Merchant | Built-in `/mock-merchant/*` clone of the BuyWith402 API with canned screenshots | `MERCHANT_URL` (buywith402.com) |
| Payment | 402 answered with a placeholder header, loudly logged as simulated | `@x402/fetch` + viem signer: one signed USDC transfer (exact scheme) |

## Live-demo runbook (tomorrow)

Order matters — each step is independently reversible:

1. **Brain live:** set `HAI_API_KEY`. Re-run `npm run smoke` style order
   via the UI; check the choice justification reads well.
2. **Merchant live:** set `MERCHANT_URL=https://buywith402.com`
   (keep `MOCK_PAY=1` for now — the purchase will fail at the real 402,
   which proves the challenge; or skip straight to step 3).
3. **Payment live:** set `X402_BUYER_PRIVATE_KEY` (wallet funded with
   USDC on Base Sepolia — or Base mainnet with `X402_NETWORK=eip155:8453`
   if the merchant is on mainnet; check `GET https://buywith402.com/health`
   for its network). Keep `DEMO_DRY_RUN=1`: money moves, but fulfillment
   stops at the merchant's order-review screen.
4. **Voice live:** set `GRADIUM_API_KEY`. Chrome, localhost (secure
   context) — click the mic, speak, watch the live transcript.
5. **Stage settings:** raise `MOCK_EVENT_MS` irrelevant now; real events
   arrive as the H worker emits them. For a REAL shipped order:
   `DEMO_DRY_RUN=0 ALLOW_REAL_PURCHASE=1` and keep `MAX_SPEND_USD` tight.
6. Shipping address: `cp addresses.example.json addresses.json` and put
   the real office address in (gitignored).

Pre-demo sanity: `curl localhost:4020/healthz` shows which subsystems
are live; the UI header badges show the same.

## Architecture

```
concierge/
  src/server.ts       Hono HTTP + ws WebSocket bridge; serves the UI; holds keys
  src/session.ts      Per-connection orchestrator: speech → intent → discovery
                      → choice → confirmation → payment → narrated fulfillment
  src/voice.ts        Gradium TTS (POST) + ASR (websocket relay)
  src/llm.ts          Holo3 brain + deterministic mock fallbacks
  src/payment.ts      @x402/fetch wrapper (real) or simulated-payment fetch (mock)
  src/discovery.ts    x402 Bazaar lookup via @x402/extensions, graceful fallback
  src/merchant.ts     BuyWith402 API client
  src/mockMerchant.ts Offline clone of the merchant incl. canned fulfillment
  src/mockScreens.ts  Embedded-SVG "screenshots" for offline runs
  public/index.html   Single-file projector UI (no CDNs): mic, transcript,
                      narration feed, big screenshot stage, event timeline
  scripts/smoke.mjs   Programmatic end-to-end test of the mocked flow
```

Every live call has a mock fallback *and* live-call failures degrade to
the mock at runtime, so the demo cannot stall on stage.
