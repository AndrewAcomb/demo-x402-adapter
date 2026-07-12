#!/usr/bin/env python
"""Validate H-discovered merchant catalogs and publish the x402 TypeScript catalog.

This is intentionally a build step, not a browser workflow. It never invokes H,
touches a cart, or performs a purchase. Its only writes are the canonical catalog
source manifests and the generated ``src/catalog.ts`` file.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import sys
from decimal import Decimal, ROUND_CEILING
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, model_validator

from merchants import Merchant

PYTHON_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PYTHON_ROOT.parent
DEFAULT_SOURCES_DIR = REPO_ROOT / "catalog" / "merchant-catalogs"
DEFAULT_OUTPUT = REPO_ROOT / "src" / "catalog.ts"
GENERATOR_VERSION = 1
CENT = Decimal("0.01")
DURABLE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{1,30}:[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")


class CatalogProvenance(BaseModel):
    discovered_by: str = Field(min_length=1)
    discovery_mode: str = Field(pattern=r"^browse-only$")
    purchase_actions_permitted: bool = False
    source_artifact: str = Field(min_length=1)
    h_session_id: str | None = None

    @model_validator(mode="after")
    def reject_purchase_capability(self) -> CatalogProvenance:
        if self.purchase_actions_permitted:
            raise ValueError("onboarding provenance must prove purchases were disabled")
        return self


class CatalogProduct(BaseModel):
    """The common subset emitted by both McMaster and generic H discovery."""

    model_config = ConfigDict(extra="allow")

    position: int = Field(ge=1, le=10_000)
    durable_id: str = Field(pattern=DURABLE_ID_PATTERN.pattern)
    part_number: str = Field(min_length=1, max_length=300)
    description: str = Field(min_length=1, max_length=2_000)
    section: str = Field(default="", max_length=300)
    options: str = Field(default="", max_length=500)
    package_quantity: int = Field(default=1, ge=1, le=100_000)
    package_price: Decimal = Field(gt=0, le=Decimal("1000000"))
    currency: str = Field(min_length=3, max_length=3)
    url: str = Field(min_length=8, max_length=2_000)

    @model_validator(mode="after")
    def normalize_and_validate(self) -> CatalogProduct:
        self.currency = self.currency.upper()
        self.part_number = " ".join(self.part_number.split())
        self.description = " ".join(self.description.split())
        self.section = " ".join(self.section.split())
        self.options = " ".join(self.options.split())
        if self.package_price != self.package_price.quantize(CENT):
            raise ValueError("package_price must have at most two decimal places")
        parsed = urlparse(self.url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError("product url must be an absolute HTTPS URL")
        return self


class PublishableCatalog(BaseModel):
    schema_version: int = Field(default=1, ge=1, le=1)
    merchant: Merchant
    provenance: CatalogProvenance
    pickup_available: bool = False
    delivery_available: bool = False
    products: list[CatalogProduct] = Field(min_length=1, max_length=10_000)

    @model_validator(mode="after")
    def validate_contract(self) -> PublishableCatalog:
        if self.merchant.pricing.currency != "USD":
            raise ValueError("x402 auto-publishing currently supports USD catalogs only")
        positions = [product.position for product in self.products]
        if len(positions) != len(set(positions)):
            raise ValueError("product positions must be unique")
        durable_ids = [product.durable_id for product in self.products]
        if len(durable_ids) != len(set(durable_ids)):
            raise ValueError("durable ids must be unique within a merchant catalog")
        expected_prefix = f"{self.merchant.nickname}:"
        merchant_host = urlparse(self.merchant.start_url).hostname
        for product in self.products:
            if product.currency != self.merchant.pricing.currency:
                raise ValueError(
                    f"{product.durable_id}: currency {product.currency} does not match "
                    f"merchant pricing currency {self.merchant.pricing.currency}"
                )
            if not product.durable_id.startswith(expected_prefix):
                raise ValueError(
                    f"{product.durable_id}: durable id must start with {expected_prefix!r}"
                )
            if urlparse(product.url).hostname != merchant_host:
                raise ValueError(
                    f"{product.durable_id}: product URL host must match merchant start_url"
                )
        self.products.sort(key=lambda item: (item.position, item.durable_id))
        return self


def money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_CEILING)


def pricing_breakdown(product: CatalogProduct, merchant: Merchant) -> dict[str, str | int | bool]:
    policy = merchant.pricing
    subtotal = money(product.package_price)
    tax = money(subtotal * Decimal(policy.tax_buffer_bps) / Decimal(10_000))
    proportional_fee = money(
        subtotal * Decimal(policy.service_markup_bps) / Decimal(10_000)
    )
    service_fee = max(proportional_fee, policy.minimum_service_fee_usd)
    shipping = money(policy.shipping_buffer_usd)
    total = money(subtotal + tax + service_fee + shipping)
    return {
        "merchant_subtotal_usd": f"{subtotal:.2f}",
        "estimated_tax_buffer_usd": f"{tax:.2f}",
        "shipping_buffer_usd": f"{shipping:.2f}",
        "service_fee_usd": f"{service_fee:.2f}",
        "service_markup_bps": policy.service_markup_bps,
        "all_inclusive": True,
        "total_usd": f"{total:.2f}",
    }


def product_name(product: CatalogProduct) -> str:
    extras = product.model_extra or {}
    if extras.get("thread_size") and extras.get("length"):
        base = f"{product.description.split(',')[0]} {extras['thread_size']} x {extras['length']}"
    else:
        base = product.part_number
        if product.options:
            base = f"{base} — {product.options}"
    if product.package_quantity != 1:
        base = f"{base} (pack of {product.package_quantity})"
    return base


def product_description(product: CatalogProduct, merchant: Merchant) -> str:
    description = product.description
    details: list[str] = []
    if product.package_quantity != 1 and "package" not in description.casefold():
        details.append(f"Package of {product.package_quantity}.")
    if merchant.kind == "mcmaster" and product.part_number not in description:
        details.append(f"McMaster-Carr part {product.part_number}.")
    return " ".join([description, *details]).strip()


def canonical_json(catalog: PublishableCatalog) -> str:
    return json.dumps(
        catalog.model_dump(mode="json", exclude_none=True),
        indent=2,
        sort_keys=True,
    ) + "\n"


def load_catalog(path: Path) -> PublishableCatalog:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read catalog {path}: {exc}") from exc
    try:
        return PublishableCatalog.model_validate(payload)
    except Exception as exc:
        raise ValueError(f"catalog validation failed for {path}: {exc}") from exc


def load_sources(source_dir: Path, replacements: dict[str, PublishableCatalog]) -> list[PublishableCatalog]:
    catalogs: dict[str, PublishableCatalog] = {}
    if source_dir.is_dir():
        for path in sorted(source_dir.glob("*.json")):
            catalog = load_catalog(path)
            expected = f"{catalog.merchant.nickname}.json"
            if path.name != expected:
                raise ValueError(f"{path}: canonical source filename must be {expected}")
            if catalog.merchant.nickname in catalogs:
                raise ValueError(f"duplicate merchant source: {catalog.merchant.nickname}")
            catalogs[catalog.merchant.nickname] = catalog
    catalogs.update(replacements)
    if not catalogs:
        raise ValueError(f"no merchant catalogs found in {source_dir}")
    return [catalogs[nickname] for nickname in sorted(catalogs)]


def source_digest(catalog: PublishableCatalog) -> str:
    return hashlib.sha256(canonical_json(catalog).encode()).hexdigest()


def render_typescript(catalogs: list[PublishableCatalog]) -> str:
    all_products: list[tuple[PublishableCatalog, CatalogProduct]] = []
    seen_ids: set[str] = set()
    for merchant_catalog in catalogs:
        for product in merchant_catalog.products:
            if product.durable_id in seen_ids:
                raise ValueError(f"duplicate durable id across catalogs: {product.durable_id}")
            seen_ids.add(product.durable_id)
            all_products.append((merchant_catalog, product))

    manifests = [
        {
            "merchant": catalog.merchant.nickname,
            "sha256": source_digest(catalog),
            "source": f"catalog/merchant-catalogs/{catalog.merchant.nickname}.json",
        }
        for catalog in catalogs
    ]
    entries: list[str] = []
    for merchant_catalog, product in all_products:
        merchant = merchant_catalog.merchant
        breakdown = pricing_breakdown(product, merchant)
        entry = {
            "id": product.durable_id,
            "merchant": {
                "nickname": merchant.nickname,
                "display_name": merchant.display_name,
                "fulfillment": merchant.fulfillment,
            },
            "name": product_name(product),
            "description": product_description(product, merchant),
            "price_usd": f"${breakdown['total_usd']}",
            "merchant_price_usd": f"${breakdown['merchant_subtotal_usd']}",
            "pricing": breakdown,
            "source_url": product.url,
        }
        key = json.dumps(product.durable_id)
        body = json.dumps(entry, indent=2, ensure_ascii=False)
        indented = "\n".join(f"  {line}" for line in body.splitlines())
        entries.append(f"  {key}: {indented[2:]},")

    test_item = """  'test-item': {
    id: 'test-item',
    name: 'Test Item (integration test, no fulfillment)',
    description:
      'A ten-cent item for testing the x402 purchase flow end to end. ' +
      'Fulfillment completes immediately without contacting any merchant.',
    price_usd: '$0.10',
  },"""
    manifest_json = json.dumps(manifests, indent=2)
    manifest_indented = "\n".join(f"  {line}" for line in manifest_json.splitlines())
    entries_text = "\n".join(entries)
    return f"""/**
 * Product catalog — GENERATED by python/catalog_publisher.py.
 *
 * Do not edit by hand. Canonical, validated inputs live under
 * catalog/merchant-catalogs/. Run `npm run catalog:generate` to regenerate or
 * `npm run catalog:check` to detect drift.
 */

