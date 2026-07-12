#!/usr/bin/env python
"""Merchant Factory worker: turn queued onboarding jobs into live products.

Polls the shared Upstash Redis onboarding queue that the TS server pushes to
on POST /merchants, runs the onboarding machinery from onboard_merchant.py as
a library (an H browser agent browses the store and builds a validated
catalog), tees progress into the job's event list (so operators can poll
GET /merchants/jobs/{id} and watch), then publishes the products into the
dynamic catalog hash that the TS server serves and charges from.

Keys (mirror worker.py's order keys):

  onboard:{job_id}         hash  — job fields + status (+ result JSON)
  onboard:{job_id}:events  list  — progress events (RPUSH)
  onboard:queue            list  — job ids awaiting onboarding (RPOP)
  catalog:dynamic          hash  — product id -> Product JSON for the TS app
  merchants:index          hash  — nickname -> merchant summary JSON

Status lifecycle it drives: queued -> running -> succeeded | failed.

Pricing rule (same as scripts/gen-catalog.mjs): the x402 charge is the
merchant package price x 1.5 plus a flat $15 shipping/tax buffer.

Mock mode: ONBOARD_MOCK=1 skips the real H browse and pushes a canned event
sequence plus a small canned catalog through the exact same Redis writes, so
the TS side and the demo loop can be exercised with no H credentials.

Run from the python/ directory:  uv run python onboard_worker.py
"""

from __future__ import annotations

import json
import os
import time
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal

import httpx

from merchants import nickname_from_url, slugify

REDIS_URL = os.environ.get("KV_REST_API_URL") or os.environ.get("UPSTASH_REDIS_REST_URL")
REDIS_TOKEN = os.environ.get("KV_REST_API_TOKEN") or os.environ.get("UPSTASH_REDIS_REST_TOKEN")
MOCK = os.environ.get("ONBOARD_MOCK") == "1"
POLL_SECONDS = float(os.environ.get("ONBOARD_POLL_SECONDS", "3"))
WEEK_SECONDS = 60 * 60 * 24 * 7

# x402 charge = item + our explicit service fee (10% of the item + $0.25)
# + item x agent-estimated tax rate + the agent-estimated per-order
# fulfillment fee. The browsing agent ballparks tax and fee from real signals
# in the flow (onboard_merchant.py); when it cannot confirm whether the buyer
# pays shipping/delivery or picks up, we fall back to a conservative $15
# placeholder rather than $0. Keep in sync with scripts/gen-catalog.mjs.
SERVICE_FEE_RATE = 0.10
SERVICE_FEE_FLAT_USD = 0.25
SHIPPING_FALLBACK_USD = 15.0


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


def publish(job_id: str, stage: str, message: str) -> None:
    event = {
        "t": datetime.now(UTC).isoformat(timespec="seconds"),
        "stage": stage,
        "message": message[:500],
    }
    redis(["RPUSH", f"onboard:{job_id}:events", json.dumps(event, separators=(",", ":"))])
    redis(["EXPIRE", f"onboard:{job_id}:events", WEEK_SECONDS])
    redis(["HSET", f"onboard:{job_id}", "updated_at", event["t"]])


def set_status(job_id: str, status: str, result: dict | None = None) -> None:
    fields: list[str] = [
        "status",
        status,
        "updated_at",
        datetime.now(UTC).isoformat(timespec="seconds"),
    ]
    if result is not None:
        fields += ["result", json.dumps(result)]
    redis(["HSET", f"onboard:{job_id}", *fields])


def get_job(job_id: str) -> dict[str, str]:
    raw = redis(["HGETALL", f"onboard:{job_id}"]) or []
    return {raw[i]: raw[i + 1] for i in range(0, len(raw), 2)}


def service_fee(package_price: float) -> Decimal:
    return (
        Decimal(str(package_price)) * Decimal(str(SERVICE_FEE_RATE))
        + Decimal(str(SERVICE_FEE_FLAT_USD))
    )


def x402_price(package_price: float, tax_rate_percent: float, fulfillment_fee_usd: float) -> str:
    price = Decimal(str(package_price))
    charge = (
        price
        + service_fee(package_price)
        + price * Decimal(str(tax_rate_percent)) / Decimal("100")
        + Decimal(str(fulfillment_fee_usd))
    )
    # Half-up to two decimals, matching scripts/gen-catalog.mjs (JS toFixed).
    return f"${charge.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)}"


def usd(amount: float) -> str:
    return f"${Decimal(str(amount)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)}"


def merchant_price(package_price: float) -> str:
    return f"${Decimal(str(package_price)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)}"


