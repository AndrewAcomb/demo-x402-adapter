/**
 * Merchant HTTP helpers: browse catalogs and read x402 challenges.
 * These wrap the BuyWith402 wire shapes (see repo src/app.ts) and normalize
 * them into small, LLM-friendly objects.
 */

import { plainFetch } from './http.js';

export function parseUsd(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export interface NormalizedProduct {
  id: string;
  name: string;
  price_usd: number | undefined;
  merchant_price_usd?: number;
  description?: string;
}

export interface MerchantGuide {
  name: string;
  base_url: string;
  description?: string;
  tags: string[];
  payment?: unknown;
}

function base(url: string): string {
  return url.trim().replace(/\/$/, '');
}

export async function fetchGuide(url: string): Promise<MerchantGuide> {
  const b = base(url);
  const res = await plainFetch(`${b}/`, { headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    name: typeof body.name === 'string' ? body.name : b,
    base_url: b,
    description: typeof body.description === 'string' ? body.description : undefined,
    tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
    payment: body.payment,
  };
}

export async function fetchProducts(url: string): Promise<NormalizedProduct[]> {
  const b = base(url);
  const res = await plainFetch(`${b}/products`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${b}/products failed: HTTP ${res.status}`);
  const body = (await res.json()) as { products?: unknown[] };
  const list = Array.isArray(body.products) ? body.products : [];
  return list.map((p) => {
    const o = p as Record<string, unknown>;
    return {
      id: String(o.id),
      name: String(o.name ?? o.id),
      price_usd: parseUsd(o.price_usd),
      merchant_price_usd: parseUsd(o.merchant_price_usd),
      description: typeof o.description === 'string' ? o.description : undefined,
    };
  });
}

export interface ChallengeQuote {
  price_usd: number;
  asset?: string;
  network?: string;
  pay_to?: string;
  scheme?: string;
  raw: unknown;
}

/**
 * POST the purchase WITHOUT paying and read the x402 challenge. Never spends.
 * `payFetch` fn is passed in so this stays payment-agnostic; here we always
 * use `plainFetch` so no payment header is ever attached.
 */
export async function readChallenge(
  url: string,
  productId: string,
  body: unknown,
): Promise<ChallengeQuote> {
  const b = base(url);
  const res = await plainFetch(`${b}/products/${encodeURIComponent(productId)}/purchase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

  if (res.status !== 402) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Expected a 402 x402 challenge from ${b} but got HTTP ${res.status}. ${text.slice(0, 200)}`,
    );
  }

  const challenge = (await res.json().catch(() => ({}))) as {
    accepts?: Array<Record<string, unknown>>;
  };
  const accept = challenge.accepts?.[0];
  if (!accept) throw new Error('402 challenge did not contain any payment options (accepts[]).');

  const decimals = Number((accept.extra as Record<string, unknown> | undefined)?.decimals ?? 6) || 6;
  const amount = Number(accept.amount ?? 0);
  const price_usd = amount / 10 ** decimals;

  return {
    price_usd,
    asset: typeof accept.asset === 'string' ? accept.asset : undefined,
    network: typeof accept.network === 'string' ? accept.network : undefined,
    pay_to: typeof accept.payTo === 'string' ? accept.payTo : undefined,
    scheme: typeof accept.scheme === 'string' ? accept.scheme : undefined,
    raw: challenge,
  };
}
