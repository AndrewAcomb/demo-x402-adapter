"""Merchant registry: nickname -> ordering-page config for H fulfillment."""

from __future__ import annotations

import json
import re
from pathlib import Path

from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "runtime"
REGISTRY_PATH = RUNTIME / "merchants.json"

MCMASTER_START_URL = (
    "https://www.mcmaster.com/products/screws/rounded-head-screws-2~/"
    "steel-pan-head-phillips-screws~~/"
)

NICKNAME_PATTERN = re.compile(r"^[a-z][a-z0-9-]{1,30}$")


class Merchant(BaseModel):
    nickname: str = Field(pattern=NICKNAME_PATTERN.pattern)
    display_name: str = Field(min_length=1)
    kind: str = Field(pattern=r"^(mcmaster|web)$")
    start_url: str = Field(min_length=8)
    fulfillment: str = Field(default="pickup", pattern=r"^(pickup|shipping)$")
    requires_login: bool = False
    catalog_short_name: str = Field(min_length=1)

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
)


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return slug or "item"


def load_registry() -> dict[str, Merchant]:
    merchants: dict[str, Merchant] = {MCMASTER.nickname: MCMASTER}
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
