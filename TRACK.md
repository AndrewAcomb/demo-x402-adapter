# Track D — x402 Shopper: a local MCP wallet for buying real goods

Today's demo shows a blank-slate agent hand-writing an x402 client just to make
one payment. Track D removes that friction: `x402 Shopper` is a local stdio MCP
server that installs into Claude Code, Cursor, or Codex with one line and gives
the agent a USDC wallet — the key stays on the user's machine and the only thing
on the wire between agent and merchant is HTTP 402, so there is no gateway in the
middle to defeat the point of x402.

We are honest about prior art: several x402 MCP wallets already exist, and both
Bazaar merchant discovery and session spend caps are table stakes — we do not
claim those as firsts. What we found nowhere else is two things. First,
**dry-run-default purchase semantics**: the `buy` tool previews the exact charge
and returns the precise arguments to confirm with, and only spends on an explicit
`confirm:true` that also clears a per-purchase cap, a per-session budget, and an
operator master switch. Second, **live fulfillment streamed into the agent's
context**: `track_order` doesn't just expose a status to poll — it streams every
fulfillment event, including checkout screenshots of the H Company browser agent
working the real merchant, back to the agent as MCP progress notifications. The
combination — true-x402, physical-goods checkout driven from a local wallet with
an agent-visible fulfillment narrative — is the defensibly new part.

The demo beat: one-line install, the agent calls `discover_merchants` and finds
our Bazaar-listed `buywith402.com`, `inspect_purchase` shows the exact USDC
charge without paying, `buy` previews then (on confirm) settles one signed
transfer, and `track_order` streams the checkout screenshots as the order is
placed — all in the agent's own chat. The whole thing runs offline via a mocked
in-process merchant and mock settlement, and a smoke test drives a real MCP
client session through every tool and asserts the screenshots streamed as
progress notifications. Real testnet purchases need only a funded Base wallet
key and `ALLOW_REAL_PURCHASE=1`.
