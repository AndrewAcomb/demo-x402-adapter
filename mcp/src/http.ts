/**
 * Fetch factory. Produces two fetchers used by the tools:
 *
 *   plainFetch — for free endpoints and `inspect_purchase` (reads the 402
 *                challenge WITHOUT paying). Never spends.
 *   payFetch   — pays an x402 challenge and retries. Its behaviour depends on
 *                mode:
 *                  • MOCK_PAY=1        → pretend payment succeeded (re-send the
 *                                        request with a sentinel X-PAYMENT header)
 *                  • real key present  → @x402/fetch wrapFetchWithPayment with a
 *                                        viem-backed exact-EVM scheme
 *
 * The base transport is the in-process mock merchant when MOCK_MERCHANT=1, or
 * the platform `fetch` otherwise. The private key never leaves the signer.
 */

import { wrapFetchWithPayment } from '@x402/fetch';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { config } from './config.js';
import { mockFetch } from './mockMerchant.js';

type FetchFn = typeof globalThis.fetch;

const baseFetch: FetchFn = config.mockMerchant ? mockFetch : (globalThis.fetch as FetchFn);

/** Never pays. Used for GETs and the no-pay 402 preview. */
export const plainFetch: FetchFn = baseFetch;

/**
 * MOCK_PAY payer: make the request; on 402, replay it once with a sentinel
 * payment header so the mock merchant (or any tolerant test server) settles.
 */
const mockPayFetch: FetchFn = async (input, init) => {
  const first = await baseFetch(input, init);
  if (first.status !== 402) return first;
  const headers = new Headers(init?.headers);
  headers.set('X-PAYMENT', 'mock-payment-accepted');
  return baseFetch(input, { ...init, headers });
};

let realPayFetch: FetchFn | null = null;
function getRealPayFetch(): FetchFn {
  if (realPayFetch) return realPayFetch;
  if (!config.signer) {
    throw new Error(
      'No wallet key configured. Set X402_BUYER_PRIVATE_KEY for real payments, or MOCK_PAY=1 for offline settlement.',
    );
  }
  const client = new x402Client().register(config.network as never, new ExactEvmScheme(config.signer));
  realPayFetch = wrapFetchWithPayment(baseFetch as typeof fetch, client) as FetchFn;
  return realPayFetch;
}

/** Returns the payer appropriate for the current mode. */
export function payFetch(): FetchFn {
  return config.mockPay ? mockPayFetch : getRealPayFetch();
}
