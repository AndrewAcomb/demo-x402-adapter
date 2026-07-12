"""Merchant registry: nickname -> ordering-page config for H fulfillment."""

from __future__ import annotations

import json
import re
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlparse

from pydantic import BaseModel, Field, model_validator

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "runtime"
REGISTRY_PATH = RUNTIME / "merchants.json"
CANONICAL_CATALOGS_PATH = ROOT.parent / "catalog" / "merchant-catalogs"

MCMASTER_START_URL = (
    "https://www.mcmaster.com/products/screws/rounded-head-screws-2~/"
    "steel-pan-head-phillips-screws~~/"
)

NICKNAME_PATTERN = re.compile(r"^[a-z][a-z0-9-]{1,30}$")


class PricingPolicy(BaseModel):
    """Conservative all-inclusive USD pricing for an x402 storefront.

    The buffers are explicit instead of being hidden in one magic multiplier.
    This makes the generated charge auditable and lets each merchant choose a
    policy that covers its actual fulfillment path.
    """

    currency: str = Field(default="USD", pattern=r"^USD$")
    service_markup_bps: int = Field(default=1500, ge=0, le=10_000)
    tax_buffer_bps: int = Field(default=1000, ge=0, le=5_000)
    shipping_buffer_usd: Decimal = Field(default=Decimal("0.00"), ge=0)
    minimum_service_fee_usd: Decimal = Field(default=Decimal("1.00"), ge=0)

    @model_validator(mode="after")
    def validate_cents(self) -> PricingPolicy:
        for name in ("shipping_buffer_usd", "minimum_service_fee_usd"):
            value = getattr(self, name)
            if value != value.quantize(Decimal("0.01")):
                raise ValueError(f"{name} must have at most two decimal places")
        return self


class Merchant(BaseModel):
    nickname: str = Field(pattern=NICKNAME_PATTERN.pattern)
    display_name: str = Field(min_length=1)
    kind: str = Field(pattern=r"^(mcmaster|web)$")
    start_url: str = Field(min_length=8)
    fulfillment: str = Field(default="pickup", pattern=r"^(pickup|shipping)$")
    requires_login: bool = False
    catalog_short_name: str = Field(min_length=1)
    catalog_mode: str = Field(default="sample", pattern=r"^(sample|full)$")
    pricing: PricingPolicy = Field(default_factory=PricingPolicy)

    @model_validator(mode="after")
    def validate_start_url(self) -> Merchant:
        parsed = urlparse(self.start_url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError("merchant start_url must be an absolute HTTPS URL")
        return self

    def catalog_glob(self) -> str:
        return f"*-{self.catalog_short_name}.json"


MCMASTER = Merchant(
    nickname="mcmaster",
    display_name="McMaster-Carr",
    kind="mcmaster",
    start_url=MCMASTER_START_URL,
    fulfillment="shipping",
    requires_login=True,
    catalog_short_name="mcmaster-screws",
    pricing=PricingPolicy(shipping_buffer_usd=Decimal("15.00")),
)


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return slug or "item"


def load_registry() -> dict[str, Merchant]:
    merchants: dict[str, Merchant] = {MCMASTER.nickname: MCMASTER}
    # Published catalogs are the durable, checked-in registry. The ignored
    # runtime registry remains an onboarding workspace and may override a
    # published entry until its refreshed catalog is promoted.
    if CANONICAL_CATALOGS_PATH.is_dir():
        for path in sorted(CANONICAL_CATALOGS_PATH.glob("*.json")):
            payload = json.loads(path.read_text(encoding="utf-8"))
            merchant = Merchant.model_validate(payload["merchant"])
            if path.name != f"{merchant.nickname}.json":
                raise ValueError(
                    f"canonical merchant catalog {path} has the wrong filename"
                )
            merchants[merchant.nickname] = merchant
    if REGISTRY_PATH.is_file():
        payload = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
        for entry in payload.get("merchants", []):
            merchant = Merchant.model_validate(entry)
            merchants[merchant.nickname] = merchant
    return merchants


def save_merchant(merchant: Merchant) -> None:
    if merchant.nickname == MCMASTER.nickname:
        raise ValueError("mcmaster is built in and cannot be overwritten")
    merchants = load_registry()
    merchants[merchant.nickname] = merchant
    stored = [
        entry.model_dump(mode="json")
        for nickname, entry in sorted(merchants.items())
        if nickname != MCMASTER.nickname
    ]
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = REGISTRY_PATH.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps({"merchants": stored}, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(REGISTRY_PATH)


def get_merchant(nickname: str) -> Merchant:
    merchants = load_registry()
    if nickname not in merchants:
        known = ", ".join(sorted(merchants))
        raise KeyError(f"Unknown merchant {nickname!r}; known merchants: {known}")
    return merchants[nickname]


def nickname_from_url(url: str) -> str:
    tail = [part for part in url.split("/") if part][-1]
    slug = slugify(tail)[:31]
    if not NICKNAME_PATTERN.match(slug):
        slug = f"m-{slug}"[:31].rstrip("-")
    return slug
