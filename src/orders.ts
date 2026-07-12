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

export type OrderStatus = 'queued' | 'running' | 'ready_to_place' | 'placed' | 'failed';

export interface OrderRecord {
  order_id: string;
  product_id: string;
  quantity: number;
  dry_run: boolean;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
  shipping: PurchaseBody['shipping'];
  email?: string;
  /** Final structured result from the fulfillment run, when present. */
  result?: unknown;
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
}

export async function getOrder(orderId: string): Promise<OrderRecord | undefined> {
  const raw = (await redis(['HGETALL', `order:${orderId}`])) as string[] | null;
  if (!raw || raw.length === 0) return undefined;
  const h: Record<string, string> = {};
  for (let i = 0; i < raw.length; i += 2) h[raw[i]] = raw[i + 1];
  return {
    order_id: h.order_id,
    product_id: h.product_id,
    quantity: Number(h.quantity ?? 1),
    dry_run: h.dry_run !== '0',
    status: (h.status ?? 'queued') as OrderStatus,
    created_at: h.created_at,
    updated_at: h.updated_at,
    shipping: h.shipping ? JSON.parse(h.shipping) : undefined,
    email: h.email || undefined,
    result: h.result ? JSON.parse(h.result) : undefined,
  };
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
