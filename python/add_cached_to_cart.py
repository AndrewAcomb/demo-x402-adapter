#!/usr/bin/env python
"""Add the cheapest item from the newest cached catalog to McMaster's cart."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from threading import Lock

import httpx

from hai_agents import Client
from pydantic import BaseModel, Field, field_validator

from email_2fa import ImapCodeReader
from h_profile import active_environment_network, newest_browser_profile_id
from prepare_purchase import (
    LOCAL_FAILURE,
    LOCAL_SUCCESS,
    RUNTIME_SECRETS,
    enable_tee,
    local_banner,
    print_live_event,
)


class CartResult(BaseModel):
    success: bool
    authenticated: bool
    account_indicator: str = Field(min_length=1)
    part_number: str = Field(min_length=1)
    cart_quantity: int = Field(ge=0)
    observed_price: str | None = None
    merchandise_total: str | None = None
    shipping_total: str | None = None
    tax_total: str | None = None
    order_total: str | None = None
    place_order_visible: bool
    place_order_clicked: bool
    payment_display: str | None = None
    blocker: str | None = None
    final_url: str = Field(min_length=1)


class ShippingAddress(BaseModel):
    recipient_name: str = Field(min_length=1)
    company: str = ""
    street1: str = Field(min_length=1)
    street2: str = ""
    city: str = Field(min_length=1)
    state: str = Field(min_length=2, max_length=2)
    postal_code: str = Field(min_length=5)
    country: str = "US"
    email: str = ""
    phone: str = ""

    @field_validator("state", "country")
    @classmethod
    def uppercase(cls, value: str) -> str:
        return value.upper()


class AddressBook(BaseModel):
    recipients: list[ShippingAddress] = Field(min_length=1)


CHECKPOINTS = {
    "cart-cleared": "01-cart-cleared",
    "product-in-cart": "02-product-in-cart",
    "place-order-review": "03-place-order-review",
}
CATALOG_TIMESTAMP = re.compile(r"^\d{3}-(\d{8}T\d{6}Z)-")


def newest_catalog(output_dir: Path) -> Path:
    catalogs = sorted(output_dir.glob("*-mcmaster-screws.json"))
    if not catalogs:
        raise FileNotFoundError(f"No cached McMaster catalogs found in {output_dir}")
    return catalogs[-1]


def describe_catalog(path: Path) -> str:
    match = CATALOG_TIMESTAMP.match(path.name)
    if match:
        timestamp = datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(
            tzinfo=UTC
        )
    else:
        timestamp = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
    seconds = int((datetime.now(UTC) - timestamp).total_seconds())
    future = seconds < 0
    seconds = abs(seconds)
    days, remainder = divmod(seconds, 86_400)
    hours, remainder = divmod(remainder, 3_600)
    minutes, _ = divmod(remainder, 60)
    if days:
        relative = f"{days}d {hours}h ago"
    elif hours:
        relative = f"{hours}h {minutes}m ago"
    elif minutes:
        relative = f"{minutes}m ago"
    else:
        relative = "less than a minute ago"
    if future:
        relative = f"in {relative.removesuffix(' ago')}"
    return f"Catalog: {path.name}\nTimestamp: {timestamp.isoformat()} ({relative})"


def mint_demo_session(output_dir: Path) -> tuple[str, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    for number in range(1, 1000):
        session_id = f"S{number:03d}"
        session_dir = output_dir / session_id
        try:
            session_dir.mkdir()
        except FileExistsError:
            continue
        session_dir.chmod(0o700)
        return session_id, session_dir
    raise RuntimeError("Demo session ID space S001 through S999 is exhausted")


def choose_product(
    products: list[dict[str, object]], interactive: bool, selector: str | None = None
) -> dict[str, object]:
    if selector is not None:
        normalized = selector.removeprefix("mcmaster:").upper()
        if selector.isdigit() and 1 <= int(selector) <= len(products):
            return products[int(selector) - 1]
        for product in products:
            if str(product["part_number"]).upper() == normalized:
                return product
            if str(product["durable_id"]).casefold() == selector.casefold():
                return product
        raise ValueError(f"Product {selector!r} is not in the newest catalog")
    if not interactive:
        return min(products, key=lambda item: float(item["package_price"]))
    print("\nProducts in newest cached catalog:\n")
    for index, item in enumerate(products, start=1):
        print(
            f" {index:2d}. {item['part_number']}  "
            f"{item['currency']} {float(item['package_price']):.2f}  "
            f"{item['description']}"
        )
    while True:
        raw = input(f"\nSelect a product [1-{len(products)}]: ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(products):
            return products[int(raw) - 1]
        print("Please enter one of the displayed menu numbers.")


def choose_recipient(
    recipients: list[ShippingAddress], interactive: bool, selector: str | None = None
) -> ShippingAddress:
    if selector is not None:
        if selector.isdigit() and 1 <= int(selector) <= len(recipients):
            return recipients[int(selector) - 1]
        raise ValueError(
            f"Recipient {selector!r} is invalid; use an address-book position"
        )
    if not interactive:
        return recipients[0]
    print("\nRecipients in address book:\n")
    for index, recipient in enumerate(recipients, start=1):
        street = recipient.street1
        if recipient.street2:
            street += f", {recipient.street2}"
        print(
            f" {index:2d}. {recipient.recipient_name} — {street}, "
            f"{recipient.city}, {recipient.state} {recipient.postal_code}"
        )
    while True:
        raw = input(f"\nSelect a recipient [1-{len(recipients)}]: ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(recipients):
            return recipients[int(raw) - 1]
        print("Please enter one of the displayed menu numbers.")


def save_image(image: dict[str, object], destination: Path) -> None:
    source = str(image["source"])
    image_type = str(image["type"])
    if "base64" in image_type.lower():
        payload = base64.b64decode(source)
    else:
        response = httpx.get(
            source,
            headers={"Authorization": f"Bearer {os.environ['HAI_API_KEY']}"},
            follow_redirects=False,
            timeout=30,
        )
        if response.is_redirect:
            response = httpx.get(response.headers["location"], timeout=30)
        response.raise_for_status()
        payload = response.content
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(payload)


def write_private_json(path: Path, payload: dict[str, object]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def redact_secrets(value: object) -> object:
    if isinstance(value, str):
        redacted = value
        for secret in RUNTIME_SECRETS:
            redacted = redacted.replace(secret, "<redacted>")
        return redacted
    if isinstance(value, dict):
        return {key: redact_secrets(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_secrets(item) for item in value]
    return value


def parse_usd(value: str | None) -> Decimal | None:
    if not value:
        return None
    normalized = re.sub(r"[^0-9.-]", "", value)
    try:
        return Decimal(normalized)
    except InvalidOperation:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Clear cart, add a cached SKU, fill checkout, and stop before Place Order."
    )
    parser.add_argument(
        "--catalog-dir", type=Path, default=Path("runtime/catalogs")
    )
    parser.add_argument(
        "--sessions-dir", type=Path, default=Path("runtime/sessions")
    )
    parser.add_argument(
        "--log-file", type=Path, default=Path("runtime/logs/fetch-products.log")
    )
    parser.add_argument(
        "--address-file", type=Path, default=Path("runtime/private/addresses.json")
    )
    parser.add_argument("--max-total", type=float, default=25.0)
    parser.add_argument("--product", help="Catalog position, durable ID, or part number")
    parser.add_argument("--recipient", help="One-based address-book position")
    parser.add_argument("--interactive-product", action="store_true")
    parser.add_argument("--interactive-recipient", action="store_true")
    parser.add_argument("--no-reset", action="store_true")
    parser.add_argument("--skip-add", action="store_true")
    parser.add_argument("--skip-checkout", action="store_true")
    parser.add_argument(
        "-i", "--interactive", action="store_true", help="Choose a SKU from a numbered menu"
    )
    parser.add_argument(
        "--verify-proxy",
        action="store_true",
        help="Verify the expected public proxy IP before opening McMaster",
    )
    args = parser.parse_args()

    do_add = not args.skip_add
    do_checkout = not args.skip_checkout
    do_reset = do_add and not args.no_reset
    if not do_add and not do_checkout:
        parser.error("workflow must add a product, prepare checkout, or both")

    catalog_path: Path | None = None
    product: dict[str, object] | None = None
    if do_add:
        catalog_path = newest_catalog(args.catalog_dir)
        print(f"\n{describe_catalog(catalog_path)}", flush=True)
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        product = choose_product(
            catalog["products"],
            args.interactive or args.interactive_product,
            args.product,
        )

    address: ShippingAddress | None = None
    address_payload: dict[str, object] = {}
    if do_checkout:
        address_book = AddressBook.model_validate_json(
            args.address_file.read_text(encoding="utf-8")
        )
        address = choose_recipient(
            address_book.recipients,
            args.interactive or args.interactive_recipient,
            args.recipient,
        )
        address_payload = address.model_dump(mode="json")
        for value in address_payload.values():
            if (
                isinstance(value, str)
                and len(value) >= 5
                and value != address.recipient_name
            ):
                RUNTIME_SECRETS.add(value)
    demo_session_id, artifact_dir = mint_demo_session(args.sessions_dir)
    timing_path = artifact_dir / f"{demo_session_id}-timing.jsonl"
    timing_lock = Lock()
    flow_started_monotonic = time.monotonic()

    def record_timing(event: str, **details: object) -> None:
        record = {
            "demo_session_id": demo_session_id,
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

    record_timing("run-started")
    enable_tee(args.log_file)
    part_number = str(product["part_number"]) if product is not None else None
    start_url = str(product["url"]) if product is not None else None
    if product is not None and catalog_path is not None:
        local_banner(
            f"{demo_session_id}: USING CACHE {catalog_path.name}; SELECTED {part_number} AT "
            f"{product['currency']} {product['package_price']:.2f}"
        )
    local_banner(f"{demo_session_id}: ARTIFACTS WILL BE SAVED UNDER {artifact_dir.resolve()}")

    email = os.environ.get("MCMASTER_EMAIL")
    password = os.environ.get("MCMASTER_PASSWORD")
    if not email or not password:
        parser.error("MCMASTER_EMAIL and MCMASTER_PASSWORD must be set")
    payment: dict[str, str | None] = {}
    card_name = ""
    if do_checkout:
        payment_names = (
            "CHECKOUT_CARD_NUMBER",
            "CHECKOUT_CARD_EXP_MONTH",
            "CHECKOUT_CARD_EXP_YEAR",
            "CHECKOUT_CARD_CVV",
        )
        payment = {name: os.environ.get(name) for name in payment_names}
        missing = [name for name, value in payment.items() if not value]
        if missing:
            parser.error(f"Missing checkout variables in .env: {', '.join(missing)}")
        RUNTIME_SECRETS.add(str(payment["CHECKOUT_CARD_NUMBER"]))
        RUNTIME_SECRETS.add(str(payment["CHECKOUT_CARD_CVV"]))
        assert address is not None
        card_name = os.environ.get("CHECKOUT_CARD_NAME", address.recipient_name)

    client = Client()
    tools = []
    latest_image: dict[str, object] | None = None
    image_lock = Lock()
    captured_checkpoints: set[str] = set()

    def capture_checkout_checkpoint(checkpoint: str) -> str:
        """Save the current browser screenshot at a named checkout checkpoint."""
        if checkpoint not in CHECKPOINTS:
            allowed = ", ".join(CHECKPOINTS)
            raise ValueError(f"Unknown checkpoint {checkpoint!r}; expected one of: {allowed}")
        with image_lock:
            image = latest_image
        if image is None:
            local_banner(
                f"{demo_session_id}: CHECKPOINT {checkpoint} FAILED — NO SCREENSHOT",
                LOCAL_FAILURE,
            )
            raise RuntimeError("No browser screenshot is available for this checkpoint")
        path = artifact_dir / f"{demo_session_id}-{CHECKPOINTS[checkpoint]}.png"
        save_image(image, path)
        path.chmod(0o600)
        captured_checkpoints.add(checkpoint)
        record_timing(
            checkpoint,
            artifact=path.name,
        )
        local_banner(
            f"{demo_session_id}: SAVED CHECKPOINT {checkpoint} TO {path.resolve()}",
            LOCAL_SUCCESS,
        )
        return f"Saved {checkpoint} checkpoint for {demo_session_id}"

    tools.append(capture_checkout_checkpoint)
    reader = ImapCodeReader.from_env()
    if reader is not None:
        local_banner("CONNECTING TO PRIVATE EMAIL OVER IMAP")
        reader.establish_baseline()
        local_banner("IMAP READY — NEW-MESSAGE BASELINE RECORDED", LOCAL_SUCCESS)

        def wait_for_email_2fa_code(timeout_seconds: int = 180) -> str:
            """Wait for a new McMaster email and return its verification code."""
            local_banner(f"H CALLED EMAIL TOOL — POLLING ({timeout_seconds}s timeout)")
            try:
                code = reader.wait_for_code(timeout_seconds)
                RUNTIME_SECRETS.add(code)
                local_banner("2FA CODE EXTRACTED — RETURNING IT TO H", LOCAL_SUCCESS)
                return code
            except Exception:
                local_banner("EMAIL 2FA TOOL FAILED", LOCAL_FAILURE)
                raise

        tools.append(wait_for_email_2fa_code)

    profile_id = newest_browser_profile_id(client)
    environment_network = active_environment_network(client)
    proxy_instruction = ""
    if args.verify_proxy:
        proxy_instruction = """