def publish_products(
    job_id: str,
    nickname: str,
    display_name: str,
    url: str,
    items: list[dict],
    *,
    fulfillment: str = "shipping",
    tax_rate_percent: float = 0.0,
    fulfillment_fee_usd: float = 0.0,
    tax_estimate_method: str = "unknown",
    tax_estimate_evidence: str = "No evidence recorded.",
    fulfillment_fee_method: str = "unknown",
    fulfillment_fee_evidence: str = "No evidence recorded.",
) -> list[str]:
    """Convert validated catalog items to TS-shape products and publish them.

    `items` follow the catalog-JSON product shape from onboard_merchant.py:
    durable_id, part_number (the item name), description, options,
    package_price, url. Returns the published product ids.

    These Redis writes are the single publication path — mock mode and real
    onboarding both end up here, so the TS side sees identical data.
    """
    now = datetime.now(UTC).isoformat(timespec="seconds")

    # Re-onboarding replaces the merchant's catalog: the browse may select a
    # different item set each run, so remove any previously published ids
    # that are not in the new set — otherwise stale products (old pricing,
    # old fields) linger in the merged catalog forever.
    previous_ids: list[str] = []
    try:
        raw_summary = redis(["HGET", "merchants:index", nickname])
        if raw_summary:
            previous_ids = list(json.loads(str(raw_summary)).get("product_ids") or [])
    except Exception:  # noqa: BLE001 — a broken summary must not block publishing
        previous_ids = []

    product_ids: list[str] = []
    for item in items:
        name = str(item["part_number"])
        options = str(item.get("options") or "")
        if options:
            name = f"{name} ({options})"
        package_price = float(item["package_price"])
        product = {
            "id": str(item["durable_id"]),
            "name": name,
            "description": str(item.get("description") or name),
            "price_usd": x402_price(package_price, tax_rate_percent, fulfillment_fee_usd),
            "merchant_price_usd": merchant_price(package_price),
            "service_fee_usd": usd(float(service_fee(package_price))),
            "est_tax_usd": usd(package_price * tax_rate_percent / 100),
            "est_fulfillment_fee_usd": usd(fulfillment_fee_usd),
            "tax_estimate_method": tax_estimate_method,
            "tax_estimate_evidence": tax_estimate_evidence,
            "fulfillment_fee_method": fulfillment_fee_method,
            "fulfillment_fee_evidence": fulfillment_fee_evidence,
            "fulfillment": fulfillment,
            "source_url": str(item.get("url") or url),
            "merchant": nickname,
            "onboarded_at": now,
        }
        redis(["HSET", "catalog:dynamic", product["id"], json.dumps(product)])
        product_ids.append(product["id"])
    stale = [pid for pid in previous_ids if pid not in product_ids]
    if stale:
        redis(["HDEL", "catalog:dynamic", *stale])
        publish(job_id, "catalog", f"Removed {len(stale)} stale product(s) from the previous onboarding")
    summary = {
        "display_name": display_name,
        "url": url,
        "product_count": len(product_ids),
        "onboarded_at": now,
        "job_id": job_id,
        "product_ids": product_ids,
    }
    redis(["HSET", "merchants:index", nickname, json.dumps(summary)])
    return product_ids


def mock_items(nickname: str, url: str) -> list[dict]:
    """A small canned catalog shaped exactly like a real validated one."""
    samples = [
        ("Side of Garlic Bread", "Two slices, toasted to order.", 3.50),
        ("House Lemonade", "Fresh-squeezed, 16 oz.", 4.25),
        ("Chocolate Chip Cookie", "Baked daily.", 2.75),
    ]
    items = []
    for position, (name, description, price) in enumerate(samples, start=1):
        items.append(
            {
                "position": position,
                "durable_id": f"{nickname}:{slugify(name)}",
                "part_number": name,
                "description": description,
                "section": "Mock Menu",
                "options": "",
                "package_quantity": 1,
                "package_price": price,
                "currency": "USD",
                "url": url,
            }
        )
    return items


def handle_mock(job_id: str, url: str, nickname: str, display_name: str) -> None:
    """Canned browse: same event cadence and Redis writes, no H session."""
    steps = [
        ("onboard", f"Onboarding merchant {nickname!r} from {url} (MOCK MODE — no real browse)"),
        ("live_view", "Mock browser session started (no live view in mock mode)"),
        ("checkpoint", "initial-state"),
        ("agent", "Page loaded; ordering appears available. Reading menu sections..."),
        ("checkpoint", "menu-items"),
        ("agent", "Browse finished: status=completed outcome=success"),
    ]
    for stage, message in steps:
        publish(job_id, stage, message)
        time.sleep(1)
    items = mock_items(nickname, url)
    publish(job_id, "catalog", f"Validated catalog built ({len(items)} products)")
    product_ids = publish_products(
        job_id,
        nickname,
        display_name,
        url,
        items,
        fulfillment="pickup",
        tax_rate_percent=8.63,
        fulfillment_fee_usd=0.0,
        tax_estimate_method="locale_inference",
        tax_estimate_evidence="Mock merchant location is San Francisco, California.",
        fulfillment_fee_method="pickup_zero",
        fulfillment_fee_evidence="Mock catalog is configured for pickup.",
    )
    finish_success(job_id, nickname, display_name, product_ids)


