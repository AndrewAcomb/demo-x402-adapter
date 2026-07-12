#!/usr/bin/env python
"""Fulfillment worker: bridge paid x402 orders to the correct merchant cart flow.

Polls the shared Upstash Redis order queue that the TS server (Vercel)
pushes to on each settled purchase, runs `add_cached_to_cart.py` as a
subprocess for the ordered product, tees the run's live output into the
order's event list (so buyers can poll GET /orders/{id} and watch), uploads
checkpoint screenshots to Vercel Blob, and writes the final status/result.

Status lifecycle it drives: queued -> running -> ready_to_place | placed | failed.

Safety: a real Place Order click requires BOTH the buyer's `dry_run: false`
on the paid request AND ALLOW_REAL_ORDERS=1 in this worker's environment.
Everything else stops at the merchant's order-review screen (fail-closed,
same as add_cached_to_cart.py's default).

Run from the python/ directory:  uv run python worker.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx

REDIS_URL = os.environ.get("KV_REST_API_URL") or os.environ.get("UPSTASH_REDIS_REST_URL")
REDIS_TOKEN = os.environ.get("KV_REST_API_TOKEN") or os.environ.get("UPSTASH_REDIS_REST_TOKEN")
BLOB_TOKEN = os.environ.get("BLOB_READ_WRITE_TOKEN")
ALLOW_REAL_ORDERS = os.environ.get("ALLOW_REAL_ORDERS") == "1"
MAX_TOTAL = float(os.environ.get("WORKER_MAX_TOTAL", "50"))
POLL_SECONDS = float(os.environ.get("WORKER_POLL_SECONDS", "3"))
# Browser-agent runs flake sometimes (structured-answer misses, etc.), so a
# failed attempt re-queues automatically. Buyers only ever see the scary
# "failed" status after the LAST attempt; in between the order is "retrying".
MAX_ATTEMPTS = int(os.environ.get("WORKER_MAX_ATTEMPTS", "3"))

HERE = Path(__file__).resolve().parent

CHECKPOINT_LINE = re.compile(r"SAVED (?:CHECKPOINT (\S+)|FALLBACK FINAL STATE) TO (\S+\.png)")
AGENT_VIEW_LINE = re.compile(r"H Agent View: (\S+)")
ARTIFACT_DIR_LINE = re.compile(r"ARTIFACTS WILL BE SAVED UNDER (\S+)")
STATE_LINE = re.compile(r"\[(state|agent|error)\] (.+)")


def redis(command: list[str | int]) -> object:
    response = httpx.post(
        REDIS_URL,
        headers={"Authorization": f"Bearer {REDIS_TOKEN}"},
        json=[str(part) for part in command],
        timeout=15,
    )
    response.raise_for_status()
    payload = response.json()
    if isinstance(payload, dict) and payload.get("error"):
        raise RuntimeError(f"redis error: {payload['error']}")
    return payload.get("result") if isinstance(payload, dict) else payload


def blob_put(pathname: str, data: bytes, content_type: str = "image/png") -> str | None:
    """Upload bytes to Vercel Blob; returns the public URL (or None on failure)."""
    if not BLOB_TOKEN:
        return None
    try:
        response = httpx.put(
            f"https://blob.vercel-storage.com/{pathname}",
            content=data,
            headers={
                "Authorization": f"Bearer {BLOB_TOKEN}",
                "x-api-version": "7",
                "x-content-type": content_type,
            },
            timeout=60,
        )
        response.raise_for_status()
        return response.json().get("url")
    except Exception as exc:  # noqa: BLE001 — artifact upload must never kill a run
        print(f"[worker] blob upload failed for {pathname}: {exc}", flush=True)
        return None


def publish(order_id: str, stage: str, message: str, screenshot_url: str | None = None) -> None:
    event: dict[str, object] = {
        "t": datetime.now(UTC).isoformat(timespec="seconds"),
        "stage": stage,
        "message": message[:500],
    }
    if screenshot_url:
        event["screenshot_url"] = screenshot_url
    redis(["RPUSH", f"order:{order_id}:events", json.dumps(event, separators=(",", ":"))])
    redis(["EXPIRE", f"order:{order_id}:events", 60 * 60 * 24 * 7])
    redis(["HSET", f"order:{order_id}", "updated_at", event["t"]])


def set_status(order_id: str, status: str, result: dict | None = None) -> None:
    fields: list[str] = ["status", status, "updated_at", datetime.now(UTC).isoformat(timespec="seconds")]
    if result is not None:
        fields += ["result", json.dumps(result)]
    redis(["HSET", f"order:{order_id}", *fields])


def get_order(order_id: str) -> dict[str, str]:
    raw = redis(["HGETALL", f"order:{order_id}"]) or []
    return {raw[i]: raw[i + 1] for i in range(0, len(raw), 2)}


def write_address_file(order: dict[str, str], directory: Path) -> Path:
    shipping = json.loads(order["shipping"])
    recipient = {
        "recipient_name": shipping["name"],
        "company": "",
        "street1": shipping["address_1"],
        "street2": shipping.get("address_2", ""),
        "city": shipping["city"],
        "state": shipping["state"],
        "postal_code": shipping["zip"],
        "country": shipping.get("country", "US"),
        # Never forward the buyer's email into the browser flow: McMaster's
        # checkout email is the (read-only) account email, and telling the
        # agent a different one makes it fight an uneditable field. The buyer
        # email stays on the order record for receipts/support only.
        "email": "",
        "phone": "",
    }
    path = directory / "order-address.json"
    path.write_text(json.dumps({"recipients": [recipient]}, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)
    return path


def handle_test_item(order_id: str, order: dict[str, str], place_order: bool) -> None:
    publish(order_id, "worker", "Test item: skipping merchant fulfillment.")
    for stage, message in [
        ("agent", "started (simulated)"),
        ("checkpoint", "cart-cleared (simulated)"),
        ("checkpoint", "product-in-cart (simulated)"),
        ("checkpoint", "place-order-review (simulated)"),
    ]:
        publish(order_id, stage, message)
        time.sleep(1)
    final = "placed" if place_order else "ready_to_place"
    set_status(order_id, final, {"success": True, "simulated": True})
    publish(order_id, "worker", f"Test item complete: {final}.")


def merchant_for_order(order: dict[str, str]) -> str:
    """Return the validated routing key carried from the published product."""
    product_id = order.get("product_id", "")
    merchant = order.get("merchant") or product_id.partition(":")[0]
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,30}", merchant):
        raise ValueError(f"order has invalid merchant routing key {merchant!r}")
    if not product_id.startswith(f"{merchant}:"):
        raise ValueError(
            f"product {product_id!r} does not belong to routed merchant {merchant!r}"
        )
    return merchant


def handle_order(order_id: str) -> None:
    order = get_order(order_id)
    if not order:
        print(f"[worker] order {order_id} not found in store; skipping", flush=True)
        return

    dry_run = order.get("dry_run", "1") != "0"
    place_order = not dry_run and ALLOW_REAL_ORDERS
    if not dry_run and not ALLOW_REAL_ORDERS:
        publish(
            order_id,
            "worker",
            "Buyer requested a real order but ALLOW_REAL_ORDERS is not enabled on the "
            "worker; falling back to dry run (stops at order review).",
        )

    set_status(order_id, "running")
    publish(
        order_id,
        "worker",
        f"Fulfillment started for {order.get('product_name', order.get('product_id'))} "
        f"({'REAL ORDER' if place_order else 'dry run — stops at order review'}).",
    )

    if order.get("product_id") == "test-item":
        handle_test_item(order_id, order, place_order)
        return

    merchant = merchant_for_order(order)

    with tempfile.TemporaryDirectory(prefix=f"order-{order_id[:8]}-") as tmp:
        address_file = write_address_file(order, Path(tmp))
        cmd = [
            sys.executable,
            "add_cached_to_cart.py",
            "--product",
            order["product_id"],
            "--recipient",
            "1",
            "--address-file",
            str(address_file),
            "--max-total",
            str(MAX_TOTAL),
            "--merchant",
            merchant,
        ]
        if place_order:
            cmd.append("--place-order")

        artifact_dir: Path | None = None
        process = subprocess.Popen(
            cmd,
            cwd=HERE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip()
            if not line:
                continue

            match = ARTIFACT_DIR_LINE.search(line)
            if match:
                artifact_dir = Path(match.group(1))
                continue

            match = AGENT_VIEW_LINE.search(line)
            if match:
                publish(order_id, "live_view", f"Watch the agent live: {match.group(1)}")
                continue

            match = CHECKPOINT_LINE.search(line)
            if match:
                checkpoint = match.group(1) or "final-state"
                png = Path(match.group(2))
                url = None
                if png.is_file():
                    url = blob_put(f"orders/{order_id}/{png.name}", png.read_bytes())
                publish(order_id, "checkpoint", checkpoint, screenshot_url=url)
                continue

            match = STATE_LINE.search(line)
            if match:
                publish(order_id, "agent", f"{match.group(1)}: {match.group(2)}")
                continue

            # Local-side banners are high-signal; forward a compact form.
            if "LLOCALL" in line or "──" in line:
                text = line.replace("LLOCALL", "").strip("─ ").strip()
                if text:
                    publish(order_id, "local", text)

        exit_code = process.wait()

        result: dict | None = None
        if artifact_dir is not None and artifact_dir.is_dir():
            results = sorted(artifact_dir.glob("*-result.json"))
            if results:
                try:
                    result = json.loads(results[-1].read_text(encoding="utf-8"))
                except Exception:  # noqa: BLE001
                    result = None

    if exit_code == 0:
        final = "placed" if place_order else "ready_to_place"
        set_status(order_id, final, result)
        publish(order_id, "worker", f"Fulfillment finished: {final}.")
    else:
        attempts = int(redis(["HINCRBY", f"order:{order_id}", "attempts", 1]) or 1)
        # Never auto-retry a real-order run unless the result proves Place
        # Order was not clicked — a blind retry could place a duplicate
        # merchant order. (Dry runs are always safe to retry.)
        click_unproven = place_order and (result is None or result.get("place_order_clicked") is not False)
        if attempts < MAX_ATTEMPTS and not click_unproven:
            set_status(order_id, "retrying", result)
            publish(
                order_id,
                "worker",
                f"Attempt {attempts} of {MAX_ATTEMPTS} did not complete — retrying "
                "automatically. Your payment is safe; no action needed.",
            )
            redis(["LPUSH", "orders:queue", order_id])
        else:
            set_status(order_id, "failed", result)
            reason = (
                "Automatic retry withheld: could not prove the merchant order was not "
                "already placed. " if click_unproven else ""
            )
            publish(
                order_id,
                "worker",
                f"Fulfillment failed after {attempts} attempt(s). {reason}Contact the "
                "merchant with this order id for a refund or manual retry.",
            )


def main() -> None:
    if not REDIS_URL or not REDIS_TOKEN:
        raise SystemExit("KV_REST_API_URL / KV_REST_API_TOKEN must be set (Upstash REST)")
    mode = "REAL ORDERS ENABLED" if ALLOW_REAL_ORDERS else "dry-run only"
    print(f"[worker] polling orders:queue every {POLL_SECONDS:.0f}s ({mode})", flush=True)
    while True:
        try:
            order_id = redis(["RPOP", "orders:queue"])
        except Exception as exc:  # noqa: BLE001 — keep polling through transient errors
            print(f"[worker] queue poll failed: {exc}", flush=True)
            time.sleep(POLL_SECONDS)
            continue
        if not order_id:
            time.sleep(POLL_SECONDS)
            continue
        print(f"[worker] picked up order {order_id}", flush=True)
        try:
            handle_order(str(order_id))
        except Exception as exc:  # noqa: BLE001 — one bad order must not kill the loop
            print(f"[worker] order {order_id} crashed: {exc}", flush=True)
            try:
                set_status(str(order_id), "failed")
                publish(str(order_id), "worker", f"Worker error: {exc}")
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    main()