First inspect the JSON at the current api.ipify.org page. Confirm its public IP
is exactly 54.71.20.137. If it differs, stop immediately with success=false and
blocker="custom proxy egress verification failed". Do not expose proxy credentials.
""".strip()

    required_checkpoints: set[str] = set()
    if do_reset:
        required_checkpoints.add("cart-cleared")
        reset_instruction = """
Go to https://www.mcmaster.com/Order/ and DELETE EVERY existing line item.
Continue until the cart is visibly empty, then call
capture_checkout_checkpoint(checkpoint="cart-cleared").
""".strip()
    else:
        reset_instruction = (
            "Do not clear or delete the existing cart. This workflow explicitly disabled reset."
        )

    if do_add:
        assert product is not None and start_url is not None and part_number is not None
        required_checkpoints.add("product-in-cart")
        add_instruction = f"""
Open only the direct cached URL {start_url} for durable part {part_number}:
{product['description']}. Do not search or browse other products. Verify the
page is exactly part {part_number}, add exactly one package, then return to the
order page. Verify the cart contains part {part_number} with quantity 1. If
checkout is also requested, the cart must contain exactly this one line. Call
capture_checkout_checkpoint(checkpoint="product-in-cart").
""".strip()
    else:
        add_instruction = """
Do not add or remove products. Verify the existing cart contains exactly one
line item with quantity 1 and record its exact part number.
""".strip()

    if do_checkout:
        required_checkpoints.add("place-order-review")
        checkout_instruction = f"""
