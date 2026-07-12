# McMaster-Carr H hosted-browser demo

The first demo step asks H's `h/web-surfer-pro` agent to browse McMaster-Carr
and produce a validated catalog of exactly ten inexpensive, orderable screw
SKUs. Each product receives a stable durable ID such as
`mcmaster:91251A541`.

The browser script loads the active, confirmed profile recorded in
`profile-state.json` and persists its final cookies and storage.

The script only browses product tables. It does not add anything to an order,
sign in, or enter checkout.

Every run first checks the account indicator at the top-right of McMaster-Carr.
It must visibly contain `David`. If it shows `Log in`, another identity, or an
unreadable state, the agent stops immediately and the script exits without
writing a catalog.

## Setup

The project uses direnv to activate its virtual environment and load the local,
git-ignored `.env` file. Approve it once, then install the project:

```bash
direnv allow
uv sync
```

The checked-in `.envrc` is self-contained: when `uv` is installed it creates
`.venv` on first load, activates it, adds a local `bin/` directory when present,
and loads the ignored `.env`. It does not depend on personal direnv helpers.
The `h402` CLI creates all ignored `runtime/` subdirectories automatically and
anchors them to this Python project, regardless of the caller's current working
directory.

## Publish a discovered merchant to x402

Append `--publish` to generic merchant onboarding to promote the validated H
result into the canonical source tree and regenerate `src/catalog.ts` in the
same command:

```bash
./h402 merchant onboard 'https://merchant.example/order' \
  --nickname example --count 5 --publish
```

Onboarding remains browse-only: H is instructed not to sign in, add to cart,
begin checkout, or enter personal data. The publisher independently requires
provenance with `discovery_mode=browse-only` and
`purchase_actions_permitted=false`. It is a deterministic filesystem build
step and never launches a browser or purchase workflow.

Use `--publish-dry-run` for the full discovery plus a no-write preview. To
promote an existing validated run or verify generated-file drift:

```bash
./h402 catalog publish runtime/catalogs/001-...-example.json --dry-run
./h402 catalog publish runtime/catalogs/001-...-example.json
./h402 catalog check
```

Per-merchant pricing defaults to a 15% service fee (minimum $1), a 10% tax
buffer, and a $15 shipping buffer for shipped orders ($0 for pickup). Override
these during onboarding with `--service-markup-percent`,
`--tax-buffer-percent`, and `--shipping-buffer`. The exact breakdown is stored
on every published product and the x402 charge is the all-inclusive total.

All H browser calls resolve through `h_browser_runtime.py`. It reads the pinned
profile UUID from `profile-state.json`, confirms the configured H environment
still points to that profile, inherits the same custom proxy, and generates the
same overrides for catalog, cart, checkout, and purchase sessions. Normal calls
provision a fresh hosted browser from that pinned profile; `--resume` attaches
to the exact warm idle session instead.

Browser calls accept `--proxy true|false` (default `true`) and
`--h-environment env1`. The environment defaults to the value recorded in
`profile-state.json`; only that configured environment is supported, and any
other name fails closed. These options may appear anywhere on an `h402`
cart/checkout command and are also accepted by `catalog refresh`.

Create the ignored runtime tree and initialize the recipient address book on a
fresh clone:

```bash
mkdir -p runtime/private
cp addresses.example.json runtime/private/addresses.json
```

Alternatively, export a key directly:

```bash
export HAI_API_KEY="hk-..."
```

Add the throwaway McMaster credentials to the ignored `.env` file:

```bash
MCMASTER_EMAIL="demo@example.com"
MCMASTER_PASSWORD="demo-password"
```

When a run sees `Log in`, it signs in and requires the account indicator to
change to `David` before catalog work. Credentials are redacted from terminal
and tee logs, but are sent to H's hosted model/runtime as part of the task.

For email 2FA, configure a private IMAP mailbox in `.env`:

```bash
EMAIL_IMAP_HOST="imap.example.com"
EMAIL_IMAP_PORT="993"
EMAIL_IMAP_USERNAME="buyer@buywith402.com"
EMAIL_IMAP_PASSWORD="mailbox-password-or-app-password"
EMAIL_IMAP_FOLDER="INBOX"
EMAIL_2FA_SENDER_FILTER="mcmaster"
```

At run start the script records the latest existing message UID. If McMaster
requests email verification, the local tool waits only for newer matching
messages and extracts a 4–10 character code. Codes are redacted from tee logs.

Run catalog preparation:

```bash
uv run python prepare_purchase.py
```

The same live output is appended to `runtime/logs/app.log`. Follow it from
another terminal with:

```bash
tail -f runtime/logs/app.log
```

Show only Mac-side callbacks in another terminal:

```bash
tail -F runtime/logs/app.log | grep --line-buffered 'LLOCALL'
```

New workflow output uses fixed-width structured logging while preserving the
existing message text:

```text
2026-07-11 17:42:03.184  S001  R002                  HHStream - [agent] ...
2026-07-11 17:42:03.221  S001  R002                Screenshot - SAVED CHECKPOINT ...
2026-07-11 17:42:03.250  S001  R002                  CartFlow - LOCAL MAC: ...
```

All live H event-stream text uses the static `HHStream` component. Local call
sites use stable components such as `Catalog`, `AddCart`, `CartFlow`,
`Purchase`, `Resume`, `Email2FA`, `Screenshot`, `HRuntime`, `Error`, and
`Application`. The component column is right-justified.

