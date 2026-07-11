"""Build a cheap, orderable McMaster-Carr screw catalog with H's browser."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from io import TextIOBase
from pathlib import Path
from urllib.parse import urlparse

from hai_agents import Client
from pydantic import BaseModel, Field, model_validator

from h_profile import active_environment_network, newest_browser_profile_id
from email_2fa import ImapCodeReader


START_URL = (
    "https://www.mcmaster.com/products/screws/rounded-head-screws-2~/"
    "steel-pan-head-phillips-screws~~/"
)
PART_NUMBER_PATTERN = re.compile(r"^[A-Z0-9]+$")
OUTPUT_NAME_PATTERN = re.compile(r"^(\d{3})-")
CATALOG_SHORT_NAME = "mcmaster-screws"
RUNTIME_SECRETS: set[str] = set()
LOCAL_BANNER = "\033[34m"
LOCAL_SUCCESS = "\033[32m"
LOCAL_FAILURE = "\033[31m"
COLOR_RESET = "\033[0m"


class Tee(TextIOBase):
    def __init__(self, *streams: TextIOBase) -> None:
        self.streams = streams

    def write(self, value: str) -> int:
        for stream in self.streams:
            stream.write(value)
            stream.flush()
        return len(value)

    def flush(self) -> None:
        for stream in self.streams:
            stream.flush()


def enable_tee(log_path: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = log_path.open("a", encoding="utf-8", buffering=1)
    separator = datetime.now(UTC).strftime("\n=== run %Y-%m-%dT%H:%M:%SZ ===\n")
    log_file.write(separator)
    log_file.flush()
    sys.stdout = Tee(sys.__stdout__, log_file)
    sys.stderr = Tee(sys.__stderr__, log_file)
    print(f"Teeing live output to {log_path.resolve()}", flush=True)


def local_banner(message: str, color: str = LOCAL_BANNER) -> None:
    print(
        f"\n{color}========== [LLOCALL] LOCAL MAC: {message} =========={COLOR_RESET}\n",
        flush=True,
    )


class Screw(BaseModel):
    position: int = Field(ge=1, le=10)
    durable_id: str = Field(pattern=r"^mcmaster:[A-Z0-9]+$")
    part_number: str = Field(pattern=r"^[A-Z0-9]+$")
    description: str = Field(min_length=1)
    thread_size: str = Field(min_length=1)
    length: str = Field(min_length=1)
    material: str = Field(min_length=1)
    drive_style: str = Field(min_length=1)
    package_quantity: int = Field(ge=1)
    package_price: float = Field(ge=0)
    currency: str = Field(min_length=3, max_length=3)
    url: str

    @model_validator(mode="after")
    def validate_identity(self) -> Screw:
        self.part_number = self.part_number.upper()
        self.currency = self.currency.upper()
        if self.durable_id != f"mcmaster:{self.part_number}":
            raise ValueError("durable_id does not match part_number")

        parsed = urlparse(self.url)
        if parsed.scheme != "https" or parsed.hostname not in {
            "mcmaster.com",
            "www.mcmaster.com",
        }:
            raise ValueError("url must be an HTTPS McMaster-Carr URL")
        url_part = parsed.path.strip("/").split("/")[-1].upper()
        if url_part != self.part_number:
            raise ValueError("part_number does not match the direct URL")
        return self


class ScrewCatalog(BaseModel):
    authenticated: bool
    observed_account_name: str = Field(min_length=1)
    products: list[Screw] = Field(max_length=10)

    @model_validator(mode="after")
    def validate_catalog(self) -> ScrewCatalog:
        if not self.authenticated:
            if self.products:
                raise ValueError("unauthenticated results must not contain products")
            return self
        if "david" not in self.observed_account_name.casefold():
            raise ValueError("authenticated result must identify David in the account indicator")
        if len(self.products) != 10:
            raise ValueError("authenticated catalog must contain exactly 10 products")
        if sorted(product.position for product in self.products) != list(range(1, 11)):
            raise ValueError("positions must contain every integer from 1 through 10")
        if len({product.part_number for product in self.products}) != 10:
            raise ValueError("all McMaster part numbers must be distinct")
        self.products.sort(key=lambda product: product.position)
        return self


def compact(value: object, limit: int = 500) -> str:
    rendered = value if isinstance(value, str) else json.dumps(value, default=str)
    for variable in (
        "MCMASTER_EMAIL",
        "MCMASTER_PASSWORD",
        "CHECKOUT_CARD_NUMBER",
        "CHECKOUT_CARD_CVV",
    ):
        secret = os.environ.get(variable)
        if secret:
            rendered = rendered.replace(secret, f"<{variable.lower()}-redacted>")
    for secret in RUNTIME_SECRETS:
        rendered = rendered.replace(secret, "<2fa-code-redacted>")
    rendered = " ".join(rendered.split())
    return rendered if len(rendered) <= limit else rendered[: limit - 1] + "…"


def print_live_event(event: object) -> None:
    payload = event.model_dump(mode="json")
    event_type = payload.get("type", type(event).__name__)
    data = payload.get("data") or {}
    if event_type == "ActiveStateChangeEvent":
        print(f"[state] {data.get('state')}", flush=True)
        if data.get("state") == "awaiting_tool_results":
            local_banner("H PAUSED — LOCAL TOOL CALLBACK REQUESTED")
    elif event_type == "AgentStartedEvent":
        print("[agent] started", flush=True)
    elif event_type == "AgentCompletionEvent":
        print(f"[agent] completed: {data.get('reason')}", flush=True)
    elif event_type == "AgentErrorEvent":
        print(f"[error] {compact(data.get('error'))}", flush=True)
    elif event_type == "MetricsUpdateEvent":
        print(f"[metrics] steps={(data.get('metrics') or {}).get('steps')}", flush=True)
    elif event_type == "AgentEvent":
        kind = data.get("kind")
        if kind == "observation_event":
            metadata = data.get("metadata") or {}
            print(
                f"[page] {metadata.get('title') or 'untitled'} — "
                f"{metadata.get('url') or 'unknown URL'}",
                flush=True,
            )
        elif kind == "policy_event":
            if data.get("content"):
                print(f"[agent] {compact(data['content'])}", flush=True)
            for tool in data.get("tool_reqs") or []:
                name = tool.get("tool_name", "unknown")
                args = dict(tool.get("args") or {})
                if name in {"write", "fill_secret_at"}:
                    for field in ("content", "text", "value"):
                        if field in args:
                            args[field] = "<redacted>"
                print(f"[action] {name} {compact(args)}", flush=True)
        elif kind == "tool_result":
            request = data.get("tool_req") or {}
            tool_name = request.get("tool_name", "tool")
            print(f"[result] {tool_name}: {compact(data.get('result'))}", flush=True)
            if tool_name == "wait_for_email_2fa_code":
                local_banner("EMAIL RESULT DELIVERED — H RESUMING", LOCAL_SUCCESS)
        elif kind == "answer_event":
            print(f"[answer] {compact(data.get('answer'), 2_000)}", flush=True)
        elif kind == "error_event":
            print(f"[step error] {compact(data.get('error'))}", flush=True)


def save_catalog(payload: dict[str, object], output_dir: Path) -> Path:
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
    output_path = output_dir / f"{sequence:03d}-{timestamp}-{CATALOG_SHORT_NAME}.json"
    rendered = json.dumps(payload, indent=2) + "\n"
    with output_path.open("x", encoding="utf-8") as output_file:
        output_file.write(rendered)
    return output_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Enumerate 10 inexpensive orderable screws from McMaster-Carr."
    )
    parser.add_argument(
        "--output-dir", type=Path, default=Path("runtime/catalogs")
    )
    parser.add_argument(
        "--log-file",
        type=Path,
        default=Path("runtime/logs/fetch-products.log"),
        help="Append terminal output here while also printing it live",
    )
    parser.add_argument(
        "--us-egress",
        action="store_true",
        help="Use H's sticky US residential proxy if enabled for the organization",
    )
    args = parser.parse_args()
    enable_tee(args.log_file)
    if not os.environ.get("HAI_API_KEY"):
        parser.error("HAI_API_KEY is not set; let direnv load this project first")
    mcmaster_email = os.environ.get("MCMASTER_EMAIL")
    mcmaster_password = os.environ.get("MCMASTER_PASSWORD")
    if not mcmaster_email or not mcmaster_password:
        parser.error(
            "MCMASTER_EMAIL and MCMASTER_PASSWORD must be set in the ignored .env file"
        )

    client = Client()
    email_reader = ImapCodeReader.from_env()
    tools = []
    if email_reader is not None:
        local_banner("CONNECTING TO PRIVATE EMAIL OVER IMAP")
        email_reader.establish_baseline()
        local_banner("IMAP READY — NEW-MESSAGE BASELINE RECORDED", LOCAL_SUCCESS)

        def wait_for_email_2fa_code(timeout_seconds: int = 180) -> str:
            """Wait for a new McMaster email and return its verification code."""
            local_banner(
                f"H CALLED EMAIL TOOL — POLLING FOR NEW 2FA MAIL ({timeout_seconds}s timeout)"
            )
            try:
                code = email_reader.wait_for_code(timeout_seconds)
                RUNTIME_SECRETS.add(code)
                local_banner("2FA CODE EXTRACTED — RETURNING IT TO H", LOCAL_SUCCESS)
                return code
            except Exception:
                local_banner("EMAIL 2FA TOOL FAILED", LOCAL_FAILURE)
                raise

        tools.append(wait_for_email_2fa_code)
        email_tool_instruction = (
            "If McMaster requests an email verification code, call the local "
            "wait_for_email_2fa_code tool, enter its result into the verification "
            "field, and submit. Never repeat the code in notes or the final answer. "
            "If a code is rejected, click 'Send a new code' first, then call the "
            "tool once more. Stop after that single retry; never reuse an old code."
        )
    else:
        email_tool_instruction = (
            "No email-code tool is configured. If email verification is required, "
            "stop and report that blocker."
        )
    browser_profile_id = newest_browser_profile_id(client)
    environment_network = active_environment_network(client)
    overrides: dict[str, object] = {
        "agent.environments[kind=web].start_url": START_URL,
        "agent.environments[kind=web].browser_profile_id": browser_profile_id,
        "agent.environments[kind=web].persist_browser_profile": True,
        "agent.environments[kind=web].network": environment_network.model_dump(
            mode="json", exclude_none=True
        ),
    }
    if args.us_egress:
        overrides["agent.environments[kind=web].network"] = {
            "managed_proxy": {
                "pool": "residential",
                "country": "US",
                "sticky": True,
            }
        }

    session = client.start_session(
        agent="h/web-surfer-pro",
        overrides=overrides,
        answer_schema=ScrewCatalog,
        tools=tools,
        messages=f"""
