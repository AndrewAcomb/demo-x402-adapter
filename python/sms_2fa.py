"""Read newly arrived SMS verification codes from a Twilio phone number.

The IMAP analog for SMS: the client authenticates with a standalone Twilio
API key (not the account auth token) and polls the Messages API for inbound
texts to the agent's number, exactly like ImapCodeReader polls an inbox.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

import httpx

from email_2fa import extract_code

API_BASE = "https://api.twilio.com/2010-04-01"


def message_timestamp(message: dict[str, object]) -> datetime | None:
    raw = message.get("date_sent") or message.get("date_created")
    if not raw:
        return None
    try:
        return parsedate_to_datetime(str(raw))
    except (TypeError, ValueError):
        return None


@dataclass
class TwilioSmsReader:
    account_sid: str
    key_sid: str
    key_secret: str
    number: str
    baseline: datetime | None = None

    @classmethod
    def from_env(cls) -> TwilioSmsReader | None:
        account_sid = os.environ.get("TWILIO_ACCOUNT_SID")
        key_sid = os.environ.get("TWILIO_API_KEY_SID")
        key_secret = os.environ.get("TWILIO_API_KEY_SECRET")
        number = os.environ.get("TWILIO_SMS_NUMBER")
        if not all((account_sid, key_sid, key_secret, number)):
            return None
        return cls(
            account_sid=account_sid,
            key_sid=key_sid,
            key_secret=key_secret,
            number=number,
        )

    def _fetch_inbound(self) -> list[dict[str, object]]:
        response = httpx.get(
            f"{API_BASE}/Accounts/{self.account_sid}/Messages.json",
            params={"To": self.number, "PageSize": "20"},
            auth=(self.key_sid, self.key_secret),
            timeout=15,
        )
        response.raise_for_status()
        return [
            message
            for message in response.json().get("messages", [])
            if str(message.get("direction", "")).startswith("inbound")
        ]

    def establish_baseline(self) -> None:
        newest: datetime | None = None
        for message in self._fetch_inbound():
            sent = message_timestamp(message)
            if sent is not None and (newest is None or sent > newest):
                newest = sent
        self.baseline = newest or datetime.now(UTC)

    def wait_for_code(self, timeout_seconds: int = 180) -> str:
        if self.baseline is None:
            raise RuntimeError("establish_baseline() must run before the trigger")
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            for message in self._fetch_inbound():
                sent = message_timestamp(message)
                if sent is None or sent <= self.baseline:
                    continue
                code = extract_code("", str(message.get("body") or ""))
                if code:
                    self.baseline = sent
                    return code
            time.sleep(3)
        raise TimeoutError(
            f"No new SMS with a code arrived at {self.number} within "
            f"{timeout_seconds} seconds"
        )
