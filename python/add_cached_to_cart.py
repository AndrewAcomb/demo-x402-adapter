#!/usr/bin/env python
"""Add the cheapest item from the newest cached catalog to McMaster's cart."""

from __future__ import annotations

import argparse
import base64
import functools
import json
import os
import re
import sys
import textwrap
import time
import traceback
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from threading import Lock

import httpx
from PIL import Image, ImageDraw, ImageFont

from hai_agents import Client
from pydantic import BaseModel, Field, field_validator

from email_2fa import ImapCodeReader
from h_browser_runtime import HBrowserRuntime, proxy_verification_instruction
from merchants import get_merchant
from sms_2fa import TwilioSmsReader
from structured_logging import console
from prepare_purchase import (
    LOCAL_FAILURE,
    LOCAL_SUCCESS,
    RUNTIME_SECRETS,
    enable_tee,
    local_banner,
    print_live_event,
)


ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "runtime"
LAST_SESSION_PATH = RUNTIME / "last-h-session.json"
DEFAULT_IDLE_TIMEOUT_SECONDS = 600
MAX_RESUME_AGE_SECONDS = 540


class CartResult(BaseModel):
    success: bool
    authenticated: bool
    account_indicator: str = Field(min_length=1)
    part_number: str | None = Field(
        default=None,
        description="Exact visible McMaster part number; null only when the cart is empty",
    )
    cart_quantity: int = Field(ge=0)
    observed_price: str | None = None
    merchandise_total: str | None = None
    shipping_total: str | None = None
    tax_total: str | None = None
    order_total: str | None = None
    place_order_visible: bool
    place_order_clicked: bool
    order_confirmed: bool = False
    order_number: str | None = None
    payment_display: str | None = None
    blocker: str | None = None
    final_url: str = Field(min_length=1)

    @field_validator("order_confirmed", mode="before")
    @classmethod
    def normalize_unconfirmed(cls, value: object) -> object:
        # H sometimes emits JSON null for an explicitly false purchase outcome.
        return False if value is None else value


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
    "initial-state": "00-initial-state",
    "cart-cleared": "01-cart-cleared",
    "product-in-cart": "02-product-in-cart",
    "place-order-review": "03-place-order-review",
    "order-confirmed": "04-order-confirmed",
}
CATALOG_TIMESTAMP = re.compile(r"^\d{3}-(\d{8}T\d{6}Z)-")


def newest_catalog(
    output_dir: Path, pattern: str = "*-mcmaster-screws.json"
) -> Path:
    catalogs = sorted(output_dir.glob(pattern))
    if not catalogs:
        raise FileNotFoundError(
            f"No cached catalogs matching {pattern!r} found in {output_dir}"
        )
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


def allocate_demo_request(
    sessions_dir: Path,
    resume_pointer: dict[str, object] | None,
) -> tuple[str, str, Path]:
    if resume_pointer is not None:
        demo_session_id = str(resume_pointer["demo_session_id"])
        artifact_dir = sessions_dir / demo_session_id
        if not artifact_dir.is_dir():
            raise RuntimeError(
                f"artifact directory for {demo_session_id} is missing"
            )
        request_number = int(resume_pointer.get("request_number", 1)) + 1
    else:
        demo_session_id, artifact_dir = mint_demo_session(sessions_dir)
        request_number = 1
    if request_number > 999:
        raise RuntimeError(f"request number for {demo_session_id} exceeded R999")
    return demo_session_id, f"R{request_number:03d}", artifact_dir


def choose_product(
    products: list[dict[str, object]],
    interactive: bool,
    selector: str | None = None,
    merchant_prefix: str = "mcmaster",
) -> dict[str, object]:
    if selector is not None:
        normalized = selector.removeprefix(f"{merchant_prefix}:").upper()
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


def stamp_provenance(
    path: Path,
    *,
    demo_session_id: str,
    request_id: str,
    h_session_id: str,
    context: str,
) -> None:
    """Add a lossless audit header without altering browser screenshot pixels."""
    timestamp = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    short_context = textwrap.shorten(context, width=110, placeholder="…")
    with Image.open(path) as source:
        image = source.convert("RGB")
    header_height = 108
    canvas = Image.new("RGB", (image.width, image.height + header_height), (44, 47, 54))
    canvas.paste(image, (0, header_height))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, image.width - 1, header_height - 1), fill=(44, 47, 54))
    draw.rectangle((0, 0, 11, header_height - 1), fill=(45, 212, 191))
    draw.line((11, header_height - 1, image.width, header_height - 1), fill=(82, 86, 96), width=1)
    font = ImageFont.load_default(size=23)
    bold_font = ImageFont.load_default(size=25)
    draw.text(
        (30, 16),
        f"{demo_session_id}  ·  {request_id}  ·  {timestamp}  ·  H {h_session_id}",
        font=font,
        fill=(226, 232, 240),
    )
    draw.text(
        (30, 58),
        short_context,
        font=bold_font,
        fill=(250, 204, 21),
    )
    canvas.save(path, format="PNG", optimize=True)