AUTHENTICATION PREFLIGHT — COMPLETE THIS BEFORE CATALOG WORK:

1. Inspect the account indicator at the top-right of McMaster-Carr.
2. If it visibly contains "David", authentication passes.
3. If it says "Log in" or "Sign in", open the login form and sign in using:
   - Email: {mcmaster_email}
   - Password: {mcmaster_password}
   Do not repeat either credential in notes, reasoning, tool descriptions, or
   the final answer. Type them only into the corresponding login fields.
4. Submit the login form, wait for the page to settle, and verify the top-right
   account indicator visibly contains "David".
5. If login fails, another identity appears, MFA is required, or "David" cannot
   be verified after using the available email-code tool, stop immediately. Return authenticated=false, the exact visible
   account-indicator or blocker text in observed_account_name, and products=[].

Email verification behavior: {email_tool_instruction}

Only after visibly confirming "David", return authenticated=true and record
the exact account-indicator text in observed_account_name. Then create a
catalog of exactly 10 inexpensive, currently orderable screw SKUs.

Choose one ordinary, internally consistent family such as Phillips rounded-head
machine screws. Navigate into its actual specification and ordering table; do
not return broad product categories. Pick the first ten inexpensive rows you
can fully verify, ideally no more than $25 per package. Do not search the whole
table for the absolute cheapest products and do not open every product popup.

