# x402 Shopper — a local MCP wallet for buying real goods with USDC

A one-file **stdio MCP server** that turns any MCP-capable agent (Claude Code,
Cursor, Codex, Claude Desktop) into an x402 buyer. Install it once and your
agent can discover x402 merchants, comparison-shop a catalog, and buy **physical
goods** with a single signed USDC transfer — while the wallet's private key
never leaves your machine and the only thing on the wire between agent and
merchant is **HTTP 402**.

This is buyer-side ergonomics, not a hosted gateway. A gateway in the middle
would defeat the point of x402; here the agent pays the merchant directly.

## Why this one is different

Plenty of x402 MCP wallets already exist, and Bazaar discovery + spend caps are
table stakes — we don't claim those as firsts. Two things here were found
nowhere else:

1. **Dry-run by default.** `buy` previews the exact charge and returns the
   precise arguments to re-call with. It only spends on an explicit
   `confirm: true`, within the per-purchase and per-session caps, and only when
   the operator set `ALLOW_REAL_PURCHASE=1`. Three independent gates.
2. **Live fulfillment streamed to the agent.** `track_order` doesn't just expose
   a status you poll — it **streams each fulfillment event, including checkout
   screenshots**, back to the agent as MCP progress notifications. The agent
   watches a browser agent check out on the underlying merchant, in its own
   context, in real time.

## Install (one-liners)

The server runs straight from TypeScript via `tsx` — no build step.

**Claude Code:**

```bash
claude mcp add x402-shopper \
  --env MOCK_MERCHANT=1 --env MOCK_PAY=1 \
  -- npx -y tsx /ABS/PATH/TO/mcp/src/server.ts
```

For real purchases, drop the mock envs and add your key + the master switch:

```bash
claude mcp add x402-shopper \
  --env X402_BUYER_PRIVATE_KEY=0x... \
  --env X402_NETWORK=eip155:84532 \
  --env ALLOW_REAL_PURCHASE=1 \
  --env MAX_SPEND_USD=50 \
  -- npx -y tsx /ABS/PATH/TO/mcp/src/server.ts
```

**Cursor / Claude Desktop / Codex** — add to `.mcp.json` (Cursor) or
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "x402-shopper": {
      "command": "npx",
      "args": ["-y", "tsx", "/ABS/PATH/TO/mcp/src/server.ts"],
      "env": {
        "MOCK_MERCHANT": "1",
        "MOCK_PAY": "1"
      }
    }
  }
}
```

Codex (`~/.codex/config.toml`) uses the same command/args/env under an
`[mcp_servers.x402-shopper]` table.

## Configuration

All via environment variables (see `.env.example`):

| Var | Default | Meaning |
| --- | --- | --- |
| `X402_BUYER_PRIVATE_KEY` | — | Local signing key. Never leaves the machine, never returned by any tool. Omit and use `MOCK_PAY=1` to run keyless. |
| `X402_NETWORK` | `eip155:84532` | EVM network (CAIP-2). Default Base Sepolia. |
| `MAX_SPEND_USD` | `50` | Per-purchase ceiling. A `buy` above this stays a preview. |
| `SESSION_BUDGET_USD` | `100` | Cumulative per-process budget, held in memory. |
| `ALLOW_REAL_PURCHASE` | `0` | Master switch. `buy` only settles when this is `1`. |
| `MERCHANT_URLS` | `https://buywith402.com` | Comma-separated merchant base URLs for discovery. |
| `MOCK_MERCHANT` | off | Serve an in-process fake merchant (catalog, 402, fulfillment stream). |
| `MOCK_PAY` | off | Skip real signing/settlement; pretend payment succeeded. |

The private key is read once to build a signer and is never logged, returned,
or embedded in an error message.

## Tools

| Tool | Spends? | What it does |
| --- | --- | --- |
| `wallet_status` | no | Public address, network, caps, remaining session budget. |
| `discover_merchants(query?, tag?)` | no | List known x402 merchants with tags + sample products. |
| `list_products(merchant_url)` | no | Browse a catalog; shows x402 price and (if disclosed) the underlying merchant price. |
| `inspect_purchase(merchant_url, product_id, shipping?)` | no | POST the purchase and read the 402 challenge **without paying** — exact amount, asset, network, pay-to. |
| `buy(merchant_url, product_id, shipping, quantity?, confirm?)` | only on confirm | **Dry-run by default.** Previews the charge and returns the args to confirm with; settles only on `confirm: true` within caps and with `ALLOW_REAL_PURCHASE=1`. |
| `track_order(merchant_url, order_id)` | no | Polls the free order endpoint and **streams** each fulfillment event + screenshot as MCP progress notifications; returns a final summary. |

## Safety model

- **Dry-run default** — spending is opt-in per call (`confirm: true`).
- **Two-key real spend** — even a confirmed buy is refused unless the operator
  set `ALLOW_REAL_PURCHASE=1`.
- **Caps** — per-purchase (`MAX_SPEND_USD`) and cumulative per-session
  (`SESSION_BUDGET_USD`) limits, both enforced before settlement.
- **Local key** — the wallet key stays on your machine; the agent never sees it.

## Mock matrix (offline demo & tests)

| Env | Effect |
| --- | --- |
| `MOCK_MERCHANT=1` | In-process fake merchant: `/products`, a 402 challenge, `/purchase`, and an 8-event `/orders/:id` fulfillment stream with placeholder screenshots. No network. |
| `MOCK_PAY=1` | Skip real x402 signing/settlement; treat the challenge as paid. |

Run the full mocked flow:

```bash
npm install
npm run demo   # = MOCK_MERCHANT=1 MOCK_PAY=1 node scripts/smoke.mjs
npm run typecheck
```

`scripts/smoke.mjs` launches the server over stdio, drives a real MCP client
session through every tool, and asserts that fulfillment events arrived as
progress notifications carrying screenshot URLs.