export interface ProductPricing {{
  merchant_subtotal_usd: string;
  estimated_tax_buffer_usd: string;
  shipping_buffer_usd: string;
  service_fee_usd: string;
  service_markup_bps: number;
  all_inclusive: true;
  total_usd: string;
}}

export interface Product {{
  id: string;
  merchant?: {{
    nickname: string;
    display_name: string;
    fulfillment: 'pickup' | 'shipping';
  }};
  name: string;
  description: string;
  /** All-inclusive USDC price charged via x402, in dollars. */
  price_usd: string;
  /** Underlying merchant package price before buffers and service fee. */
  merchant_price_usd?: string;
  pricing?: ProductPricing;
  /** Internal fulfillment target; omitted from public API responses. */
  source_url?: string;
}}

export const catalogProvenance = {{
  generator: 'python/catalog_publisher.py',
  generator_version: {GENERATOR_VERSION},
  manifests: {manifest_indented[2:]},
}} as const;

export const catalog: Record<string, Product> = {{
{entries_text}
{test_item}
}};

export function listProducts() {{
  return Object.values(catalog).map(({{ source_url, ...rest }}) => rest);
}}

export function getProduct(id: string): Product | undefined {{
  return catalog[id];
}}
"""


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)


def diff_text(path: Path, proposed: str) -> str:
    current = path.read_text(encoding="utf-8") if path.is_file() else ""
    return "".join(
        difflib.unified_diff(
            current.splitlines(keepends=True),
            proposed.splitlines(keepends=True),
            fromfile=str(path),
            tofile=f"{path} (proposed)",
            n=2,
        )
    )


def publish_catalogs(
    input_paths: list[Path],
    *,
    source_dir: Path = DEFAULT_SOURCES_DIR,
    output_path: Path = DEFAULT_OUTPUT,
    dry_run: bool = False,
    check: bool = False,
) -> tuple[bool, list[PublishableCatalog]]:
    if dry_run and check:
        raise ValueError("--dry-run and --check are mutually exclusive")
    replacements: dict[str, PublishableCatalog] = {}
    for path in input_paths:
        catalog = load_catalog(path)
        nickname = catalog.merchant.nickname
        if nickname in replacements:
            raise ValueError(f"multiple input catalogs for merchant {nickname!r}")
        replacements[nickname] = catalog

    catalogs = load_sources(source_dir, replacements)
    proposed_output = render_typescript(catalogs)
    changed = bool(diff_text(output_path, proposed_output))
    source_changes: list[tuple[Path, str]] = []
    for nickname, catalog in replacements.items():
        path = source_dir / f"{nickname}.json"
        content = canonical_json(catalog)
        if not path.is_file() or path.read_text(encoding="utf-8") != content:
            source_changes.append((path, content))

    would_change = changed or bool(source_changes)
    if dry_run or check:
        mode = "CHECK" if check else "DRY RUN"
        print(
            f"{mode}: {len(catalogs)} merchant(s), "
            f"{sum(len(c.products) for c in catalogs)} real product(s); "
            f"{'changes required' if would_change else 'already current'}"
        )
        for catalog in catalogs:
            prices = [
                Decimal(str(pricing_breakdown(product, catalog.merchant)["total_usd"]))
                for product in catalog.products
            ]
            print(
                f"  {catalog.merchant.nickname}: {len(prices)} products, "
                f"${min(prices):.2f}–${max(prices):.2f} all-inclusive"
            )
        if changed:
            preview = diff_text(output_path, proposed_output)
            print("\n" + "".join(preview.splitlines(keepends=True)[:80]), end="")
        return would_change, catalogs

    for path, content in source_changes:
        atomic_write(path, content)
    atomic_write(output_path, proposed_output)
    print(
        f"Published {sum(len(c.products) for c in catalogs)} real product(s) from "
        f"{len(catalogs)} merchant(s) to {output_path}"
    )
    for path, _ in source_changes:
        print(f"  promoted canonical source: {path}")
    return would_change, catalogs


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Safely publish validated, browse-only H catalogs into x402 TypeScript."
    )
    parser.add_argument(
        "catalogs",
        nargs="*",
        type=Path,
        help="validated H catalog(s) to promote; omit to regenerate canonical sources",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="validate and preview without writing")
    mode.add_argument("--check", action="store_true", help="fail if sources or generated output drift")
    parser.add_argument("--sources-dir", type=Path, default=DEFAULT_SOURCES_DIR)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    try:
        changed, _ = publish_catalogs(
            args.catalogs,
            source_dir=args.sources_dir,
            output_path=args.output,
            dry_run=args.dry_run,
            check=args.check,
        )
    except ValueError as exc:
        parser.error(str(exc))
    if args.check and changed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
