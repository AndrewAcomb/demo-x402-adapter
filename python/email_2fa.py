"""Read newly arrived email verification codes from a private IMAP inbox."""

from __future__ import annotations

import email
import imaplib
import os
import re
import time
from dataclasses import dataclass
from email.message import Message
from html import unescape


CODE_PATTERNS = (
    re.compile(
        r"(?is)verification\s+code.{0,180}?\b("
        r"(?=[A-Z0-9]{4,10}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{4,10})\b"
    ),
    re.compile(
        r"(?i)(?:verification|security|authentication|one[ -]time|login|sign[ -]in)"
        r"(?:\s+(?:code|passcode|password))?\s*(?:is|:|-)?\s*"
        r"\b([A-Z0-9]{4,10})\b"
    ),
    re.compile(
        r"(?i)\b(?:code|passcode|OTP)\s*(?:is|:|-)?\s*\b([A-Z0-9]{4,10})\b"
    ),
)
HTML_TAG = re.compile(r"<[^>]+>")


def message_text(message: Message) -> str:
    parts: list[str] = []
    for part in message.walk() if message.is_multipart() else (message,):
        if part.get_content_maintype() == "multipart":
            continue
        if part.get_content_type() not in {"text/plain", "text/html"}:
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        charset = part.get_content_charset() or "utf-8"
        text = payload.decode(charset, errors="replace")
        if part.get_content_type() == "text/html":
            text = unescape(HTML_TAG.sub(" ", text))
        parts.append(text)
    return "\n".join(parts)


def extract_code(subject: str, body: str) -> str | None:
    searchable = f"{subject}\n{body}"
    for pattern in CODE_PATTERNS:
        for match in pattern.finditer(searchable):
            candidate = match.group(1).upper()
            if any(character.isdigit() for character in candidate):
                return candidate
    return None


@dataclass
class ImapCodeReader:
    host: str
    username: str
    password: str
    port: int = 993
    folder: str = "INBOX"
    sender_filter: str = "mcmaster"
    baseline_uid: int = 0

    @classmethod
    def from_env(cls) -> ImapCodeReader | None:
        host = os.environ.get("EMAIL_IMAP_HOST")
        username = os.environ.get("EMAIL_IMAP_USERNAME")
        password = os.environ.get("EMAIL_IMAP_PASSWORD")
        if not all((host, username, password)):
            return None
        return cls(
            host=host,
            port=int(os.environ.get("EMAIL_IMAP_PORT", "993")),
            username=username,
            password=password,
            folder=os.environ.get("EMAIL_IMAP_FOLDER", "INBOX"),
            sender_filter=os.environ.get("EMAIL_2FA_SENDER_FILTER", "mcmaster"),
        )

    def connect(self) -> imaplib.IMAP4_SSL:
        mailbox = imaplib.IMAP4_SSL(self.host, self.port)
        mailbox.login(self.username, self.password)
        status, _ = mailbox.select(self.folder, readonly=True)
        if status != "OK":
            mailbox.logout()
            raise RuntimeError(f"Unable to select IMAP folder {self.folder!r}")
        return mailbox

    def establish_baseline(self) -> None:
        with self.connect() as mailbox:
            status, data = mailbox.uid("search", None, "ALL")
            if status != "OK":
                raise RuntimeError("Unable to establish IMAP UID baseline")
            uids = [int(value) for value in (data[0] or b"").split()]
            self.baseline_uid = max(uids, default=0)

    def wait_for_code(self, timeout_seconds: int = 180) -> str:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            with self.connect() as mailbox:
                status, data = mailbox.uid(
                    "search", None, f"UID {self.baseline_uid + 1}:*"
                )
                if status != "OK":
                    raise RuntimeError("Unable to search IMAP inbox")
                uids = [
                    int(value)
                    for value in (data[0] or b"").split()
                    if int(value) > self.baseline_uid
                ]
                for uid in reversed(uids):
                    status, fetched = mailbox.uid("fetch", str(uid), "(RFC822)")
                    if status != "OK" or not fetched:
                        continue
                    raw = next(
                        (item[1] for item in fetched if isinstance(item, tuple)), None
                    )
                    if raw is None:
                        continue
                    message = email.message_from_bytes(raw)
                    sender = str(message.get("From", ""))
                    subject = str(message.get("Subject", ""))
                    body = message_text(message)
                    haystack = f"{sender}\n{subject}\n{body}".casefold()
                    if self.sender_filter.casefold() not in haystack:
                        continue
                    code = extract_code(subject, body)
                    if code:
                        self.baseline_uid = max(self.baseline_uid, uid)
                        return code
            time.sleep(3)
        raise TimeoutError(
            f"No new matching 2FA email arrived within {timeout_seconds} seconds"
        )
