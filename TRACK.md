# Track A — Mission Control

BuyWith402 already works end to end: an agent discovers the API on
the x402 Bazaar, pays USDC on Base, and a hosted browser agent checks
out on McMaster-Carr. Until now the only way to watch that happen was
terminal logs. Mission Control turns the loop into something an
audience can see: a live dashboard at `/live`, served by the same
Hono app on Vercel, where each order appears the moment payment
settles, its on-chain proof (amount, payer, tx hash linked to
Basescan) is shown next to it, and the browser agent's checkout
screenshots stream into a timeline as fulfillment runs.

The payment proof is captured with an `onAfterSettle` hook in the
x402 resource server and correlated to the order through the signed
payment payload, so the dashboard shows real settlement data, not a
reconstruction. For the 1:30 stage slot there is a replay mode
(`/live?replay=ORDER_ID`) that re-animates any past real order with
its original pacing, gaps compressed — the demo cannot dead-air even
if live fulfillment is slow. Without Redis the page falls back to
clearly-badged synthetic data, so judges can also open it cold from
the repo. One glance at the screen answers the question every judge
has: did money actually move, and did a real order actually happen.
