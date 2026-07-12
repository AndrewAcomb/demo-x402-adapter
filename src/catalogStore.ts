/**
 * Merged product catalog: static (generated src/catalog.ts) + dynamic
 * (Redis hash `catalog:dynamic`, written by python/onboard_worker.py when a
 * merchant is onboarded through POST /merchants).
 *
 * Dynamic entries are full Product JSON blobs keyed by product id. The static
 * catalog always wins on id conflicts so a bad onboarding run can never
 * shadow a known-good product.
 *
 * A tiny in-memory cache (15s TTL, lazily filled on the request path — no
 * timers, Vercel-safe) keeps lookups cheap. Price-safety invariant: the x402
 * middleware re-resolves the price on the paid retry and rejects a payment
 * whose amount no longer matches, and an unknown/stale product id 404s in the
 * handler, which cancels the verified payment before settlement — so a wrong
 * price is never settled.
 */

import { catalog as staticCatalog, getProduct as getStaticProduct, listProducts as listStaticProducts, type Product } from './catalog.js';
import { ordersConfigured, redisCommand } from './orders.js';

export interface DynamicProduct extends Product {
  /** Merchant registry nickname (e.g. "littlestar") this product belongs to. */
  merchant?: string;
  /** ISO timestamp of the onboarding run that published this product. */
  onboarded_at?: string;
}

const CACHE_TTL_MS = 15_000;

let cache: { at: number; products: Map<string, DynamicProduct> } | undefined;
let inflight: Promise<Map<string, DynamicProduct>> | undefined;

function parseDynamic(raw: string[] | null): Map<string, DynamicProduct> {
  const products = new Map<string, DynamicProduct>();
  if (!raw) return products;
  for (let i = 0; i < raw.length; i += 2) {
    try {
      const product = JSON.parse(raw[i + 1]) as DynamicProduct;
      if (
        product &&
        typeof product.id === 'string' &&
        typeof product.name === 'string' &&
        typeof product.price_usd === 'string' &&
        /^\$\d+(\.\d{2})?$/.test(product.price_usd)
      ) {
        products.set(raw[i], product);
      }
    } catch {
      // Skip malformed entries; never let one bad row break the catalog.
    }
  }
  return products;
}

/**
 * The current dynamic-catalog snapshot (fresh within CACHE_TTL_MS). Returns
 * an empty map when the store is unconfigured, and the last good snapshot
 * when Redis is temporarily unreachable.
 */
export async function dynamicProducts(): Promise<Map<string, DynamicProduct>> {
  if (!ordersConfigured) return new Map();
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.products;
  if (!inflight) {
    inflight = redisCommand(['HGETALL', 'catalog:dynamic'])
      .then((raw) => {
        const products = parseDynamic(raw as string[] | null);
        cache = { at: Date.now(), products };
        return products;
      })
      .catch((e) => {
        console.error('[catalog] dynamic fetch failed:', (e as Error).message);
        return cache?.products ?? new Map<string, DynamicProduct>();
      })
      .finally(() => {
        inflight = undefined;
      });
  }
  return inflight;
}

/** One product by id — static catalog first, then the dynamic snapshot. */
export async function getMergedProduct(id: string): Promise<DynamicProduct | undefined> {
  return getStaticProduct(id) ?? (await dynamicProducts()).get(id);
}

/** All products (static + dynamic, static wins on id) without source_url. */
export async function listMergedProducts(): Promise<Omit<DynamicProduct, 'source_url'>[]> {
  const dynamic = await dynamicProducts();
  const extras = [...dynamic.values()]
    .filter((p) => !(p.id in staticCatalog))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ source_url: _source_url, ...rest }) => rest);
  return [...listStaticProducts(), ...extras];
}
