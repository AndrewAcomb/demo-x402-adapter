"""Empty the authenticated McMaster cart and save screenshot proof."""

from __future__ import annotations

import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

from hai_agents import Client
from pydantic import BaseModel, Field

from add_cached_to_cart import save_image
from email_2fa import ImapCodeReader
from h_browser_runtime import HBrowserRuntime
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


class ResetResult(BaseModel):
    success: bool
    authenticated: bool
    account_indicator: str = Field(min_length=1)
    remaining_line_items: int = Field(ge=0)
    blocker: str | None = None
    final_url: str = Field(min_length=1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Empty the McMaster cart and stop.")
    parser.add_argument(
        "--output-dir", type=Path, default=RUNTIME / "sessions"
    )
    parser.add_argument(
        "--log-file", type=Path, default=RUNTIME / "logs/fetch-products.log"
    )
    parser.add_argument(
        "--verify-proxy",
        action="store_true",
        help="Verify the expected public proxy IP before opening McMaster",
    )
    parser.add_argument("--proxy", choices=("true", "false"), default="true")
    parser.add_argument(
        "--h-environment", "--environment", dest="h_environment"
    )
    args = parser.parse_args()
    enable_tee(args.log_file)

    email = os.environ.get("MCMASTER_EMAIL")
    password = os.environ.get("MCMASTER_PASSWORD")
    if not email or not password:
        parser.error("MCMASTER_EMAIL and MCMASTER_PASSWORD must be set")

    client = Client()
    tools = []
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

    browser_runtime = HBrowserRuntime.resolve(client, args.h_environment)
    proxy_instruction = ""
    if args.verify_proxy:
        proxy_instruction = """
First inspect the current api.ipify.org JSON and verify the public IP is exactly
54.71.20.137. If it differs, stop with success=false and report proxy failure.
""".strip()
    session = browser_runtime.start_session(
        client,
        start_url=(
            "https://api.ipify.org?format=json"
            if args.verify_proxy
            else "https://www.mcmaster.com/Order/"
        ),
        network={} if args.proxy == "false" else None,
        answer_schema=ResetResult,
        tools=tools,
        messages=f"""
{proxy_instruction}

Then go directly to https://www.mcmaster.com/Order/. If necessary, log in using
email {email} and password {password}; never echo either credential. If email
verification is requested, call wait_for_email_2fa_code and enter its result
without echoing it. Confirm the account indicator visibly says David.

Delete EVERY line item from the current order/cart, one at a time. Handle any
confirmation dialogs. Continue until the cart visibly has zero line items and
is clearly empty. Stop there. Do not add products, begin checkout, enter address
or payment data, or click Place Order.

Return success=true only after visually verifying the cart is empty, with
remaining_line_items=0 and final_url set to the visible cart URL.
""".strip(),
        max_steps=30,
        max_time_s=300,
    )
    snapshot = session.get()
    print(f"H session: {session.id}", flush=True)
    print(f"H Agent View: {snapshot.agent_view_url}", flush=True)
    local_banner("STREAMING CART RESET")

    latest_image: dict[str, object] | None = None
    with ThreadPoolExecutor(max_workers=1) as executor:
        waiter = executor.submit(
            session.wait_for_completion, timeout_seconds=330, tools=tools
        )
        for event in session.stream():
            print_live_event(event)
            payload = event.model_dump(mode="json")
            data = payload.get("data") or {}
            if data.get("kind") == "observation_event" and data.get("image"):
                latest_image = data["image"]
        result = waiter.result()

    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    proof_path = args.output_dir / f"{timestamp}-mcmaster-cart-empty.png"
    if latest_image is not None:
        try:
            save_image(latest_image, proof_path)
            local_banner(f"SAVED EMPTY-CART PROOF TO {proof_path.resolve()}", LOCAL_SUCCESS)
        except Exception as exc:
            local_banner(f"SCREENSHOT DOWNLOAD FAILED: {exc}", LOCAL_FAILURE)
    else:
        local_banner("NO SCREENSHOT WAS PRESENT IN THE H EVENT STREAM", LOCAL_FAILURE)

    if result.answer is None:
        raise SystemExit("H returned no structured reset result")
    print(json.dumps(result.answer.model_dump(mode="json"), indent=2), flush=True)
    if not result.answer.success or result.answer.remaining_line_items != 0:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
