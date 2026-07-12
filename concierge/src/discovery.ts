/**
 * x402 Bazaar discovery — the "the agent FOUND the merchant" stage moment.
 *
 * Best-effort: queries the facilitator's discovery list for an HTTP resource
 * on the merchant's host. Any failure (offline, facilitator without a bazaar,
 * merchant not yet indexed) degrades gracefully to the configured URL.
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
  /** How many resources the Bazaar listed in total (for narration). */
  totalListed?: number;
  note: string;
}

export async function discoverMerchant(cfg: Config): Promise<DiscoveryResult> {
  if (cfg.mockMerchant) {
    return {
      found: true,
      resource: `${cfg.merchantUrl}/products/{id}/purchase`,
      serviceName: 'BuyWith402 (mock)',
      totalListed: 1,
      note: 'mock merchant — Bazaar lookup simulated',
    };
  }

  const merchantHost = new URL(cfg.merchantUrl).host;
  try {
    const client = withBazaar(new HTTPFacilitatorClient({ url: cfg.facilitatorUrl }));
    const listing = await Promise.race([
      client.extensions.bazaar.listResources({ type: 'http', limit: 200 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('bazaar lookup timed out')), 8000),
      ),
    ]);
    const hit = listing.items.find((item) => {
      try {
        return new URL(item.resource).host === merchantHost;
      } catch {
        return false;
      }
    });
    if (hit) {
      return {
        found: true,
        resource: hit.resource,
        serviceName: hit.serviceName,
        totalListed: listing.pagination?.total ?? listing.items.length,
        note: `found on the x402 Bazaar via ${cfg.facilitatorUrl}`,
      };
    }
    return {
      found: false,
      totalListed: listing.pagination?.total ?? listing.items.length,
      note: `merchant not in the Bazaar listing yet — using configured URL ${cfg.merchantUrl}`,
    };
  } catch (e) {
    const msg = logError('[bazaar] discovery failed:', e);
    return { found: false, note: `Bazaar unavailable (${msg}) — using configured URL` };
  }
}
