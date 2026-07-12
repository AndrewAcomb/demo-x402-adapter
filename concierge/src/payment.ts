/**
 * x402 buyer wiring: a fetch function that automatically answers 402
 * challenges with one signed USDC transfer (exact scheme, EVM).
 *
 * MOCK_PAY=1 (or no X402_BUYER_PRIVATE_KEY): the wrapper retries 402s with a
 * placeholder X-PAYMENT header instead — the built-in mock merchant accepts
 * it, and the log says loudly that payment was simulated.
 */

import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { privateKeyToAccount } from 'viem/accounts';
import type { Config } from './config.js';
import { logError } from './config.js';

export type PayFetch = (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => Promise<Response>;

export interface PaymentRig {
  fetch: PayFetch;
  mode: 'real' | 'mock';
  /** Buyer wallet address when real. */
  address?: string;
}

function mockPayFetch(): PayFetch {
  return async (input, init) => {
    const first = await fetch(input, init);
    if (first.status !== 402) return first;
    console.log('[pay] 402 received — payment SIMULATED (mock pay mode, no funds moved)');
    const headers = new Headers(init?.headers);
    headers.set('X-PAYMENT', 'simulated-payment-mock-mode');
    return fetch(input, { ...init, headers });
  };
}

export function createPaymentRig(cfg: Config): PaymentRig {
  if (cfg.mockPay || !cfg.buyerPrivateKey) {
    return { fetch: mockPayFetch(), mode: 'mock' };
  }
  try {
    const account = privateKeyToAccount(cfg.buyerPrivateKey);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: account });
    return {
      fetch: wrapFetchWithPayment(globalThis.fetch, client),
      mode: 'real',
      address: account.address,
    };
  } catch (e) {
    logError('[pay] failed to build real x402 client, falling back to mock pay:', e);
    return { fetch: mockPayFetch(), mode: 'mock' };
  }
}
