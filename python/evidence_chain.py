"""Canonical, tamper-evident evidence events shared with the TypeScript API.

This is deliberately a hash chain, not a signature scheme.  A separately saved
head hash makes later edits detectable; it does not prove who produced an event.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


SCHEME = "buywith402/evidence-chain/v1"
EVENT_DOMAIN = b"buywith402:evidence-event:v1\n"
ROOT_DOMAIN = b"buywith402:evidence-root:v1\n"


def canonical_json(value: object) -> str:
    """RFC-8259 JSON with recursively sorted keys and no insignificant space."""
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def evidence_root(order_id: str) -> str:
    return sha256_hex(ROOT_DOMAIN + order_id.encode("utf-8"))


def screenshot_sha256(data: bytes) -> str:
    return sha256_hex(data)


def event_payload(event: dict[str, Any]) -> dict[str, Any]:
    """Return the exact, versioned fields committed by ``event_hash``."""
    payload: dict[str, Any] = {
        "evidence_version": SCHEME,
        "order_id": event["order_id"],
        "seq": event["seq"],
        "t": event["t"],
        "stage": event["stage"],
        "message": event["message"],
        "previous_hash": event["previous_hash"],
    }
    if event.get("screenshot_url") is not None:
        payload["screenshot_url"] = event["screenshot_url"]
    if event.get("screenshot_sha256") is not None:
        payload["screenshot_sha256"] = event["screenshot_sha256"]
    return payload


def event_hash(event: dict[str, Any]) -> str:
    encoded = canonical_json(event_payload(event)).encode("utf-8")
    return sha256_hex(EVENT_DOMAIN + encoded)


def build_event(
    *,
    order_id: str,
    seq: int,
    timestamp: str,
    stage: str,
    message: str,
    previous_hash: str,
    screenshot_url: str | None = None,
    screenshot_hash: str | None = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "evidence_version": SCHEME,
        "order_id": order_id,
        "seq": seq,
        "t": timestamp,
        "stage": stage,
        "message": message[:500],
        "previous_hash": previous_hash,
    }
    if screenshot_url:
        event["screenshot_url"] = screenshot_url
    if screenshot_hash:
        event["screenshot_sha256"] = screenshot_hash
    event["event_hash"] = event_hash(event)
    return event


def verify_fixture(path: Path) -> None:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    order_id = fixture["order_id"]
    expected_previous = evidence_root(order_id)
    if expected_previous != fixture["root"]:
        raise SystemExit("fixture root does not match Python implementation")
    for index, event in enumerate(fixture["events"]):
        if event["seq"] != index:
            raise SystemExit(f"fixture sequence mismatch at event {index}")
        if event["previous_hash"] != expected_previous:
            raise SystemExit(f"fixture previous_hash mismatch at event {index}")
        computed = event_hash(event)
        if computed != event["event_hash"]:
            raise SystemExit(f"fixture event_hash mismatch at event {index}")
        expected_previous = computed
    print(
        f"verified Python canonicalization: {len(fixture['events'])} events, "
        f"head={expected_previous}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Evidence-chain development checks")
    parser.add_argument("--verify-fixture", type=Path)
    args = parser.parse_args()
    if not args.verify_fixture:
        parser.error("--verify-fixture is required")
    verify_fixture(args.verify_fixture)


if __name__ == "__main__":
    main()