def handle_real(job_id: str, url: str, nickname: str, max_products: int) -> None:
    # Imported lazily: onboard_merchant pulls in the H client stack, which
    # mock mode must not depend on.
    from onboard_merchant import run_onboarding

    result = run_onboarding(
        url,
        nickname,
        count=max_products,
        on_event=lambda stage, message: publish(job_id, stage, message),
    )
    items = list(result.payload["products"])
    payload = result.payload
    product_ids = publish_products(
        job_id,
        result.merchant.nickname,
        result.merchant.display_name,
        url,
        items,
        fulfillment=str(payload.get("fulfillment") or "shipping"),
        tax_rate_percent=float(payload.get("estimated_tax_rate_percent") or 0.0),
        # None means the agent could not confirm the fee. If it DID confirm
        # pickup, no fee is coherent (picking up is free); only an
        # unconfirmed/shipping mode gets the conservative $15 placeholder.
        fulfillment_fee_usd=(
            float(payload.get("estimated_fulfillment_fee_usd"))
            if payload.get("estimated_fulfillment_fee_usd") is not None
            else (0.0 if payload.get("fulfillment") == "pickup" else SHIPPING_FALLBACK_USD)
        ),
        tax_estimate_method=str(payload.get("tax_estimate_method") or "unknown"),
        tax_estimate_evidence=str(
            payload.get("tax_estimate_evidence") or "No evidence recorded."
        ),
        fulfillment_fee_method=str(payload.get("fulfillment_fee_method") or "unknown"),
        fulfillment_fee_evidence=str(
            payload.get("fulfillment_fee_evidence") or "No evidence recorded."
        ),
    )
    finish_success(job_id, result.merchant.nickname, result.merchant.display_name, product_ids)


def finish_success(
    job_id: str, nickname: str, display_name: str, product_ids: list[str]
) -> None:
    set_status(
        job_id,
        "succeeded",
        {
            "merchant": nickname,
            "display_name": display_name,
            "product_count": len(product_ids),
            "product_ids": product_ids,
        },
    )
    publish(
        job_id,
        "worker",
        f"Onboarding complete: {display_name} is live with {len(product_ids)} "
        "x402-purchasable product(s). See GET /products.",
    )


def handle_job(job_id: str) -> None:
    job = get_job(job_id)
    if not job:
        print(f"[onboard-worker] job {job_id} not found in store; skipping", flush=True)
        return

    url = job.get("url", "")
    nickname = job.get("nickname") or nickname_from_url(url)
    display_name = job.get("display_name") or nickname
    max_products = max(1, min(10, int(job.get("max_products") or 5)))

    set_status(job_id, "running")
    publish(
        job_id,
        "worker",
        f"Onboarding started for {url} "
        f"({'MOCK MODE' if MOCK else 'live browser agent'}).",
    )

    try:
        if MOCK:
            handle_mock(job_id, url, nickname, display_name)
        else:
            handle_real(job_id, url, nickname, max_products)
    except Exception as exc:  # noqa: BLE001 — surface the blocker, mark failed
        # OnboardError carries the blocker text (e.g. "ordering unavailable —
        # store is closed"); anything else is an unexpected crash.
        reason = str(exc) or type(exc).__name__
        set_status(job_id, "failed", {"error": reason})
        publish(job_id, "worker", f"Onboarding failed: {reason}")
        print(f"[onboard-worker] job {job_id} failed: {reason}", flush=True)


def main() -> None:
    if not REDIS_URL or not REDIS_TOKEN:
        raise SystemExit("KV_REST_API_URL / KV_REST_API_TOKEN must be set (Upstash REST)")
    mode = "MOCK MODE (canned catalogs)" if MOCK else "live H browse"
    print(
        f"[onboard-worker] polling onboard:queue every {POLL_SECONDS:.0f}s ({mode})",
        flush=True,
    )
    while True:
        try:
            job_id = redis(["RPOP", "onboard:queue"])
        except Exception as exc:  # noqa: BLE001 — keep polling through transient errors
            print(f"[onboard-worker] queue poll failed: {exc}", flush=True)
            time.sleep(POLL_SECONDS)
            continue
        if not job_id:
            time.sleep(POLL_SECONDS)
            continue
        print(f"[onboard-worker] picked up job {job_id}", flush=True)
        try:
            handle_job(str(job_id))
        except Exception as exc:  # noqa: BLE001 — one bad job must not kill the loop
            print(f"[onboard-worker] job {job_id} crashed: {exc}", flush=True)
            try:
                set_status(str(job_id), "failed", {"error": str(exc)})
                publish(str(job_id), "worker", f"Worker error: {exc}")
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    main()
