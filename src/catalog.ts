/**
 * Static product catalog for the vitamin-adapter demo.
 *
 * A real merchant would source this from their commerce backend
 * (Shopify, WooCommerce, direct DB) — for the MMVP we hard-code
 * two SKUs so the demo runs without any external dependencies.
 *
 * When a purchase completes, the fulfillment step (computer-use
 * against the underlying merchant's checkout) receives this record
 * plus the buyer's shipping details.
 */

export interface Product {
  id: string;
  name: string;
  description: string;
  /** USDC price, in dollars, as a string. The x402 middleware parses "$0.10" style. */
  price_usd: string;
  /** Optional: URL of the underlying merchant's product page — the target of computer-use fulfillment. */
  source_url?: string;
}

export const catalog: Record<string, Product> = {
  'vit-d-30': {
    id: 'vit-d-30',
    name: 'Vitamin D3 2000 IU (30 softgels)',
    description: 'Once-daily vitamin D3 for immune and bone health.',
    price_usd: '$0.10',
    source_url: 'https://example.com/vitamin-d-3-2000-iu',
  },
  'vit-c-60': {
    id: 'vit-c-60',
    name: 'Vitamin C 1000 mg (60 tablets)',
    description: 'Once-daily vitamin C for immune support.',
    price_usd: '$0.10',
    source_url: 'https://example.com/vitamin-c-1000-mg',
  },
};

export function listProducts() {
  return Object.values(catalog).map(({ source_url, ...rest }) => rest);
}

export function getProduct(id: string): Product | undefined {
  return catalog[id];
}