The validated result is printed and saved under `runtime/catalogs/`. Catalogs
are immutable: files are never overwritten and use a sequential number, UTC
timestamp, and short catalog name:

```text
runtime/catalogs/001-20260711T201530Z-mcmaster-screws.json
runtime/catalogs/002-20260711T204212Z-mcmaster-screws.json
```

A later purchase step can accept one of the durable IDs and start a new,
stateless browser run.

## Cart demo

The ergonomic operator entry point is `h402`. Run `./h402 --help` for the full
grammar. Examples:

```bash
./h402 doctor
./h402 catalog list
./h402 cart add -i
./h402 checkout -i
./h402 cart reset add -i checkout -i
./h402 cart reset add mcmaster:92224A112 checkout 1
./h402 cart noreset add 92224A112 checkout 1
./h402 cart add 92224A112 checkout 1 --place-order
```

`cart add` resets automatically. Add the literal `noreset` to opt out. Chained
cart actions execute as one H browser session.

Checkout stops at review unless `--place-order` is explicitly present. Purchase
mode captures the review first, requires local SKU/quantity/total authorization
(default maximum `$50.00`), clicks once, verifies an order number, and saves an
additional `04-order-confirmed.png` checkpoint.

For developer iteration, successful workflows keep the hosted H session idle
for 10 minutes and write `runtime/last-h-session.json`. A follow-up workflow can
add `--resume` to consume that pointer and reconnect to the exact session when
it is still idle and less than nine minutes old:

```bash
./h402 cart noreset add 92224A112 --resume
./h402 checkout 1 --resume
```

`--resume` may appear anywhere on a cart/checkout command line, for example
`./h402 --resume cart add 2` or `./h402 cart add --resume 2`. Without it, a new
H session starts with the same persisted browser profile; merchant-side cart
state may still carry over and is always re-read by the workflow.

Normal startup clears the previous pointer. Errors, Ctrl-C, stale pointers, and
non-idle H status fail closed without starting a replacement session.

Empty the authenticated McMaster cart, verify it is empty, save a screenshot,
and stop:

```bash
uv run python reset_cart.py
```

Then choose a part from the newest cached catalog using a numbered menu. In one
H session the agent clears the cart, adds exactly one package, fills delivery
and payment from `runtime/private/addresses.json` and `.env`, saves the final review
screenshot, and stops with `Place Order` untouched:

```bash
uv run python add_cached_to_cart.py --interactive
```

Without `--interactive` (or `-i`), the add command selects the cheapest cached
part automatically. Both cart commands copy the custom proxy configuration
from the H environment recorded in `profile-state.json` into the new browser
session. Add `--verify-proxy` when you want to check its public egress IP;
normal runs skip that extra navigation.

The interactive flow asks for the product first and then a recipient from the
address book. The selected name/address is used for both delivery and billing;
the card always comes from `.env`. Copy `addresses.example.json` to
`runtime/private/addresses.json`, edit its recipient list, and use `--max-total` to set
the fail-closed order ceiling (default: `$50.00` including shipping and tax).

Each new H session lineage atomically mints the next demo session ID (`S001`
through `S999`) and stores its artifacts in a matching directory. The agent
captures the checkpoints applicable to the requested workflow plus a structured
result:

```text
runtime/sessions/S001/S001-R001-01-cart-cleared.png
runtime/sessions/S001/S001-R001-02-product-in-cart.png
runtime/sessions/S001/S001-R001-03-place-order-review.png
runtime/sessions/S001/S001-R001-result.json
runtime/sessions/S001/S001-R001-timing.jsonl
```

Every cart/checkout/reset invocation first captures
`S001-R001-00-initial-state.png` before changing the browser. This is especially
useful for resumed sessions. Every workflow PNG receives a dark-grey provenance
header above the unchanged browser pixels, with local timestamp/timezone, demo
session ID, H session ID, action context, and checkpoint name. Each image checkpoint also creates a flat timing
event in `S001-R001-timing.jsonl`. `S001` identifies the warm H session lineage;
the first request is `R001`, and each successful `--resume` reuses the same
session directory while incrementing to `R002`, `R003`, and so on.

If a required checkpoint is missed, the run fails and saves
`S001-R001-99-final-state.png` as diagnostic evidence when possible.
The timing file is append-only JSONL: one flat line per event with monotonic
elapsed seconds relative to the start of that demo run.

When managed proxies are enabled for the H organization, request sticky US
residential egress with:

```bash
uv run python prepare_purchase.py --us-egress
```

## Refresh the uploaded browser profile

Open the local Chrome profile named `hackathon` (`Profile 7`) for login and
cookie setup:

```bash
uv run python h_profile.py --open
```

After preparing any merchant login or cookie state needed for the demo, publish
the next two-digit H profile version with:

```bash
uv run python h_profile.py
```

The command briefly quits Chrome, packages `Profile 7` as `Default/` together
with Chrome's `Local State`, and rebuilds `hackathon-chrome-user-data.zip`,
chooses the next available name (`hackathon01`, `hackathon02`, ...), uploads and
completes it, pauses to confirm it through H's list API, and only then switches
the active pointer. It also patches the owned H environment recorded in
`profile-state.json` to the new profile UUID and enables profile persistence.
Older profiles remain available as rollback copies.

`profile-state.json` is the git-trackable source of truth for the active name,
UUID, version, and confirmation time. Failed uploads never change it.
