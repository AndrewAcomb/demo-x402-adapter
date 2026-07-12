"""Onboard any ordering page as an h402 merchant: browse it with H and
build a validated catalog of inexpensive, orderable items."""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock

from hai_agents import Client
from pydantic import BaseModel, Field, model_validator

from add_cached_to_cart import mint_demo_session, save_image, stamp_provenance
from h_browser_runtime import HBrowserRuntime
from merchants import (
    Merchant,
    get_merchant,
    load_registry,
    nickname_from_url,
    save_merchant,
    slugify,
)
from prepare_purchase import (
    OUTPUT_NAME_PATTERN,
    enable_tee,
    local_banner,
    print_live_event,
)
from structured_logging import console, hyperlink

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "runtime"

ONBOARD_CHECKPOINTS = {
    "initial-state": "00-initial-state",
    "menu-items": "01-menu-items",
    "price-verification": "02-price-verification",
}


class MenuItem(BaseModel):
    position: int = Field(ge=1, le=200)
    item_name: str = Field(min_length=1)
    section: str = ""
    description: str = ""
    options: str = Field(
        default="",
        description="Chosen option/size if the item requires one; empty otherwise",
    )
    package_quantity: int = Field(default=1, ge=1)
    package_price: float | str = Field(
        description="Exact displayed price as a plain number, e.g. 0.75"
    )
    currency: str = Field(min_length=3, max_length=3)

    @model_validator(mode="after")
    def normalize(self) -> MenuItem:
        self.currency = self.currency.upper()
        self.item_name = " ".join(self.item_name.split())
        if isinstance(self.package_price, str):
            cleaned = re.sub(r"[^0-9.]", "", self.package_price)
            self.package_price = float(cleaned) if cleaned else 0.0
        return self


class MerchantMenu(BaseModel):
    merchant_display_name: str = Field(min_length=1)
    ordering_available: bool
    pickup_available: bool
    delivery_available: bool
    blocker: str | None = None
    products: list[MenuItem] = Field(max_length=200)

    @model_validator(mode="after")
    def validate_menu(self) -> MerchantMenu:
        if not self.ordering_available:
            if self.products:
                raise ValueError("unorderable results must not contain products")
            return self
        if not self.products:
            raise ValueError("orderable catalog must contain at least one item")
        self.products.sort(key=lambda item: item.position)
        return self


class OnboardError(RuntimeError):
    """Onboarding failed for a reason worth reporting to the caller."""


@dataclass
class OnboardResult:
    """Successful onboarding: registered merchant + validated catalog."""

    merchant: Merchant
    payload: dict[str, object]
    output_path: Path
    product_count: int