For every SKU, read and return:
- position 1 through 10
- exact McMaster part number
- durable_id formatted as "mcmaster:<PART_NUMBER>"
- full description
- thread size, length, material, and drive style
- package quantity and total package price
- three-letter currency code
- direct canonical URL formatted as https://www.mcmaster.com/<PART_NUMBER>

Every result must be a distinct, orderable part number with a displayed price.
Verify values from the actual ordering table and never invent missing data. Do
not add anything to the order, sign in, or begin checkout. If a chosen family
does not contain ten inexpensive orderable variants, choose another common
screw family that does.
""".strip(),
        max_steps=25,
        max_time_s=300,
    )

    snapshot = session.get()
    print(f"H session: {session.id}", flush=True)
    print(f"H Agent View: {snapshot.agent_view_url}", flush=True)
    print("Streaming McMaster catalog discovery...", flush=True)
    with ThreadPoolExecutor(max_workers=1) as executor:
        waiter = executor.submit(
            session.wait_for_completion,
            timeout_seconds=330,
            tools=tools,
        )
        for event in session.stream():
            print_live_event(event)
        result = waiter.result()
    print(f"Status: {result.status}")
    print(f"Outcome: {result.outcome}")
    if result.error:
        print(f"Error: {result.error}")
    if result.answer is None:
        raise SystemExit(1)

    print(
        f"Authentication check: expected='David', "
        f"observed={result.answer.observed_account_name!r}, "
        f"authenticated={result.answer.authenticated}",
        flush=True,
    )
    if not result.answer.authenticated:
        print("FAILURE: McMaster-Carr browser profile is not authenticated as David.")
        raise SystemExit(2)
    if result.outcome != "success":
        raise SystemExit(1)

    payload = result.answer.model_dump(mode="json")
    rendered = json.dumps(payload, indent=2)
    output_path = save_catalog(payload, args.output_dir)
    print("\nValidated catalog:")
    print(rendered)
    print(f"\nSaved to {output_path.resolve()}")


if __name__ == "__main__":
    main()
