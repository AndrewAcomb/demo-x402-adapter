#!/usr/bin/env node
/**
 * Generate src/catalog.ts from a python fulfillment-side catalog JSON
 * (the validated McMaster runs under python/runtime/catalogs/ or python/out/).
 *
 * Usage: node scripts/gen-catalog.mjs <path-to-catalog.json>
 *
 * Product ids are the durable ids (e.g. "mcmaster:92224A100") — the shared
 * contract with the fulfillment worker. The x402 charge stays DEMO_PRICE
 * (flat, set in src/app.ts); the underlying merchant price is exposed as
 * merchant_price_usd for transparency.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/gen-catalog.mjs <catalog.json>');
  process.exit(1);
}

const data = JSON.parse(readFileSync(src, 'utf8'));
const products = data.products;
if (!Array.isArray(products) || products.length === 0) {
  console.error('no products in', src);
  process.exit(1);
}

const entries = products
  .map((p) => {
    const name = `${p.description.split(',')[0]} ${p.thread_size} x ${p.length} (pack of ${p.package_quantity})`;
    const description = `${p.description} Package of ${p.package_quantity}. McMaster-Carr part ${p.part_number}.`;
    return `  '${p.durable_id}': {
    id: '${p.durable_id}',
    name: ${JSON.stringify(name)},
    description: ${JSON.stringify(description)},
    price_usd: '$0.10',
    merchant_price_usd: ${JSON.stringify(`$${p.package_price.toFixed(2)}`)},
    source_url: ${JSON.stringify(p.url)},
  },`;
  })
  .join('\n');

const out = `/**
 * Product catalog — GENERATED from the fulfillment-side McMaster catalog.
 *
 * Do not edit by hand. Regenerate with:
 *   node scripts/gen-catalog.mjs ${src}
 *
 * Product ids are durable ids shared with the python fulfillment worker.
 * price_usd is the x402 demo charge; merchant_price_usd is the real
 * McMaster package price the fulfillment run will pay.
 */

export interface Product {
  id: string;
  name: string;
  description: string;
  /** USDC price charged via x402, in dollars. The middleware parses "$0.10" style. */
  price_usd: string;
  /** Underlying merchant's real package price (informational). */
  merchant_price_usd?: string;
  /** URL of the underlying merchant's product page — the target of computer-use fulfillment. Not exposed publicly. */
  source_url?: string;
}

export const catalog: Record<string, Product> = {
${entries}
};

export function listProducts() {
  return Object.values(catalog).map(({ source_url, ...rest }) => rest);
}

export function getProduct(id: string): Product | undefined {
  return catalog[id];
}
`;

writeFileSync('src/catalog.ts', out);
console.log(`wrote src/catalog.ts with ${products.length} products from ${src}`);
