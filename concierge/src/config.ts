/**
 * Environment / mode configuration for the Voice Concierge.
 *
 * Every external dependency is optional: when its key is absent the
 * corresponding subsystem falls back to a mock, so `npm run demo` works
 * fully offline. Explicit MOCK_* env vars override auto-detection.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parse "1"/"true"/"0"/"false"; undefined when unset. */
function boolEnv(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  return v === '1' || v.toLowerCase() === 'true';
}

export interface ShippingAddress {
  name: string;
  address_1: string;
  address_2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
}

export interface Config {
  port: number;
  /** Merchant API base URL (no trailing slash). */
  merchantUrl: string;
  mockVoice: boolean;
  mockLlm: boolean;
  mockMerchant: boolean;
  mockPay: boolean;
  gradiumApiKey?: string;
  gradiumVoiceId: string;
  haiApiKey?: string;
  haiModel: string;
  buyerPrivateKey?: `0x${string}`;
  network: string;
  facilitatorUrl: string;
  /** true (default): send dry_run=true to the merchant — rehearsal only. */
  demoDryRun: boolean;
  allowRealPurchase: boolean;
  maxSpendUsd: number;
  /** Milliseconds between canned mock-fulfillment events. */
  mockEventMs: number;
  addressBook: Record<string, ShippingAddress>;
}

function loadAddressBook(): Record<string, ShippingAddress> {
  for (const file of ['addresses.json', 'addresses.example.json']) {
    const p = path.join(ROOT, file);
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        console.error(`[config] failed to parse ${file}: ${(e as Error).message}`);
      }
    }
  }
  return {};
}

export function loadConfig(): Config {
  const gradiumApiKey = process.env.GRADIUM_API_KEY || undefined;
  const haiApiKey = process.env.HAI_API_KEY || undefined;
  const buyerPrivateKey = (process.env.X402_BUYER_PRIVATE_KEY || undefined) as
    | `0x${string}`
    | undefined;
  const merchantUrlEnv = process.env.MERCHANT_URL || undefined;

  const mockVoice = boolEnv('MOCK_VOICE') ?? !gradiumApiKey;
  const mockLlm = boolEnv('MOCK_LLM') ?? !haiApiKey;
  const mockPay = boolEnv('MOCK_PAY') ?? !buyerPrivateKey;
  // Mock merchant unless a merchant URL was explicitly configured.
  const mockMerchant = boolEnv('MOCK_MERCHANT') ?? !merchantUrlEnv;

  const port = Number(process.env.PORT ?? 4020);

  return {
    port,
    merchantUrl: mockMerchant
      ? `http://localhost:${port}/mock-merchant`
      : (merchantUrlEnv ?? 'https://buywith402.com').replace(/\/$/, ''),
    mockVoice,
    mockLlm,
    mockMerchant,
    mockPay,
    gradiumApiKey,
    gradiumVoiceId: process.env.GRADIUM_VOICE_ID || 'YTpq7expH9539ERJ', // Emma (en-US)
    haiApiKey,
    haiModel: process.env.HAI_MODEL || 'holo3-1-35b-a3b',
    buyerPrivateKey,
    network: process.env.X402_NETWORK || 'eip155:84532', // Base Sepolia
    facilitatorUrl: process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator',
    demoDryRun: boolEnv('DEMO_DRY_RUN') ?? true,
    allowRealPurchase: boolEnv('ALLOW_REAL_PURCHASE') ?? false,
    maxSpendUsd: Number(process.env.MAX_SPEND_USD ?? 50),
    mockEventMs: Number(process.env.MOCK_EVENT_MS ?? 1800),
    addressBook: loadAddressBook(),
  };
}

/** Secret values that must never appear in logs or client-visible errors. */
const SECRET_ENV_VARS = ['GRADIUM_API_KEY', 'HAI_API_KEY', 'X402_BUYER_PRIVATE_KEY'];

export function redactSecrets(text: string): string {
  let out = text;
  for (const name of SECRET_ENV_VARS) {
    const v = process.env[name];
    if (v && v.length >= 6) out = out.split(v).join(`[${name} redacted]`);
  }
  // Belt and braces: never let a 64-hex private key through.
  out = out.replace(/0x[0-9a-fA-F]{64}/g, '[private key redacted]');
  return out;
}

/** Log an error with secrets stripped. */
export function logError(prefix: string, err: unknown): string {
  const msg = redactSecrets(err instanceof Error ? err.message : String(err));
  console.error(`${prefix} ${msg}`);
  return msg;
}
