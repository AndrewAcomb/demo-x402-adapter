# Track B — Merchant Factory

BuyWith402 already lets agents buy real hardware with one x402 payment;
this track makes the supply side just as automatic. Paste a store URL
into `POST /merchants` and an H browser agent visits the store, extracts
a price-verified catalog, and publishes it into the live API — minutes
later the products are in `GET /products`, individually priced, payable
with a single USDC transfer, and discoverable on the Coinbase x402
Bazaar. No redeploy, no merchant integration, no buyer account: the 402
challenge is the entire API contract.

That is the difference from buy-side platforms like Rye, which also
execute checkout on arbitrary stores (and accept x402) but sit behind
their own gated API — an account, a subscription, per-call fees, and
their endpoint as the contract. We work the other direction: we make the
merchant itself appear as a native, permissionlessly discoverable x402
seller, so any agent that can sign a USDC transfer can find and buy from
it with no relationship to us or to the merchant. Onboarding a merchant
is one authenticated POST; buying from one requires no key at all.

The whole loop is watchable and honest about its state: onboarding jobs
and orders stream progress events (including checkout screenshots) over
the same free polling contract, and fulfillment on arbitrary stores is
still a browser agent driving a real checkout — a demo-grade path with
retries and fail-closed dry runs, not a settled reliability claim.
