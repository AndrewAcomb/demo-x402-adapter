from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from add_cached_to_cart import newest_catalog
from catalog_publisher import load_catalog, publish_catalogs
from worker import merchant_for_order


def sample_catalog(*, nickname: str = "sample-shop", purchase_allowed: bool = False) -> dict:
    return {
        "schema_version": 1,
        "merchant": {
            "nickname": nickname,
            "display_name": "Sample Shop",
            "kind": "web",
            "start_url": "https://shop.example/order",
            "fulfillment": "pickup",
            "requires_login": False,
            "catalog_short_name": nickname,
            "catalog_mode": "sample",
            "pricing": {
                "currency": "USD",
                "service_markup_bps": 1500,
                "tax_buffer_bps": 1000,
                "shipping_buffer_usd": "0.00",
                "minimum_service_fee_usd": "1.00",
            },
        },
        "provenance": {
            "discovered_by": "H Company computer-use agent",
            "discovery_mode": "browse-only",
            "purchase_actions_permitted": purchase_allowed,
            "source_artifact": "python/runtime/sessions/S001",
            "h_session_id": "demo-session",
        },
        "pickup_available": True,
        "delivery_available": False,
        "products": [
            {
                "position": 1,
                "durable_id": f"{nickname}:brass-screw",
                "part_number": "Brass screw",
                "description": "One polished brass screw",
                "section": "Hardware",
                "options": "",
                "package_quantity": 1,
                "package_price": "10.00",
                "currency": "USD",
                "url": "https://shop.example/order",
            }
        ],
    }


class CatalogPublisherTests(unittest.TestCase):
    def write_input(self, root: Path, payload: dict) -> Path:
        path = root / "h-output.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_publish_is_idempotent_and_prices_are_auditable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path = self.write_input(root, sample_catalog())
            sources = root / "sources"
            output = root / "catalog.ts"

            changed, catalogs = publish_catalogs(
                [input_path], source_dir=sources, output_path=output
            )
            first = output.read_text(encoding="utf-8")
            changed_again, _ = publish_catalogs(
                [], source_dir=sources, output_path=output
            )

            self.assertTrue(changed)
            self.assertFalse(changed_again)
            self.assertEqual(first, output.read_text(encoding="utf-8"))
            self.assertEqual(catalogs[0].merchant.nickname, "sample-shop")
            self.assertIn('"price_usd": "$12.50"', first)
            self.assertIn('"merchant_subtotal_usd": "10.00"', first)
            self.assertIn('"service_fee_usd": "1.50"', first)
            self.assertIn('"merchant": {', first)
            self.assertIn('"nickname": "sample-shop"', first)
            self.assertIn('"source_url": "https://shop.example/order"', first)

    def test_check_detects_generated_drift_without_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path = self.write_input(root, sample_catalog())
            sources = root / "sources"
            output = root / "catalog.ts"
            publish_catalogs([input_path], source_dir=sources, output_path=output)
            output.write_text("// hand edit\n", encoding="utf-8")

            changed, _ = publish_catalogs(
                [], source_dir=sources, output_path=output, check=True
            )
            self.assertTrue(changed)
            self.assertEqual(output.read_text(encoding="utf-8"), "// hand edit\n")

    def test_rejects_purchase_capable_onboarding_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path = self.write_input(
                root, sample_catalog(purchase_allowed=True)
            )
            with self.assertRaisesRegex(ValueError, "purchases were disabled"):
                load_catalog(input_path)

    def test_rejects_durable_id_for_another_merchant(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = sample_catalog()
            payload["products"][0]["durable_id"] = "wrong-shop:brass-screw"
            input_path = self.write_input(root, payload)
            with self.assertRaisesRegex(ValueError, "durable id must start"):
                load_catalog(input_path)

    def test_worker_routes_to_persisted_merchant_and_fails_closed(self) -> None:
        self.assertEqual(
            merchant_for_order(
                {"merchant": "sample-shop", "product_id": "sample-shop:brass-screw"}
            ),
            "sample-shop",
        )
        with self.assertRaisesRegex(ValueError, "does not belong"):
            merchant_for_order(
                {"merchant": "mcmaster", "product_id": "sample-shop:brass-screw"}
            )

    def test_fulfillment_can_use_checked_in_catalog_without_runtime_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            runtime.mkdir()
            canonical = root / "sample-shop.json"
            canonical.write_text("{}\n", encoding="utf-8")
            self.assertEqual(
                newest_catalog(runtime, "*-sample-shop.json", fallback=canonical),
                canonical,
            )


if __name__ == "__main__":
    unittest.main()
