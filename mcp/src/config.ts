/**
 * Configuration + session state for the x402 Shopper MCP wallet.
 *
 * Everything the server needs to know about *this run* lives here: env
 * parsing, the derived wallet address (NEVER the private key), the spend
 * caps, and the in-memory per-session budget tracker.
 *
 * Safety invariant: the private key is read once, used only to build a viem
 * signer, and is never returned from any function, logged, or placed in a
 * tool result. `walletAddress` is derived from it and safe to surface.
 */

import { privateKeyToAccount } from 'viem/accounts';
import type { LocalAccount } from 'viem';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function flag(name: string): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export interface Config {
  network: string;
  mockMerchant: boolean;
  mockPay: boolean;
  allowRealPurchase: boolean;
  maxSpendUsd: number;
  sessionBudgetUsd: number;
  merchantUrls: string[];
  /** Derived from the private key; null when running without a key. */
  walletAddress: `0x${string}` | null;
  /** viem signer for real x402 payments; null in mock-pay / no-key mode. */
  signer: LocalAccount | null;
}

function parseMerchantUrls(mock: boolean): string[] {
  const raw = process.env.MERCHANT_URLS;
  if (raw && raw.trim()) {
    return raw
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean);
  }
  // Default catalog of known x402 merchants. buywith402.com is our own
  // Bazaar-listed adapter. In mock-merchant mode the fetch layer intercepts
  // every request, so this URL is just a label the demo narrates against.
  return ['https://buywith402.com'];
}

let signer: LocalAccount | null = null;
let walletAddress: `0x${string}` | null = null;

const pk = process.env.X402_BUYER_PRIVATE_KEY?.trim();
if (pk) {
  try {
    const normalized = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
    const account = privateKeyToAccount(normalized);
    signer = account;
    walletAddress = account.address;
  } catch {
    // Never echo the key or the underlying error (it can embed the key).
    throw new Error('X402_BUYER_PRIVATE_KEY is set but is not a valid hex private key.');
  }
}

export const config: Config = {
  network: (process.env.X402_NETWORK ?? 'eip155:84532').trim(),
  mockMerchant: flag('MOCK_MERCHANT'),
  mockPay: flag('MOCK_PAY'),
  allowRealPurchase: flag('ALLOW_REAL_PURCHASE'),
  maxSpendUsd: num('MAX_SPEND_USD', 50),
  sessionBudgetUsd: num('SESSION_BUDGET_USD', 100),
  merchantUrls: parseMerchantUrls(flag('MOCK_MERCHANT')),
  walletAddress,
  signer,
};

// --- Per-session cumulative budget (held in server memory only) ------------

let spentUsd = 0;

export const budget = {
  spent: () => spentUsd,
  remaining: () => Math.max(0, config.sessionBudgetUsd - spentUsd),
  canAfford: (usd: number) => spentUsd + usd <= config.sessionBudgetUsd + 1e-9,
  commit: (usd: number) => {
    spentUsd += usd;
  },
};

/**
 * True when a real (or mock-pay) settlement is permitted for `estUsd`.
 * Returns a structured reason when it is NOT, so `buy` can explain itself.
 */
export function spendDecision(estUsd: number, confirm: boolean): { ok: true } | { ok: false; reason: string } {
  if (!confirm) {
    return { ok: false, reason: 'confirm was not true — this is a dry-run preview. Re-call with confirm=true to spend.' };
  }
  if (!config.allowRealPurchase) {
    return {
      ok: false,
      reason:
        'ALLOW_REAL_PURCHASE is not set to 1 in the server environment. The wallet is in preview-only mode and will not spend.',
    };
  }
  if (estUsd > config.maxSpendUsd + 1e-9) {
    return {
      ok: false,
      reason: `Estimated charge $${estUsd.toFixed(2)} exceeds the per-purchase cap MAX_SPEND_USD=$${config.maxSpendUsd.toFixed(2)}.`,
    };
  }
  if (!budget.canAfford(estUsd)) {
    return {
      ok: false,
      reason: `Estimated charge $${estUsd.toFixed(2)} would exceed the remaining session budget $${budget.remaining().toFixed(2)} (SESSION_BUDGET_USD=$${config.sessionBudgetUsd.toFixed(2)}).`,
    };
  }
  return { ok: true };
}
