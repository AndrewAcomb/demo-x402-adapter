/**
 * x402 Bazaar discovery — the "the agent FOUND the merchant" stage moment.
 *
 * Verified live (2026-07-12): the x402.org facilitator has no discovery
 * endpoint (404), but Coinbase CDP's public Bazaar lists ~25k resources and
 * its natural-language search ranks BuyWith402 first for shopping-flavored
 * queries like "buy physical hardware with USDC: ...". So we search the CDP
 * Bazaar with the buyer's own words and verify the hit by host.
 *
 * Best-effort: any failure (offline, facilitator without a bazaar, merchant
 * not indexed) degrades gracefully to the configured MERCHANT_URL.
 */

import { HTTPFacilitatorClient } from '@x402/core/http';
import { withBazaar } from '@x402/extensions/bazaar';
import type { Config } from './config.js';
import { logError } from './config.js';

export interface DiscoveryResult {
  found: boolean;
  /** Resource URL as listed on the Bazaar, when found. */
  resource?: string;
  serviceName?: string;
  /** 1-based rank in the search results, for narration. */
  rank?: number;
  query?: string;
  note: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export async function discoverMerchant(cfg: Config, intentQuery?: string): Promise<DiscoveryResult> {
  if (cfg.mockMerchant) {
    return {
      found: true,
      resource: `${cfg.merchantUrl}/products/{id}/purchase`,
      serviceName: 'BuyWith402 (mock)',
      rank: 1,
      query: intentQuery,
      note: 'mock merchant — Bazaar lookup simulated',
    };
  }

  const merchantHost = new URL(cfg.merchantUrl).host.replace(/^www\./, '');
  const queries = [
    ...(intentQuery ? [`buy physical hardware with USDC: ${intentQuery}`] : []),
    'physical products shopping hardware commerce',
  ];

  try {
    const client = withBazaar(new HTTPFacilitatorClient({ url: cfg.bazaarUrl }));
    for (const query of queries) {
      const result = await withTimeout(
        client.extensions.bazaar.search({ query, limit: 10 }),
        8000,
        'bazaar search',
      );
      const idx = result.resources.findIndex((item) => {
        try {
          return new URL(item.resource).host.replace(/^www\./, '') === merchantHost;
        } catch {
          return false;
        }
      });
      if (idx >= 0) {
        const hit = result.resources[idx];
        return {
          found: true,
          resource: hit.resource,
          serviceName: hit.serviceName,
          rank: idx + 1,
          query,
          note: `ranked #${idx + 1} on the x402 Bazaar for "${query}"`,
        };
      }
    }
    return {
      found: false,
      note: `merchant not in Bazaar search results — using configured URL ${cfg.merchantUrl}`,
    };
  } catch (e) {
    const msg = logError('[bazaar] discovery failed:', e);
    return { found: false, note: `Bazaar unavailable (${msg}) — using configured URL` };
  }
}