def write_private_json(path: Path, payload: dict[str, object]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def consume_resume_pointer(path: Path) -> dict[str, object]:
    if not path.is_file():
        raise RuntimeError("No warm H session pointer is available")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    finally:
        path.unlink(missing_ok=True)
    saved_at = datetime.fromisoformat(str(payload["saved_at"]))
    age_seconds = (datetime.now(UTC) - saved_at).total_seconds()
    if age_seconds < 0 or age_seconds > MAX_RESUME_AGE_SECONDS:
        raise RuntimeError(
            f"Warm H session pointer is {age_seconds:.0f}s old; maximum is "
            f"{MAX_RESUME_AGE_SECONDS}s"
        )
    return payload


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
        "--catalog-dir", type=Path, default=RUNTIME / "catalogs"
    )
    parser.add_argument(
        "--sessions-dir", type=Path, default=RUNTIME / "sessions"
    )
    parser.add_argument(
        "--log-file", type=Path, default=RUNTIME / "logs/app.log"
    )
    parser.add_argument(
        "--address-file", type=Path, default=RUNTIME / "private/addresses.json"
    )
    parser.add_argument(
        "--merchant",
        default="mcmaster",
        help="Registered merchant nickname (default: mcmaster)",
    )
    parser.add_argument("--max-total", type=float, default=100.0)
    parser.add_argument(
        "--order-id",
        help="Fulfillment order ID used only to correlate private run artifacts",
    )
    parser.add_argument(
        "--place-order",
        action="store_true",
        help="Irreversibly click Place Order after local SKU/quantity/total authorization",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Developer mode: reuse the last warm idle H session if still available",
    )
    parser.add_argument("--product", help="Catalog position, durable ID, or part number")
    parser.add_argument("--recipient", help="One-based address-book position")
    parser.add_argument("--interactive-product", action="store_true")
    parser.add_argument("--interactive-recipient", action="store_true")
    parser.add_argument("--no-reset", action="store_true")
    parser.add_argument("--reset-only", action="store_true")
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
    parser.add_argument(
        "--proxy", choices=("true", "false"), default="true"
    )
    parser.add_argument(
        "--h-environment", "--environment", dest="h_environment"
    )
    args = parser.parse_args()

    try:
        merchant = get_merchant(args.merchant)
    except KeyError as exc:
        parser.error(str(exc))
    is_mcmaster = merchant.kind == "mcmaster"

    resume_pointer: dict[str, object] | None = None
    if args.resume:
        if args.proxy != "true":
            parser.error(
                "--proxy cannot change an existing warm session; omit it when using --resume"
            )
        try:
            resume_pointer = consume_resume_pointer(LAST_SESSION_PATH)
        except Exception as exc:
            parser.error(f"cannot resume: {exc}")
        pointer_merchant = str(resume_pointer.get("merchant", "mcmaster"))
        if pointer_merchant != merchant.nickname:
            parser.error(
                f"warm session belongs to merchant {pointer_merchant!r}, "
                f"not {merchant.nickname!r}"
            )
    else:
        LAST_SESSION_PATH.unlink(missing_ok=True)

    do_add = not args.skip_add and not args.reset_only
    do_checkout = not args.skip_checkout and not args.reset_only
    do_reset = args.reset_only or do_add and not args.no_reset
    if not do_add and not do_checkout and not args.reset_only:
        parser.error("workflow must add a product, prepare checkout, or both")
    if args.place_order and not do_checkout:
        parser.error("--place-order requires checkout")

    catalog_path: Path | None = None
    product: dict[str, object] | None = None
    if do_add:
        catalog_path = newest_catalog(args.catalog_dir, merchant.catalog_glob())
        print(f"\n{describe_catalog(catalog_path)}", flush=True)
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        product = choose_product(
            catalog["products"],
            args.interactive or args.interactive_product,
            args.product,
            merchant_prefix=merchant.nickname,
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
        # Buyer identity belongs to the agent, not the address book: the
        # contact email is the inbox the agent reads and the phone is the
        # number it polls. Address-book values are a last-resort fallback.
        contact_email = (
            os.environ.get("BUYER_CONTACT_EMAIL")
            or os.environ.get("EMAIL_IMAP_USERNAME")
            or address.email
        )
        contact_phone = re.sub(
            r"\D", "", os.environ.get("TWILIO_SMS_NUMBER") or address.phone
        )[-10:]
        if not is_mcmaster:
            missing_contact = [
                label
                for label, value in (
                    ("recipient name (address book)", address.recipient_name),
                    ("contact email (BUYER_CONTACT_EMAIL/EMAIL_IMAP_USERNAME)", contact_email),
                    ("contact phone (TWILIO_SMS_NUMBER)", contact_phone),
                )
                if not value
            ]
            if missing_contact:
                parser.error(
                    f"guest checkout for {merchant.nickname} requires: "
                    f"{'; '.join(missing_contact)}"
                )
        address_payload = address.model_dump(mode="json")
        for field in ("street1", "street2", "postal_code", "email", "phone"):
            value = address_payload[field]
            if isinstance(value, str) and len(value) >= 5:
                RUNTIME_SECRETS.add(value)
        for value in (contact_email, contact_phone):
            if len(value) >= 5:
                RUNTIME_SECRETS.add(value)
    try:
        demo_session_id, request_id, artifact_dir = allocate_demo_request(
            args.sessions_dir, resume_pointer
        )
    except RuntimeError as exc:
        parser.error(f"cannot allocate request: {exc}")
    request_number = int(request_id.removeprefix("R"))
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

    record_timing("run-started", order_id=args.order_id)
    enable_tee(args.log_file, demo_session_id, request_id)
    part_number = str(product["part_number"]) if product is not None else None
    start_url = str(product["url"]) if product is not None else None
    if product is not None and catalog_path is not None:
        local_banner(
            f"{demo_session_id}: USING CACHE {catalog_path.name}; SELECTED {part_number} AT "
            f"{product['currency']} {product['package_price']:.2f}",
            component="AddCart",
        )
    local_banner(
        f"{demo_session_id}: ARTIFACTS WILL BE SAVED UNDER {artifact_dir.resolve()}",
        component="CartFlow",
        console_text="",
        console_link=(f"{demo_session_id} artifacts", str(artifact_dir.resolve())),
    )

    email = os.environ.get("MCMASTER_EMAIL")
    password = os.environ.get("MCMASTER_PASSWORD")
    if is_mcmaster and (not email or not password):
        parser.error("MCMASTER_EMAIL and MCMASTER_PASSWORD must be set")
    for credential in (email, password):
        if credential:
            RUNTIME_SECRETS.add(credential)
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
        for value in payment.values():
            if value:
                RUNTIME_SECRETS.add(str(value))
        assert address is not None
        card_name = os.environ.get("CHECKOUT_CARD_NAME", address.recipient_name)
        RUNTIME_SECRETS.add(card_name)
        for value in address_payload.values():
            if isinstance(value, str) and value:
                RUNTIME_SECRETS.add(value)

    client = Client()
    tools = []
    tool_audit_path = artifact_dir / f"{artifact_prefix}-local-tools.jsonl"

    def append_tool_audit(record: dict[str, object]) -> None:
        with tool_audit_path.open("a", encoding="utf-8") as audit_file:
            audit_file.write(json.dumps(record, separators=(",", ":")) + "\n")
            audit_file.flush()
        tool_audit_path.chmod(0o600)

    def audit_tool(function):
        """Record every local H callback, preserving its SDK-visible signature."""
        @functools.wraps(function)
        def audited(*tool_args, **tool_kwargs):
            tool_name = function.__name__
            record_timing("local-tool-started", tool=tool_name, order_id=args.order_id)
            base_record = {
                "recorded_at": datetime.now(UTC).isoformat(),
                "demo_session_id": demo_session_id,
                "request_id": request_id,
                "order_id": args.order_id,
                "tool": tool_name,
            }
            append_tool_audit({**base_record, "outcome": "started"})
            try:
                value = function(*tool_args, **tool_kwargs)
            except Exception as exc:
                safe_traceback = redact_secrets(traceback.format_exc())
                record = {
                    "recorded_at": datetime.now(UTC).isoformat(),
                    "demo_session_id": demo_session_id,
                    "request_id": request_id,
                    "order_id": args.order_id,
                    "tool": tool_name,
                    "outcome": "error",
                    "error_type": type(exc).__name__,
                    "traceback": safe_traceback,
                }
                append_tool_audit(record)
                record_timing(
                    "local-tool-failed",
                    tool=tool_name,
                    order_id=args.order_id,
                    error_type=type(exc).__name__,
                )
                raise
            record = {
                "recorded_at": datetime.now(UTC).isoformat(),
                "demo_session_id": demo_session_id,
                "request_id": request_id,
                "order_id": args.order_id,
                "tool": tool_name,
                "outcome": "success",
            }
            append_tool_audit(record)
            record_timing("local-tool-succeeded", tool=tool_name, order_id=args.order_id)
            return value

        return audited
    latest_image: dict[str, object] | None = None
    latest_image_index = 0
    image_lock = Lock()
    captured_checkpoints: set[str] = set()
    reviewed_part_number: str | None = None
    reviewed_quantity: int | None = None
    reviewed_total: Decimal | None = None
    purchase_authorized = False
    authorized_part_number: str | None = None
    authorized_total: Decimal | None = None
    context_parts = [
        merchant.nickname.upper(),
        "RESUME" if resume_pointer is not None else "NEW",
        "CART",
    ]
    if do_reset:
        context_parts.append("RESET")
    elif do_add:
        context_parts.append("NORESET")
    if do_add and part_number is not None:
        context_parts.append(f"ADD {part_number}")
    if do_checkout:
        context_parts.append("CHECKOUT")
    if args.place_order:
        context_parts.append("PLACE ORDER")
    workflow_context = "  ·  ".join(context_parts)

    def capture_checkout_checkpoint(
        checkpoint: str,
        visible_part_number: str | None = None,
        visible_quantity: int | None = None,
        visible_total_usd: float | None = None,
    ) -> str:
        """Save the current browser screenshot at a named checkout checkpoint."""
        nonlocal latest_image, latest_image_index
        nonlocal reviewed_part_number, reviewed_quantity, reviewed_total
        if checkpoint not in CHECKPOINTS:
            allowed = ", ".join(CHECKPOINTS)
            raise ValueError(f"Unknown checkpoint {checkpoint!r}; expected one of: {allowed}")
        # The SDK's wait loop is the sole event-stream consumer and executes
        # this callback. Fetch the latest already-recorded observation here;
        # running a second live stream raced the wait loop and could strand a
        # pending custom-tool call until the H session timed out.
        changes = client.sessions.get_session_changes(
            session.id,
            from_index=0,
            limit=None,
            include_events=True,
            wait_for_seconds=0,
        )
        for image_index, event in enumerate(changes.new_events or [] if changes else []):
            payload = event.model_dump(mode="json")
            data = payload.get("data") or {}
            if data.get("kind") == "observation_event" and data.get("image"):
                latest_image = data["image"]
                latest_image_index = image_index
        with image_lock:
            image = latest_image
            image_index = latest_image_index
        if image is None:
            local_banner(
                f"{demo_session_id}: CHECKPOINT {checkpoint} FAILED — NO SCREENSHOT",
                LOCAL_FAILURE,
                component="Screenshot",
            )
            raise RuntimeError("No browser screenshot is available for this checkpoint")
        if checkpoint == "place-order-review":
            if (
                not visible_part_number
                or visible_quantity is None
                or visible_total_usd is None
            ):
                raise RuntimeError(
                    "Review checkpoint requires visible part number, quantity, and total"
                )
            normalized_part = visible_part_number.strip().upper()
            if part_number is not None and normalized_part != part_number.upper():
                raise RuntimeError("Review part number does not match selected product")
            if visible_quantity != 1:
                raise RuntimeError("Review package quantity must be exactly 1")
            total = Decimal(str(visible_total_usd))
            if total <= 0 or total > Decimal(str(args.max_total)):
                raise RuntimeError(
                    f"Review total is outside the authorized USD 0-{args.max_total:.2f} range"
                )
            reviewed_part_number = normalized_part
            reviewed_quantity = visible_quantity
            reviewed_total = total
        elif any(
            value is not None
            for value in (visible_part_number, visible_quantity, visible_total_usd)
        ):
            raise RuntimeError("Visible order facts belong only on the review checkpoint")
        path = artifact_dir / f"{artifact_prefix}-{CHECKPOINTS[checkpoint]}.png"
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
        record_timing(
            checkpoint,
            artifact=path.name,
            image_event_index=image_index,
            **(
                {
                    "part_number": reviewed_part_number,
                    "quantity": reviewed_quantity,
                    "total_usd": float(reviewed_total),
                }
                if checkpoint == "place-order-review" and reviewed_total is not None
                else {}
            ),
        )
        local_banner(
            f"{demo_session_id}: SAVED CHECKPOINT {checkpoint} TO {path.resolve()}",
            LOCAL_SUCCESS,
            component="Screenshot",
            console_text="📸",
            console_link=(f"{checkpoint.replace('-', ' ')} screenshot", str(path)),
        )
        return f"Saved {checkpoint} checkpoint for {demo_session_id}"

    tools.append(audit_tool(capture_checkout_checkpoint))

    if args.place_order:

        def authorize_place_order(
            visible_part_number: str,
            visible_quantity: int,
            visible_total_usd: float,
        ) -> str:
            """Authorize one Place Order click after validating visible order facts."""
            nonlocal purchase_authorized, authorized_part_number, authorized_total
            if purchase_authorized:
                raise RuntimeError("Place Order was already authorized once")
            if "place-order-review" not in captured_checkpoints:
                raise RuntimeError(
                    "Place Order cannot be authorized before the review checkpoint"
                )
            normalized_part = visible_part_number.upper()
            if (
                reviewed_part_number is None
                or reviewed_quantity is None
                or reviewed_total is None
            ):
                raise RuntimeError("Verified review facts are unavailable")
            if normalized_part != reviewed_part_number:
                raise RuntimeError("Authorization part number does not match verified review")
            if visible_quantity != reviewed_quantity:
                raise RuntimeError("Authorization quantity does not match verified review")
            total = Decimal(str(visible_total_usd))
            if total != reviewed_total:
                raise RuntimeError("Authorization total does not match verified review")
            purchase_authorized = True
            authorized_part_number = normalized_part
            authorized_total = total
            record_timing(
                "place-order-authorized",
                part_number=normalized_part,
                quantity=visible_quantity,
                total_usd=float(total),
            )
            local_banner(
                f"{demo_session_id}: AUTHORIZED ONE PLACE ORDER CLICK FOR "
                f"{normalized_part} AT USD {total:.2f}",
                LOCAL_SUCCESS,
                component="Purchase",
            )
            return "AUTHORIZED: click Place Order exactly once, then verify confirmation"

        tools.append(audit_tool(authorize_place_order))
    reader = ImapCodeReader.from_env()
    if (
        reader is not None
        and not is_mcmaster
        and os.environ.get("EMAIL_2FA_SENDER_FILTER") is None
    ):
        # Guest checkouts get codes from arbitrary senders (Toast, Square, …);
        # the new-mail UID baseline is the real filter.
        reader.sender_filter = ""
    if reader is not None:
        local_banner("CONNECTING TO PRIVATE EMAIL OVER IMAP", component="Email2FA", console_text="")
        reader.establish_baseline()
        local_banner(
            "IMAP READY — NEW-MESSAGE BASELINE RECORDED",
            LOCAL_SUCCESS,
            component="Email2FA",
            console_text="",
        )

        def wait_for_email_2fa_code(timeout_seconds: int = 180) -> str:
            """Wait for a new McMaster email and return its verification code."""
            local_banner(
                f"H CALLED EMAIL TOOL — POLLING ({timeout_seconds}s timeout)",
                component="Email2FA",
                console_text="🔐 waiting for emailed verification code…",
            )
            try:
                code = reader.wait_for_code(timeout_seconds)
                RUNTIME_SECRETS.add(code)
                local_banner(
                    "2FA CODE EXTRACTED — RETURNING IT TO H",
                    LOCAL_SUCCESS,
                    component="Email2FA",
                    console_text="🔐 code delivered to H",
                )
                return code
            except Exception:
                local_banner(
                    "EMAIL 2FA TOOL FAILED", LOCAL_FAILURE, component="Email2FA"
                )
                raise

        tools.append(audit_tool(wait_for_email_2fa_code))

    if not is_mcmaster:

        def wait_for_operator_sms_code() -> str:
            """Ask the human operator to type in an SMS verification code."""
            local_banner(
                f"{demo_session_id}: H NEEDS THE SMS CODE — TYPE IT BELOW",
                component="SMS2FA",
                console_text="⌨️  H is waiting for the SMS code from your phone",
            )
            console.pause()
            terminal = sys.__stdout__
            terminal.write("\nEnter the SMS verification code for H: ")
            terminal.flush()
            code = sys.stdin.readline().strip()
            console.resume()
            if not code:
                raise RuntimeError("Operator entered an empty code")
            RUNTIME_SECRETS.add(code)
            local_banner(
                f"{demo_session_id}: OPERATOR CODE DELIVERED — H RESUMING",
                LOCAL_SUCCESS,
                component="SMS2FA",
            )
            return code

        tools.append(audit_tool(wait_for_operator_sms_code))

    sms_reader = TwilioSmsReader.from_env() if not is_mcmaster else None
    if sms_reader is not None:
        local_banner(
            f"CONNECTING TO AGENT PHONE NUMBER {sms_reader.number} VIA TWILIO",
            component="SMS2FA",
            console_text="",
        )
        sms_reader.establish_baseline()
        local_banner(
            "TWILIO READY — NEW-MESSAGE BASELINE RECORDED",
            LOCAL_SUCCESS,
            component="SMS2FA",
            console_text="",
        )

        def wait_for_sms_2fa_code(timeout_seconds: int = 180) -> str:
            """Wait for a new SMS to the agent's phone number and return its code."""
            local_banner(
                f"H CALLED SMS TOOL — POLLING TWILIO ({timeout_seconds}s timeout)",
                component="SMS2FA",
                console_text="🔐 agent reading the SMS code off its own phone…",
            )
            try:
                code = sms_reader.wait_for_code(timeout_seconds)
                RUNTIME_SECRETS.add(code)
                local_banner(
                    "SMS CODE EXTRACTED — RETURNING IT TO H",
                    LOCAL_SUCCESS,
                    component="SMS2FA",
                    console_text="🔐 code delivered to H",
                )
                return code
            except Exception:
                local_banner(
                    "SMS 2FA TOOL FAILED", LOCAL_FAILURE, component="SMS2FA"
                )
                raise

        tools.append(audit_tool(wait_for_sms_2fa_code))

    browser_runtime = HBrowserRuntime.resolve(client, args.h_environment)
    proxy_instruction = (
        proxy_verification_instruction() if args.verify_proxy else ""
    )

    required_checkpoints: set[str] = {"initial-state"}
    if do_reset:
        required_checkpoints.add("cart-cleared")
        if is_mcmaster:
            reset_instruction = """
Go to https://www.mcmaster.com/Order/ and DELETE EVERY existing line item.
Continue until the cart is visibly empty, then call
capture_checkout_checkpoint(checkpoint="cart-cleared").
""".strip()
        else:
            reset_instruction = f"""
Open the ordering page {merchant.start_url}. If the site shows a cart
holding any items, remove every item until the cart is visibly empty. If
the cart is already empty or no cart indicator exists yet, that satisfies
this step. Then call capture_checkout_checkpoint(checkpoint="cart-cleared").
""".strip()
    else:
        reset_instruction = (
            "Do not clear or delete the existing cart. This workflow explicitly disabled reset."
        )

    if do_add:
        assert product is not None and start_url is not None and part_number is not None
        required_checkpoints.add("product-in-cart")
        if is_mcmaster:
            add_instruction = f"""
Open only the direct cached URL {start_url} for durable part {part_number}:
{product['description']}. Do not search or browse other products. Verify the
page is exactly part {part_number}, add exactly one package, then return to the
order page. Verify the cart contains part {part_number} with quantity 1. If
checkout is also requested, the cart must contain exactly this one line. Call
capture_checkout_checkpoint(checkpoint="product-in-cart").
""".strip()
        else:
            section = str(product.get("section") or "").strip()
            options = str(product.get("options") or "").strip()
            section_hint = f' in menu section "{section}"' if section else ""
            option_hint = (
                f' If the item requires a choice, select: {options}.'
                if options
                else " If the item unexpectedly requires a choice, pick the cheapest option."
            )
            add_instruction = f"""
On the ordering page {start_url}, locate the exact menu item
"{part_number}"{section_hint}, expected price around
{product['currency']} {float(product['package_price']):.2f}. Do not browse
other items.{option_hint} Add exactly one to the cart. Verify the cart
contains exactly this one item with quantity 1. Call
capture_checkout_checkpoint(checkpoint="product-in-cart").
""".strip()
    elif do_checkout:
        add_instruction = """
Do not add or remove products. Verify the existing cart contains exactly one
line item with quantity 1 and record its exact part number.
""".strip()
    else:
        add_instruction = "Do not add any products after clearing the cart."

    if do_checkout:
        required_checkpoints.add("place-order-review")
        if is_mcmaster:
            mcmaster_ship_to = {
                key: value
                for key, value in address_payload.items()
                if value and key not in ("email", "phone")
            }
            checkout_instruction = f"""
Fill the delivery address exactly as follows:
{json.dumps(mcmaster_ship_to)}
This site is signed in to the buyer's own account: contact email and
phone are account-level, already configured, and possibly read-only. Do
NOT edit, fill, or clear any contact/confirmation email or phone field.
Use standard delivery and use the selected recipient name and delivery address
for billing too. Fill payment with card number
{payment['CHECKOUT_CARD_NUMBER']}, expiration
{payment['CHECKOUT_CARD_EXP_MONTH']}/{payment['CHECKOUT_CARD_EXP_YEAR']}, CVV
{payment['CHECKOUT_CARD_CVV']}, and cardholder name {card_name}.

Let shipping, tax, and total recalculate. If total exceeds USD
{args.max_total:.2f}, return success=false and stop. The target is the Current
Order review with the item, delivery summary, masked payment, totals, and green
PLACE ORDER button visible. ABSOLUTELY DO NOT CLICK PLACE ORDER. Call
capture_checkout_checkpoint(checkpoint="place-order-review",
visible_part_number="<exact visible part number>", visible_quantity=1,
visible_total_usd=<final numeric USD total>) before answering.
""".strip()
        else:
            assert address is not None
            ship_to = {
                key: address_payload[key]
                for key in (
                    "recipient_name",
                    "company",
                    "street1",
                    "street2",
                    "city",
                    "state",
                    "postal_code",
                    "country",
                )
                if address_payload.get(key)
            }
            fulfillment_instruction = (
                "Choose Pickup with the earliest available time."
                if merchant.fulfillment == "pickup"
                else (
                    "Choose Delivery. Fill the delivery address EXACTLY as "
                    f"follows, reading each field back after typing: {json.dumps(ship_to)}"
                )
            )
            checkout_instruction = f"""
Open the cart and proceed to checkout as a GUEST; never sign in or create
an account. {fulfillment_instruction}
Fill contact details: name {address.recipient_name} and phone {contact_phone}.
CONTACT EMAIL: if the email field is already populated with any valid email
address, LEAVE IT UNCHANGED and move on — do not click, clear, or retype it
(it is bound to the signed-in account and may revert). Only type
{contact_email} if the email field is empty.
NEVER interact with the same field more than twice: if a field still shows the
same value after two attempts, treat it as final, accept it, and continue —
do not keep clicking or retyping it.

PHONE FIELD TECHNIQUE — this site's phone mask SWALLOWS THE FIRST
KEYSTROKE, so follow this exact sequence:
1. Click the field, then clear it completely with select-all (cmd+a or
   ctrl+a) followed by ONE backspace. A leftover "+1" prefix is fine.
2. Type ONLY the first digit, {contact_phone[0]}, and read back whether
   it appeared after the +1. If it did not appear, type it once more
   until exactly one {contact_phone[0]} shows.
3. Then type the remaining nine digits: {contact_phone[1:]}.
4. Read back: the field must contain the digits {contact_phone} in
   order (mask punctuation like parentheses is fine).
5. If wrong, clear fully as in step 1 and repeat from step 2. NEVER
   delete one character at a time.
Apply the same read-back-and-verify habit to every text field you fill.

If a tip is requested, set it to zero if possible,
otherwise the minimum. Fill payment with card number
{payment['CHECKOUT_CARD_NUMBER']}, expiration
{payment['CHECKOUT_CARD_EXP_MONTH']}/{payment['CHECKOUT_CARD_EXP_YEAR']}, CVV
{payment['CHECKOUT_CARD_CVV']}, and cardholder name {card_name}.

If the final total exceeds USD {args.max_total:.2f}, return success=false
and stop. The target state is the final review/payment step with the order
summary, totals, and the Place Order (or Pay) button visible. ABSOLUTELY DO
NOT CLICK THAT BUTTON. Call
capture_checkout_checkpoint(checkpoint="place-order-review",
visible_part_number="<exact visible item name>", visible_quantity=1,
visible_total_usd=<final numeric USD total>) before answering.
""".strip()
        if args.place_order:
            required_checkpoints.add("order-confirmed")
            item_word = "part number" if is_mcmaster else "item name"
            confirmation_word = (
                "visible order number"
                if is_mcmaster
                else "visible order/confirmation number, or the exact visible "
                "confirmation heading if no number is shown"
            )
            answer_instruction = f"""
PURCHASE IS EXPLICITLY ENABLED FOR THIS RUN. Only after saving the review
checkpoint, call authorize_place_order with the exact visible {item_word}
(as visible_part_number), quantity, and final numeric USD total. If
authorization fails, stop. If it returns AUTHORIZED, click the Place Order
(or Pay) button exactly once. Wait for an explicit successful order
confirmation. Then call
capture_checkout_checkpoint(checkpoint="order-confirmed"). Return
place_order_clicked=true, order_confirmed=true, and the {confirmation_word}
as order_number. Never retry or click the button a second time.
""".strip()
        else:
            answer_instruction = """
Return success=true only if the Place Order (or Pay) button is visible and
untouched. Set place_order_clicked=false. payment_display may include only
brand/last four.
""".strip()
    elif do_add:
        checkout_instruction = """
Stop after viewing and checkpointing the product in the cart. Do not fill
delivery, billing, or payment fields and do not click PLACE ORDER.
""".strip()
        answer_instruction = """
Return success=true after the requested cart state is visibly verified. Set
place_order_visible=false and place_order_clicked=false.
""".strip()
    else:
        checkout_instruction = """
Stop after viewing and checkpointing the empty cart. Do not add products or
fill delivery, billing, or payment fields and do not click PLACE ORDER.
""".strip()
        answer_instruction = """
Return success=true after the empty cart is visibly verified. Return
part_number=null, cart_quantity=0, place_order_visible=false, and
place_order_clicked=false.
""".strip()

    if sms_reader is not None:
        sms_code_instruction = (
            "If the site hard-requires a code it sent by SMS, call "
            "wait_for_sms_2fa_code (the agent owns that phone number). If that "
            "times out, call wait_for_operator_sms_code as a fallback."
        )
    else:
        sms_code_instruction = (
            "If the site hard-requires a code it sent by SMS, call "
            "wait_for_operator_sms_code (a human reads it off the phone; allow "
            "up to two minutes)."
        )
    if is_mcmaster:
        identity_instruction = f"""
This is ONE composable cart workflow session. If necessary, log in with email
{email} and password {password}. Never echo credentials, address, or payment
data. Use wait_for_email_2fa_code if requested. Confirm the account is David.
""".strip()
    else:
        identity_instruction = f"""
This is ONE composable cart workflow session on {merchant.display_name}
({merchant.start_url}). Order as a GUEST; never sign in or create an
account. Never echo contact, address, or payment data. In the structured
answer, return authenticated=false and account_indicator="guest".

CHECKPOINTS ARE MANDATORY: every ACTION section below ends with its
capture_checkout_checkpoint call. Call each one at the moment its state
is visible, even if a step turned out to be trivial (for example the
cart was already empty, or the item was already present). A missing
checkpoint fails the entire run even if the order succeeds.

VERIFICATION CODES: first look for any option to skip verification or
continue without it. {sms_code_instruction} Only use
wait_for_email_2fa_code when the site says it emailed a code. If
verification still fails, stop and report the exact blocker text.
""".strip()

    workflow_message = f"""
{proxy_instruction}

{identity_instruction}

INITIAL AUDIT — DO THIS BEFORE ANY OTHER BROWSER ACTION:
Allow the current page to render, but do not navigate, click, type, clear the
cart, or change any field. Immediately call
capture_checkout_checkpoint(checkpoint="initial-state") to preserve the exact
browser state inherited by this invocation, especially after --resume.

RESET ACTION:
{reset_instruction}

ADD ACTION:
{add_instruction}

CHECKOUT ACTION:
{checkout_instruction}

{answer_instruction}

FIELD-EDIT LIMIT: never attempt to edit the same field more than twice.
If a field will not accept your input (read-only, auto-reverting, or
validation-locked) after two attempts, leave it as it is, continue with
the workflow if possible, and describe the field in your final notes —
looping on one field is always the wrong choice.

STRUCTURED ANSWER REQUIREMENTS:
When the cart contains an item, part_number must be its exact visible
{"McMaster part number" if is_mcmaster else "item name"}; use null only for a
visibly empty cart. All boolean fields, including order_confirmed, must be
true or false, never null.
""".strip()
    stream_from_index = 0
    if resume_pointer is not None:
        h_session_id = str(resume_pointer["h_session_id"])
        try:
            session = browser_runtime.attach_idle_session(client, h_session_id)
        except RuntimeError as exc:
            parser.error(f"cannot resume: {exc}")
        event_page = client.sessions.list_session_events(
            h_session_id, page=1, size=1
        )
        stream_from_index = event_page.total
        session.send_message(workflow_message)
        local_banner(
            f"{demo_session_id}: RESUMED WARM H SESSION {h_session_id}",
            LOCAL_SUCCESS,
            component="Resume",
        )
        record_timing(
            "h-session-resumed",
            h_session_id=h_session_id,
            previous_demo_session_id=resume_pointer.get("demo_session_id"),
        )
    else:
        session = browser_runtime.start_session(
            client,
            start_url=(
                "https://api.ipify.org?format=json"
                if args.verify_proxy
                else "https://www.mcmaster.com/Order/"
                if is_mcmaster
                else merchant.start_url
            ),
            network={} if args.proxy == "false" else None,
            answer_schema=CartResult,
            tools=tools,
            messages=workflow_message,
            max_steps=80 if is_mcmaster else 90,
            max_time_s=480 if is_mcmaster else 900,
            idle_timeout_s=DEFAULT_IDLE_TIMEOUT_SECONDS,
        )
    snapshot = session.get()
    if resume_pointer is None:
        record_timing("h-session-created", h_session_id=session.id)
    print(f"Demo session: {demo_session_id}", flush=True)
    print(f"H session: {session.id}", flush=True)
    print(f"H Agent View: {snapshot.agent_view_url}", flush=True)
    console.key(
        f"{demo_session_id} · H session {session.id[:8]} started",
        link_label="watch live agent view",
        link_target=snapshot.agent_view_url,
    )
    if args.place_order:
        local_banner(
            "STREAMING COMPOSABLE CART WORKFLOW — PLACE ORDER IS EXPLICITLY ENABLED",
            component="Purchase",
        )
    else:
        local_banner(
            "STREAMING COMPOSABLE CART WORKFLOW — PLACE ORDER IS FORBIDDEN",
            component="CartFlow",
        )

    def export_h_status() -> tuple[object, str]:
        status_snapshot = session.status()
        final_status = str(status_snapshot.status)
        status_payload = (
            status_snapshot.model_dump(mode="json")
            if hasattr(status_snapshot, "model_dump")
            else {"status": final_status}
        )
        write_private_json(
            artifact_dir / f"{artifact_prefix}-h-status.json",
            {
                "demo_session_id": demo_session_id,
                "request_id": request_id,
                "order_id": args.order_id,
                "h_session_id": session.id,
                "status": redact_secrets(status_payload),
            },
        )
        return status_snapshot, final_status

    h_events_path = artifact_dir / f"{artifact_prefix}-h-events.jsonl"

    def export_h_events(events) -> None:
        with h_events_path.open("w", encoding="utf-8") as events_file:
            for event in events:
                payload = event.model_dump(mode="json")
                safe_payload = redact_secrets(payload)
                events_file.write(json.dumps(safe_payload, separators=(",", ":")) + "\n")
        h_events_path.chmod(0o600)

    try:
        # One polling owner must both observe pending tool calls and post their
        # results. A concurrent session.stream() consumer could advance past a
        # call before this waiter saw it, which is what stranded S017.
        result = session.wait_for_completion(
            from_index=stream_from_index,
            timeout_seconds=510 if is_mcmaster else 960,
            tools=tools,
            answer_schema=CartResult,
        )
        export_h_events(result.events)
        for event in result.events:
            print_live_event(event)
        status_snapshot, final_status = export_h_status()
    except Exception as exc:
        record_timing(
            "session-completed",
            outcome="error",
            success=False,
            error_type=type(exc).__name__,
        )
        try:
            changes = client.sessions.get_session_changes(
                session.id,
                from_index=0,
                limit=None,
                include_events=True,
                wait_for_seconds=0,
            )
            export_h_events(changes.new_events or [] if changes else [])
            export_h_status()
        except Exception as status_exc:  # noqa: BLE001 - preserve original failure
            record_timing(
                "h-status-export-failed", error_type=type(status_exc).__name__
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
                f"{demo_session_id}: SAVED FALLBACK FINAL STATE TO {final_state_path.resolve()}",
                LOCAL_FAILURE,
                component="Screenshot",
            )
        except Exception as exc:
            local_banner(
                f"SCREENSHOT DOWNLOAD FAILED: {exc}",
                LOCAL_FAILURE,
                component="Screenshot",
            )

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
    output["merchant"] = merchant.nickname
    output["demo_session_id"] = demo_session_id
    output["request_id"] = request_id
    output["h_session_id"] = session.id
    output["captured_checkpoints"] = sorted(captured_checkpoints)
    if reviewed_part_number is not None:
        output["part_number"] = reviewed_part_number
        output["review_facts"] = {
            "part_number": reviewed_part_number,
            "quantity": reviewed_quantity,
            "total_usd": float(reviewed_total) if reviewed_total is not None else None,
        }
    result_path = artifact_dir / f"{artifact_prefix}-result.json"
    result_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    result_path.chmod(0o600)
    print(json.dumps(output, indent=2), flush=True)
    parsed_total = parse_usd(result.answer.order_total)
    effective_part_number = result.answer.part_number or reviewed_part_number
    effective_total = parsed_total or reviewed_total
    product_matches = (
        not do_add
        or part_number is not None
        and effective_part_number is not None
        and effective_part_number.upper() == part_number.upper()
    )
    if args.place_order:
        purchase_state_valid = (
            purchase_authorized
            and result.answer.place_order_clicked
            and result.answer.order_confirmed
            and bool(result.answer.order_number)
            and effective_part_number is not None
            and authorized_part_number == effective_part_number.upper()
            and authorized_total == effective_total
        )
    else:
        purchase_state_valid = (
            not result.answer.place_order_clicked
            and not result.answer.order_confirmed
            and (not do_checkout or result.answer.place_order_visible)
        )
    checkout_valid = (
        not do_checkout
        or effective_total is not None
        and effective_total <= Decimal(str(args.max_total))
    )
    if args.reset_only:
        quantity_valid = result.answer.cart_quantity == 0
    elif args.place_order and result.answer.order_confirmed:
        # A confirmed order legitimately empties the cart on the
        # confirmation page; either report is honest.
        quantity_valid = result.answer.cart_quantity in (0, 1)
    else:
        quantity_valid = result.answer.cart_quantity == 1
    run_succeeded = not (
        not result.answer.success
        or (
            is_mcmaster
            and (
                not result.answer.authenticated
                or "david" not in result.answer.account_indicator.casefold()
            )
        )
        or not product_matches
        or not quantity_valid
        or not purchase_state_valid
        or not checkout_valid
        or missing_checkpoints
    )
    record_timing(
        "session-completed",
        outcome=str(result.outcome),
        success=run_succeeded,
    )
    verdict_parts = []
    if result.answer.part_number:
        verdict_parts.append(result.answer.part_number)
    if result.answer.order_total:
        verdict_parts.append(f"total {result.answer.order_total}")
    if result.answer.order_number:
        verdict_parts.append(f"order {result.answer.order_number}")
    verdict_detail = " · ".join(verdict_parts) or f"outcome {result.outcome}"
    console.key(
        ("✓ SUCCESS · " if run_succeeded else "✗ FAILED · ") + verdict_detail
    )
    # An idle session is resumable regardless of verdict — a failed run
    # (budget exhausted one field from the finish) is exactly when
    # `--resume` is most valuable.
    if final_status == "idle":
        saved_at = datetime.now(UTC)
        write_private_json(
            LAST_SESSION_PATH,
            {
                "h_session_id": session.id,
                "merchant": merchant.nickname,
                "demo_session_id": demo_session_id,
                "request_number": request_number,
                "request_id": request_id,
                "saved_at": saved_at.isoformat(),
                "resumable_until": (
                    saved_at + timedelta(seconds=MAX_RESUME_AGE_SECONDS)
                ).isoformat(),
                "idle_timeout_seconds": DEFAULT_IDLE_TIMEOUT_SECONDS,
                "run_succeeded": run_succeeded,
                "phase": (
                    "order-confirmed"
                    if args.place_order and result.answer.order_confirmed
                    else "place-order-review"
                    if do_checkout
                    else "cart-cleared"
                    if args.reset_only
                    else "product-in-cart"
                ),
                "agent_view_url": snapshot.agent_view_url,
            },
        )
        local_banner(
            f"{demo_session_id}: SAVED WARM H SESSION POINTER FOR --resume",
            LOCAL_SUCCESS,
            component="Resume",
            console_text="",
        )
    else:
        LAST_SESSION_PATH.unlink(missing_ok=True)
        local_banner(
            f"{demo_session_id}: H SESSION ENDED AS {final_status!r}; NOT RESUMABLE",
            LOCAL_FAILURE,
            component="Resume",
            console_text="",
        )
    if not run_succeeded:
        if missing_checkpoints:
            local_banner(
                f"{demo_session_id}: MISSING CHECKPOINTS: {', '.join(sorted(missing_checkpoints))}",
                LOCAL_FAILURE,
                component="Error",
            )
        console.stop()
        raise SystemExit(1)
    console.stop()


if __name__ == "__main__":
    main()