Fill delivery details exactly as follows:
{json.dumps(address_payload)}
Use standard delivery and use the selected recipient name and delivery address
for billing too. Fill payment with card number
{payment['CHECKOUT_CARD_NUMBER']}, expiration
{payment['CHECKOUT_CARD_EXP_MONTH']}/{payment['CHECKOUT_CARD_EXP_YEAR']}, CVV
{payment['CHECKOUT_CARD_CVV']}, and cardholder name {card_name}.

Let shipping, tax, and total recalculate. If total exceeds USD
{args.max_total:.2f}, return success=false and stop. The target is the Current
Order review with the item, delivery summary, masked payment, totals, and green
PLACE ORDER button visible. ABSOLUTELY DO NOT CLICK PLACE ORDER. Call
capture_checkout_checkpoint(checkpoint="place-order-review") before answering.
""".strip()
        answer_instruction = """
Return success=true only if PLACE ORDER is visible and untouched. Set
place_order_clicked=false. payment_display may include only brand/last four.
""".strip()
    else:
        checkout_instruction = """
Stop after viewing and checkpointing the product in the cart. Do not fill
delivery, billing, or payment fields and do not click PLACE ORDER.
""".strip()
        answer_instruction = """
Return success=true after the requested cart state is visibly verified. Set
place_order_visible=false and place_order_clicked=false.
""".strip()

    session = client.start_session(
        agent="h/web-surfer-pro",
        overrides={
            "agent.environments[kind=web].start_url": (
                "https://api.ipify.org?format=json"
                if args.verify_proxy
                else "https://www.mcmaster.com/Order/"
            ),
            "agent.environments[kind=web].browser_profile_id": profile_id,
            "agent.environments[kind=web].persist_browser_profile": True,
            "agent.environments[kind=web].network": environment_network.model_dump(
                mode="json", exclude_none=True
            ),
        },
        answer_schema=CartResult,
        tools=tools,
        messages=f"""
{proxy_instruction}