def save_catalog(
    payload: dict[str, object], output_dir: Path, short_name: str
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    used_numbers = []
    for path in output_dir.glob("*.json"):
        match = OUTPUT_NAME_PATTERN.match(path.name)
        if match:
            used_numbers.append(int(match.group(1)))
    sequence = max(used_numbers, default=0) + 1
    if sequence > 999:
        raise RuntimeError("Catalog output sequence exceeded 999")
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    output_path = output_dir / f"{sequence:03d}-{timestamp}-{short_name}.json"
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return output_path


def onboarding_message(
    url: str, count: int, max_price: float, full: bool = False
) -> str:
    if full:
        catalog_task = f"""
Then catalog the ENTIRE menu at depth one: every currently orderable item
visible in every menu section, in menu order (up to 200 items). Depth one
means the listing only — do NOT open item dialogs or option pickers. Read
exact visible item names, the section each appears under, short visible
descriptions, and exact displayed prices; never invent or round them. If
an item requires choices (flavor, size), still include it with options
left empty — choices are made later at order time. Skip an item only if
it shows no readable price in the listing. Scroll or switch sections as
needed until every section has been read once.
""".strip()
    else:
        catalog_task = f"""
Then build a catalog of {count} inexpensive, currently orderable items,
each ideally under {max_price:.2f} in the local currency. Do NOT
exhaustively enumerate the menu: take the first {count} suitable items
you can verify, ideally all from one or two sections, and stop. Prefer
simple items that can be added with one click and no required choices:
sides, sauces, dressings, drinks, desserts, small add-ons. If an item
requires a selection (size, flavor), either skip it or record the
cheapest choice in the options field. Every item MUST have a real
nonzero price you have actually seen displayed. If a price is not shown
in the menu listing, open that item once to read its true price, then
close the dialog without adding it. Skip any item whose price you cannot
verify or that displays as 0.00. Never invent or round names or prices.
Record the menu section each item appears under.
""".strip()
    return f"""
You are cataloging an online ordering page so software can order from it
later. The page is {url}. Do NOT sign in, do NOT add anything to a cart,
do NOT begin checkout, and do NOT enter any personal data.

INITIAL AUDIT — DO THIS BEFORE ANY OTHER BROWSER ACTION:
Allow the current page to render, but do not navigate, click, type, or
scroll yet. Immediately call
capture_onboarding_checkpoint(checkpoint="initial-state").

SCREENSHOT EVIDENCE while you work:
- When the menu listing you are reading items from is visible, call
  capture_onboarding_checkpoint(checkpoint="menu-items").
- If you had to open an item dialog to verify a hidden price, call
  capture_onboarding_checkpoint(checkpoint="price-verification") once,
  with one representative dialog open, before closing it.

First confirm this page supports placing orders. Record the merchant's
exact display name as shown on the page. Note whether Pickup and/or
Delivery fulfillment are offered. If ordering is unavailable (closed,
broken page, unsupported region, or a captcha you cannot pass), return
ordering_available=false with the exact blocker text and no products.

{catalog_task}

For every item return: position (1..N in menu order), exact item name,
section, short description if shown (else empty), options (or empty),
package quantity 1, exact price, and the three-letter currency code.
""".strip()


def run_onboarding(
    url: str,
    nickname: str | None = None,
    *,
    count: int = 5,
    max_price: float = 15.0,
    full: bool = False,
    output_dir: Path = RUNTIME / "catalogs",
    sessions_dir: Path = RUNTIME / "sessions",
    log_file: Path = RUNTIME / "logs/app.log",
    proxy: bool = True,
    h_environment: str | None = None,
    on_event: Callable[[str, str], None] | None = None,
) -> OnboardResult:
    """Onboard `url` as a merchant: browse it with H, validate the catalog,
    register the merchant, and save the catalog JSON.

    Library entry point used by both the CLI (main below) and
    onboard_worker.py. `on_event(stage, message)` receives progress
    milestones; it must never raise (failures are swallowed).

    Raises OnboardError on any onboarding failure (bad input, ordering
    unavailable, agent run failed, empty catalog).
    """

    def emit(stage: str, message: str) -> None:
        if on_event is None:
            return
        try:
            on_event(stage, message)
        except Exception:  # noqa: BLE001 — progress reporting must not kill a run
            pass

    if not os.environ.get("HAI_API_KEY"):
        raise OnboardError("HAI_API_KEY is not set")
    if not re.match(r"^https://", url):
        raise OnboardError("url must be an https URL")
    if not full and not 1 <= count <= 10:
        raise OnboardError("count must be between 1 and 10")
    nickname = nickname or nickname_from_url(url)
    existing = load_registry().get(nickname)
    if existing is not None and existing.start_url != url:
        raise OnboardError(
            f"merchant {nickname!r} already exists with a different URL; "
            "pick another nickname"
        )

    demo_session_id, artifact_dir = mint_demo_session(sessions_dir)
    request_id = "R001"
    artifact_prefix = f"{demo_session_id}-{request_id}"
    timing_path = artifact_dir / f"{artifact_prefix}-timing.jsonl"
    timing_lock = Lock()
    flow_started_monotonic = time.monotonic()

    def record_timing(event: str, **details: object) -> None:
        record = {
            "demo_session_id": demo_session_id,
            "request_id": request_id,
            "event": event,
            "elapsed_seconds": round(time.monotonic() - flow_started_monotonic, 3),
            "recorded_at": datetime.now(UTC).isoformat(),
            **details,
        }
        with timing_lock:
            with timing_path.open("a", encoding="utf-8") as timing_file:
                timing_file.write(json.dumps(record, separators=(",", ":")) + "\n")
                timing_file.flush()
            timing_path.chmod(0o600)

    record_timing("run-started", merchant=nickname, url=url)
    emit("onboard", f"Onboarding merchant {nickname!r} from {url}")
    enable_tee(log_file, demo_session_id, request_id)
    local_banner(f"ONBOARDING MERCHANT {nickname!r} FROM {url}", component="Onboard")
    local_banner(
        f"{demo_session_id}: ARTIFACTS WILL BE SAVED UNDER {artifact_dir.resolve()}",
        component="Onboard",
    )

    latest_image: dict[str, object] | None = None
    latest_image_index = 0
    image_lock = Lock()
    captured_checkpoints: set[str] = set()
    required_checkpoints = {"initial-state", "menu-items"}
    workflow_context = f"ONBOARD {nickname.upper()}"

    def capture_onboarding_checkpoint(checkpoint: str) -> str:
        """Save the current browser screenshot at a named onboarding checkpoint."""
        if checkpoint not in ONBOARD_CHECKPOINTS:
            allowed = ", ".join(ONBOARD_CHECKPOINTS)
            raise ValueError(
                f"Unknown checkpoint {checkpoint!r}; expected one of: {allowed}"
            )
        with image_lock:
            image = latest_image
            image_index = latest_image_index
        if image is None:
            local_banner(
                f"{demo_session_id}: CHECKPOINT {checkpoint} FAILED — NO SCREENSHOT",
                component="Screenshot",
            )
            raise RuntimeError("No browser screenshot is available for this checkpoint")
        path = artifact_dir / f"{artifact_prefix}-{ONBOARD_CHECKPOINTS[checkpoint]}.png"
        save_image(image, path)
        stamp_provenance(
            path,
            demo_session_id=demo_session_id,
            request_id=request_id,
            h_session_id=session.id,
            context=f"{workflow_context}  ·  {checkpoint.upper()}",
        )
        path.chmod(0o600)
        captured_checkpoints.add(checkpoint)
        emit("checkpoint", checkpoint)
        record_timing(checkpoint, artifact=path.name, image_event_index=image_index)
        local_banner(
            f"{demo_session_id}: SAVED CHECKPOINT {checkpoint} TO {path.resolve()}",
            component="Screenshot",
            console_text="📸",
            console_link=(f"{checkpoint.replace('-', ' ')} screenshot", str(path)),
        )
        return f"Saved {checkpoint} checkpoint for {demo_session_id}"

    tools = [capture_onboarding_checkpoint]

    client = Client()
    browser_runtime = HBrowserRuntime.resolve(client, h_environment)
    session = browser_runtime.start_session(
        client,
        start_url=url,
        network=None if proxy else {},
        answer_schema=MerchantMenu,
        tools=tools,
        messages=onboarding_message(url, count, max_price, full),
        max_steps=45 if full else 25,
        max_time_s=540 if full else 300,
    )
    snapshot = session.get()
    record_timing("h-session-created", h_session_id=session.id)
    emit("live_view", f"Watch the agent live: {snapshot.agent_view_url}")
    print(f"Demo session: {demo_session_id}", flush=True)
    print(f"H session: {session.id}", flush=True)
    print(f"H Agent View: {snapshot.agent_view_url}", flush=True)
    print(f"Streaming {nickname} menu discovery...", flush=True)
    console.key(
        f"{demo_session_id} · onboarding {nickname} · H session {session.id[:8]}",
        link_label="watch live agent view",
        link_target=snapshot.agent_view_url,
    )
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            waiter = executor.submit(
                session.wait_for_completion,
                timeout_seconds=570 if full else 330,
                tools=tools,
            )
            for event in session.stream():
                print_live_event(event)
                payload = event.model_dump(mode="json")
                data = payload.get("data") or {}
                if data.get("kind") == "observation_event" and data.get("image"):
                    with image_lock:
                        latest_image = data["image"]
                        latest_image_index += 1
            result = waiter.result()
    except Exception as exc:
        record_timing(
            "session-completed",
            outcome="error",
            success=False,
            error_type=type(exc).__name__,
        )
        raise

    missing_checkpoints = required_checkpoints - captured_checkpoints
    if missing_checkpoints and latest_image is not None:
        final_state_path = artifact_dir / f"{artifact_prefix}-99-final-state.png"
        try:
            save_image(latest_image, final_state_path)
            stamp_provenance(
                final_state_path,
                demo_session_id=demo_session_id,
                request_id=request_id,
                h_session_id=session.id,
                context=f"{workflow_context}  ·  FALLBACK FINAL STATE",
            )
            final_state_path.chmod(0o600)
            local_banner(
                f"{demo_session_id}: SAVED FALLBACK FINAL STATE TO "
                f"{final_state_path.resolve()}",
                component="Screenshot",
            )
        except Exception as exc:
            local_banner(
                f"SCREENSHOT DOWNLOAD FAILED: {exc}", component="Screenshot"
            )

    print(f"Status: {result.status}")
    print(f"Outcome: {result.outcome}")
    emit("agent", f"Browse finished: status={result.status} outcome={result.outcome}")
    if result.error:
        print(f"Error: {result.error}")
    if result.answer is None:
        record_timing(
            "session-completed",
            outcome=str(result.outcome),
            success=False,
            error_type="MissingStructuredAnswer",
        )
        raise OnboardError(
            "the browse run returned no structured catalog "
            f"(outcome={result.outcome}, error={result.error or 'none'})"
        )
    menu = result.answer
    if not menu.ordering_available:
        record_timing(
            "session-completed",
            outcome=str(result.outcome),
            success=False,
            error_type="OrderingUnavailable",
        )
        print(f"FAILURE: ordering unavailable — {menu.blocker or 'no blocker text'}")
        raise OnboardError(
            f"ordering unavailable — {menu.blocker or 'no blocker text'}"
        )
    if result.outcome != "success":
        record_timing(
            "session-completed",
            outcome=str(result.outcome),
            success=False,
        )
        raise OnboardError(f"browse run did not succeed (outcome={result.outcome})")

    fulfillment = "pickup" if menu.pickup_available else "shipping"
    merchant = Merchant(
        nickname=nickname,
        display_name=menu.merchant_display_name,
        kind="web",
        start_url=url,
        fulfillment=fulfillment,
        requires_login=False,
        catalog_short_name=nickname,
        catalog_mode="full" if full else "sample",
    )
    save_merchant(merchant)
    emit("merchant", f"Registered merchant {nickname!r} ({menu.merchant_display_name})")

    kept: list[MenuItem] = []
    seen_names: set[str] = set()
    dropped: list[str] = []
    for item in menu.products:
        price = float(item.package_price)
        if price <= 0:
            dropped.append(f"{item.item_name} (unverified/zero price)")
            continue
        if item.item_name.casefold() in seen_names:
            dropped.append(f"{item.item_name} (duplicate)")
            continue
        seen_names.add(item.item_name.casefold())
        kept.append(item)
    if dropped:
        print(f"Dropped {len(dropped)} item(s): {'; '.join(dropped)}")
    if not kept:
        print("FAILURE: every returned item was zero-priced or duplicate.")
        raise OnboardError("every returned item was zero-priced or duplicate")

    products = []
    seen_ids: set[str] = set()
    for position, item in enumerate(kept, start=1):
        durable_id = f"{nickname}:{slugify(item.item_name)}"
        if durable_id in seen_ids:
            durable_id = f"{durable_id}-{position}"
        seen_ids.add(durable_id)
        products.append(
            {
                "position": position,
                "durable_id": durable_id,
                "part_number": item.item_name,
                "description": item.description or item.item_name,
                "section": item.section,
                "options": item.options,
                "package_quantity": item.package_quantity,
                "package_price": float(item.package_price),
                "currency": item.currency,
                "url": url,
            }
        )
    payload = {
        "merchant": merchant.model_dump(mode="json"),
        "pickup_available": menu.pickup_available,
        "delivery_available": menu.delivery_available,
        "products": products,
    }
    output_path = save_catalog(payload, output_dir, merchant.catalog_short_name)
    record_timing(
        "session-completed",
        outcome=str(result.outcome),
        success=True,
        catalog=output_path.name,
        product_count=len(products),
    )
    emit(
        "catalog",
        f"Validated catalog saved: {output_path.name} ({len(products)} products)",
    )
    print("\nValidated catalog:")
    print(json.dumps(payload, indent=2))
    print(f"\nSaved to {output_path.resolve()}")
    print(
        f"\nMerchant {nickname!r} registered. Next: "
        f"./h402 cart add -i --merchant {nickname}"
    )
    console.stop(
        f"✓ {menu.merchant_display_name} onboarded — {len(products)} items · "
        + hyperlink("[catalog json]", output_path)
        + f" · next: ./h402 cart add -i --merchant {nickname}"
    )
    return OnboardResult(
        merchant=merchant,
        payload=payload,
        output_path=output_path,
        product_count=len(products),
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Onboard an ordering page as a merchant and build its catalog."
    )
    parser.add_argument("--url", help="Ordering page URL (omit with --refresh)")
    parser.add_argument("--nickname", help="Merchant nickname, e.g. littlestar")
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Rebuild the catalog for an already-registered merchant",
    )
    parser.add_argument("--count", type=int, default=5)
    parser.add_argument("--max-price", type=float, default=15.0)
    parser.add_argument(
        "--full",
        action="store_true",
        help="Enumerate the whole menu at depth one instead of a small sample",
    )
    parser.add_argument("--output-dir", type=Path, default=RUNTIME / "catalogs")
    parser.add_argument("--sessions-dir", type=Path, default=RUNTIME / "sessions")
    parser.add_argument("--log-file", type=Path, default=RUNTIME / "logs/app.log")
    parser.add_argument("--proxy", choices=("true", "false"), default="true")
    parser.add_argument("--h-environment", "--environment", dest="h_environment")
    args = parser.parse_args()

    if not os.environ.get("HAI_API_KEY"):
        parser.error("HAI_API_KEY is not set; let direnv load this project first")

    if args.refresh:
        if not args.nickname:
            parser.error("--refresh requires --nickname")
        try:
            merchant = get_merchant(args.nickname)
        except KeyError as exc:
            parser.error(str(exc))
        if merchant.kind == "mcmaster":
            parser.error("mcmaster catalogs are refreshed by prepare_purchase.py")
        url = merchant.start_url
        nickname = merchant.nickname
        if merchant.catalog_mode == "full":
            args.full = True
    else:
        if not args.url:
            parser.error("--url is required unless --refresh is used")
        url = args.url
        nickname = args.nickname

    try:
        run_onboarding(
            url,
            nickname,
            count=args.count,
            max_price=args.max_price,
            full=args.full,
            output_dir=args.output_dir,
            sessions_dir=args.sessions_dir,
            log_file=args.log_file,
            proxy=args.proxy != "false",
            h_environment=args.h_environment,
        )
    except OnboardError as exc:
        print(f"FAILURE: {exc}")
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
