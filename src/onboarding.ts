/**
 * Merchant-onboarding job store + merchants index, on the same Upstash Redis
 * REST store as orders. Keys (mirrors the order-store layout):
 *
 *   onboard:{job_id}         hash  — job fields + status (+ final result JSON)
 *   onboard:{job_id}:events  list  — JSON event lines from onboard_worker.py
 *   onboard:queue            list  — job ids awaiting the worker (LPUSH/RPOP)
 *   merchants:index          hash  — nickname → merchant summary JSON,
 *                                    written by the worker on success
 *   catalog:dynamic          hash  — product id → Product JSON (catalogStore)
 *
 * Status lifecycle: queued → running → succeeded | failed.
 */

import { redisCommand } from './orders.js';

export type OnboardStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export const ONBOARD_FINAL_STATUSES: ReadonlySet<OnboardStatus> = new Set(['succeeded', 'failed']);

export interface OnboardJob {
  job_id: string;
  url: string;
  nickname?: string;
  display_name?: string;
  max_products: number;
  status: OnboardStatus;
  created_at: string;
  updated_at: string;
  /** Final structured result from the worker (merchant, product ids, or error). */
  result?: unknown;
}

export interface OnboardEvent {
  seq: number;
  t: string;
  stage: string;
  message: string;
  screenshot_url?: string;
}

/** Summary row kept in merchants:index by the worker when a job succeeds. */
export interface MerchantSummary {
  nickname: string;
  display_name?: string;
  url?: string;
  product_count?: number;
  onboarded_at?: string;
  job_id?: string;
}

const WEEK_SECONDS = 60 * 60 * 24 * 7;

export interface OnboardRequest {
  url: string;
  nickname?: string;
  display_name?: string;
  max_products: number;
}

export async function createOnboardJob(request: OnboardRequest): Promise<OnboardJob> {
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const record = {
    job_id: jobId,
    url: request.url,
    nickname: request.nickname ?? '',
    display_name: request.display_name ?? '',
    max_products: String(request.max_products),
    status: 'queued',
    created_at: now,
    updated_at: now,
  };
  await redisCommand(['HSET', `onboard:${jobId}`, ...Object.entries(record).flat()]);
  await redisCommand(['EXPIRE', `onboard:${jobId}`, WEEK_SECONDS]);
  await redisCommand(['LPUSH', 'onboard:queue', jobId]);
  return {
    job_id: jobId,
    url: request.url,
    nickname: request.nickname,
    display_name: request.display_name,
    max_products: request.max_products,
    status: 'queued',
    created_at: now,
    updated_at: now,
  };
}

export async function getOnboardJob(jobId: string): Promise<OnboardJob | undefined> {
  const raw = (await redisCommand(['HGETALL', `onboard:${jobId}`])) as string[] | null;
  if (!raw || raw.length === 0) return undefined;
  const h: Record<string, string> = {};
  for (let i = 0; i < raw.length; i += 2) h[raw[i]] = raw[i + 1];
  return {
    job_id: h.job_id,
    url: h.url,
    nickname: h.nickname || undefined,
    display_name: h.display_name || undefined,
    max_products: Number(h.max_products ?? 5),
    status: (h.status ?? 'queued') as OnboardStatus,
    created_at: h.created_at,
    updated_at: h.updated_at,
    result: h.result ? JSON.parse(h.result) : undefined,
  };
}

/** Events at or after `since` (a seq number); returns [] when none. */
export async function getOnboardEvents(jobId: string, since = 0): Promise<OnboardEvent[]> {
  const raw = (await redisCommand(['LRANGE', `onboard:${jobId}:events`, since, -1])) as string[] | null;
  if (!raw) return [];
  return raw.map((line, i) => {
    try {
      return { seq: since + i, ...JSON.parse(line) } as OnboardEvent;
    } catch {
      return { seq: since + i, t: '', stage: 'raw', message: line } as OnboardEvent;
    }
  });
}

/** All onboarded merchants (from merchants:index), sorted by nickname. */
export async function listOnboardedMerchants(): Promise<MerchantSummary[]> {
  const raw = (await redisCommand(['HGETALL', 'merchants:index'])) as string[] | null;
  if (!raw) return [];
  const merchants: MerchantSummary[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    try {
      merchants.push({ nickname: raw[i], ...JSON.parse(raw[i + 1]) });
    } catch {
      merchants.push({ nickname: raw[i] });
    }
  }
  return merchants.sort((a, b) => a.nickname.localeCompare(b.nickname));
}