This is ONE composable cart workflow session. If necessary, log in with email
{email} and password {password}. Never echo credentials, address, or payment
data. Use wait_for_email_2fa_code if requested. Confirm the account is David.

RESET ACTION:
{reset_instruction}

ADD ACTION:
{add_instruction}

CHECKOUT ACTION:
{checkout_instruction}

{answer_instruction}
""".strip(),
        max_steps=45,
        max_time_s=480,
    )
    snapshot = session.get()
    record_timing("h-session-created", h_session_id=session.id)
    print(f"Demo session: {demo_session_id}", flush=True)
    print(f"H session: {session.id}", flush=True)
    print(f"H Agent View: {snapshot.agent_view_url}", flush=True)
    local_banner("STREAMING ATOMIC CART-TO-REVIEW — PLACE ORDER IS FORBIDDEN")

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            waiter = executor.submit(
                session.wait_for_completion, timeout_seconds=510, tools=tools
            )
            for event in session.stream():
                print_live_event(event)
                payload = event.model_dump(mode="json")
                data = payload.get("data") or {}
                if data.get("kind") == "observation_event" and data.get("image"):
                    with image_lock:
                        latest_image = data["image"]
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
        final_state_path = artifact_dir / f"{demo_session_id}-99-final-state.png"
        try:
            save_image(latest_image, final_state_path)
            final_state_path.chmod(0o600)
            local_banner(
                f"{demo_session_id}: SAVED FALLBACK FINAL STATE TO {final_state_path.resolve()}",
                LOCAL_FAILURE,
            )
        except Exception as exc:
            local_banner(f"SCREENSHOT DOWNLOAD FAILED: {exc}", LOCAL_FAILURE)

    if result.answer is None:
        record_timing(
            "session-completed",
            outcome=str(result.outcome),
            success=False,
            error_type="MissingStructuredAnswer",
        )
        raise SystemExit("H returned no structured cart result")
    raw_output = result.answer.model_dump(mode="json")
    output = redact_secrets(raw_output)
    assert isinstance(output, dict)
    output["demo_session_id"] = demo_session_id
    output["h_session_id"] = session.id
    output["captured_checkpoints"] = sorted(captured_checkpoints)
    result_path = artifact_dir / f"{demo_session_id}-result.json"
    result_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    result_path.chmod(0o600)
    print(json.dumps(output, indent=2), flush=True)
    parsed_total = parse_usd(result.answer.order_total)
    product_matches = (
        not do_add
        or part_number is not None
        and result.answer.part_number.upper() == part_number.upper()
    )
    checkout_valid = (
        not do_checkout
        or parsed_total is not None
        and parsed_total <= Decimal(str(args.max_total))
        and result.answer.place_order_visible
    )
    run_succeeded = not (
        not result.answer.success
        or not result.answer.authenticated
        or "david" not in result.answer.account_indicator.casefold()
        or not product_matches
        or result.answer.cart_quantity != 1
        or not checkout_valid
        or result.answer.place_order_clicked
        or missing_checkpoints
    )
    record_timing(
        "session-completed",
        outcome=str(result.outcome),
        success=run_succeeded,
    )
    if not run_succeeded:
        if missing_checkpoints:
            local_banner(
                f"{demo_session_id}: MISSING CHECKPOINTS: {', '.join(sorted(missing_checkpoints))}",
                LOCAL_FAILURE,
            )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
