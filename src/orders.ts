/**
 * Durable order store + fulfillment queue on Upstash Redis (REST API).
 *
 * Why REST and not a Redis client: Vercel functions are short-lived and the
 * Upstash REST API needs no connection management; the python worker uses the
 * same commands over the same API. Keys:
 *
 *   order:{id}         hash  — order fields + status (+ final result JSON)
 *   order:{id}:events  list  — JSON event lines appended by the worker
 *   orders:queue       list  — order ids awaiting fulfillment (LPUSH / RPOP)
 *
 * Status lifecycle: queued → running → ready_to_place | placed | failed.
 * `dry_run` orders stop at the merchant's order-review screen (fail-closed);
 * real placement additionally requires ALLOW_REAL_ORDERS=1 on the worker.
 */

import type { Product } from './catalog.js';
import type { PurchaseBody } from './schemas.js';

const REST_URL = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

export const ordersConfigured = Boolean(REST_URL && REST_TOKEN);

async function redis(command: (string | number)[]): Promise<unknown> {
  if (!REST_URL || !REST_TOKEN) throw new Error('Order store not configured (KV_REST_API_URL/TOKEN)');
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis REST error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (data.error) throw new Error(`Redis error: ${data.error}`);
  return data.result;
}

/**
 * Batch several commands into one round trip via the Upstash `/pipeline`
 * endpoint. Results come back in command order; per-command errors surface
 * as `undefined` for that slot rather than failing the whole batch.
 */
async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  if (!REST_URL || !REST_TOKEN) throw new Error('Order store not configured (KV_REST_API_URL/TOKEN)');
  if (commands.length === 0) return [];
  const res = await fetch(`${REST_URL.replace(/\/+$/, '')}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Redis pipeline error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { result?: unknown; error?: string }[];
  return data.map((entry) => (entry.error ? undefined : entry.result));
}

export type OrderStatus = 'queued' | 'running' | 'retrying' | 'ready_to_place' | 'placed' | 'failed';

/** Statuses that will not change again (barring a manual re-queue). */
export const FINAL_STATUSES: ReadonlySet<OrderStatus> = new Set(['ready_to_place', 'placed', 'failed']);

/** On-chain payment proof captured after x402 settlement. */
export interface OrderPayment {
  /** Payer wallet address (0x…). */
  payer?: string;
  /** Settlement transaction hash. */
  tx?: string;
  /** Amount in atomic token units (USDC has 6 decimals). */
  amount?: string;
  /** CAIP-2 network id, e.g. eip155:84532. */
  network?: string;
}

export interface OrderRecord {
  order_id: string;
  product_id: string;
  product_name?: string;
  quantity: number;
  dry_run: boolean;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
  shipping: PurchaseBody['shipping'];
  email?: string;
  /** Final structured result from the fulfillment run, when present. */
  result?: unknown;
  /** Payment proof, when settlement details were captured. */
  payment?: OrderPayment;
}

export interface OrderEvent {
  seq: number;
  t: string;
  stage: string;
  message: string;
  screenshot_url?: string;
}

export async function createOrder(
  orderId: string,
  product: Product,
  body: PurchaseBody & { dry_run?: boolean },
): Promise<void> {
  const now = new Date().toISOString();
  const record = {
    order_id: orderId,
    product_id: product.id,
    quantity: String(body.quantity),
    dry_run: body.dry_run === false ? '0' : '1',
    status: 'queued',
    created_at: now,
    updated_at: now,
    shipping: JSON.stringify(body.shipping),
    email: body.email ?? '',
    source_url: product.source_url ?? '',
    product_name: product.name,
  };
  const flat = Object.entries(record).flat();
  await redis(['HSET', `order:${orderId}`, ...flat]);
  await redis(['EXPIRE', `order:${orderId}`, 60 * 60 * 24 * 7]);
  await redis(['LPUSH', 'orders:queue', orderId]);
  // Recent-orders index for the Mission Control dashboard feed.
  await redis(['LPUSH', 'orders:recent', orderId]);
  await redis(['LTRIM', 'orders:recent', 0, 99]);
}

/** Parse a flat HGETALL reply ([k1, v1, k2, v2, …]) into an OrderRecord. */
function hashToRecord(raw: string[] | null | undefined): OrderRecord | undefined {
  if (!raw || !Array.isArray(raw) || raw.length === 0) return undefined;
  const h: Record<string, string> = {};
  for (let i = 0; i < raw.length; i += 2) h[raw[i]] = raw[i + 1];
  const payment: OrderPayment | undefined =
    h.payment_tx || h.payment_payer
      ? {
          payer: h.payment_payer || undefined,
          tx: h.payment_tx || undefined,
          amount: h.payment_amount || undefined,
          network: h.payment_network || undefined,
        }
      : undefined;
  let parsedShipping: OrderRecord['shipping'] | undefined;
  let parsedResult: unknown;
  try {
    parsedShipping = h.shipping ? JSON.parse(h.shipping) : undefined;
  } catch {
    parsedShipping = undefined;
  }
  try {
    parsedResult = h.result ? JSON.parse(h.result) : undefined;
  } catch {
    parsedResult = undefined;
  }
  return {
    order_id: h.order_id,
    product_id: h.product_id,
    product_name: h.product_name || undefined,
    quantity: Number(h.quantity ?? 1),
    dry_run: h.dry_run !== '0',
    status: (h.status ?? 'queued') as OrderStatus,
    created_at: h.created_at,
    updated_at: h.updated_at,
    shipping: parsedShipping as OrderRecord['shipping'],
    email: h.email || undefined,
    result: parsedResult,
    payment,
  };
}

export async function getOrder(orderId: string): Promise<OrderRecord | undefined> {
  const raw = (await redis(['HGETALL', `order:${orderId}`])) as string[] | null;
  return hashToRecord(raw);
}

/**
 * Most-recent orders (newest first) from the `orders:recent` index.
 * One LRANGE plus a single pipelined batch of HGETALLs.
 */
export async function listRecentOrders(limit = 20): Promise<OrderRecord[]> {
  const n = Math.max(1, Math.min(50, Math.floor(limit)));
  const ids = (await redis(['LRANGE', 'orders:recent', 0, n - 1])) as string[] | null;
  if (!ids || ids.length === 0) return [];
  const replies = await redisPipeline(ids.map((id) => ['HGETALL', `order:${id}`]));
  return replies
    .map((raw) => hashToRecord(raw as string[] | null))
    .filter((r): r is OrderRecord => r !== undefined && Boolean(r.order_id));
}

/**
 * Attach on-chain payment proof to an order and append a "payment settled"
 * event to its timeline. Called from the x402 onAfterSettle hook — must be
 * cheap and must never throw into the paid request path (caller wraps it).
 */
export async function recordOrderPayment(orderId: string, payment: OrderPayment): Promise<void> {
  const now = new Date().toISOString();
  const fields: string[] = ['updated_at', now];
  if (payment.payer) fields.push('payment_payer', payment.payer);
  if (payment.tx) fields.push('payment_tx', payment.tx);
  if (payment.amount) fields.push('payment_amount', payment.amount);
  if (payment.network) fields.push('payment_network', payment.network);
  const usd = payment.amount ? (Number(payment.amount) / 1e6).toFixed(2) : undefined;
  const event = JSON.stringify({
    t: now,
    stage: 'payment',
    message:
      `Payment settled${usd ? `: $${usd} USDC` : ''}` +
      `${payment.payer ? ` from ${payment.payer}` : ''}` +
      `${payment.tx ? ` (tx ${payment.tx})` : ''}`,
  });
  await redisPipeline([
    ['HSET', `order:${orderId}`, ...fields],
    ['RPUSH', `order:${orderId}:events`, event],
    ['EXPIRE', `order:${orderId}:events`, 60 * 60 * 24 * 7],
  ]);
}

/** Events at or after `since` (a seq number); returns [] when none. */
export async function getOrderEvents(orderId: string, since = 0): Promise<OrderEvent[]> {
  const raw = (await redis(['LRANGE', `order:${orderId}:events`, since, -1])) as string[] | null;
  if (!raw) return [];
  return raw
    .map((line, i) => {
      try {
        return { seq: since + i, ...JSON.parse(line) } as OrderEvent;
      } catch {
        return { seq: since + i, t: '', stage: 'raw', message: line } as OrderEvent;
      }
    })
    .filter(Boolean);
}
