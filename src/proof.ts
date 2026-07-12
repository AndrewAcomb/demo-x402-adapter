import type { OrderEvent, OrderRecord } from './orders.js';

export const EVIDENCE_SCHEME = 'buywith402/evidence-chain/v1' as const;
const EVENT_DOMAIN = 'buywith402:evidence-event:v1\n';
const ROOT_DOMAIN = 'buywith402:evidence-root:v1\n';
const RECEIPT_DOMAIN = 'buywith402:evidence-receipt:v1\n';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface EvidenceEventPayload {
  evidence_version: typeof EVIDENCE_SCHEME;
  order_id: string;
  seq: number;
  t: string;
  stage: string;
  message: string;
  previous_hash: string;
  screenshot_url?: string;
  screenshot_sha256?: string;
}

export interface EvidenceVerification {
  scheme: typeof EVIDENCE_SCHEME;
  verified: boolean;
  status: 'verified' | 'invalid' | 'unavailable';
  event_count: number;
  verified_event_count: number;
  root: string;
  head: string | null;
  stored_head: string | null;
  stored_event_count: number | null;
  errors: string[];
}

/** Recursively sorted, whitespace-free UTF-8 JSON; mirrored in evidence_chain.py. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function evidenceRoot(orderId: string): Promise<string> {
  return sha256Hex(ROOT_DOMAIN + orderId);
}

function hasProofFields(event: OrderEvent): event is OrderEvent & EvidenceEventPayload & { event_hash: string } {
  return (
    event.evidence_version === EVIDENCE_SCHEME &&
    typeof event.order_id === 'string' &&
    Number.isInteger(event.seq) &&
    typeof event.t === 'string' &&
    typeof event.stage === 'string' &&
    typeof event.message === 'string' &&
    typeof event.previous_hash === 'string' &&
    typeof event.event_hash === 'string' &&
    (event.screenshot_url === undefined || typeof event.screenshot_url === 'string') &&
    (event.screenshot_sha256 === undefined || typeof event.screenshot_sha256 === 'string')
  );
}

function isLegacyEvent(event: OrderEvent): boolean {
  return (
    event.evidence_version === undefined &&
    event.order_id === undefined &&
    event.previous_hash === undefined &&
    event.event_hash === undefined &&
    event.screenshot_sha256 === undefined
  );
}

export function evidencePayload(event: EvidenceEventPayload): EvidenceEventPayload {
  return {
    evidence_version: EVIDENCE_SCHEME,
    order_id: event.order_id,
    seq: event.seq,
    t: event.t,
    stage: event.stage,
    message: event.message,
    previous_hash: event.previous_hash,
    ...(event.screenshot_url !== undefined ? { screenshot_url: event.screenshot_url } : {}),
    ...(event.screenshot_sha256 !== undefined
      ? { screenshot_sha256: event.screenshot_sha256 }
      : {}),
  };
}

export async function hashEvidenceEvent(event: EvidenceEventPayload): Promise<string> {
  return sha256Hex(EVENT_DOMAIN + canonicalJson(evidencePayload(event) as unknown as JsonValue));
}

export async function verifyEvidenceChain(
  orderId: string,
  events: OrderEvent[],
  storedAnchor?: { head?: string; eventCount?: number },
): Promise<EvidenceVerification> {
  const root = await evidenceRoot(orderId);
  if (events.length === 0) {
    const expectedEvents = (storedAnchor?.eventCount ?? 0) > 0 || storedAnchor?.head !== undefined;
    return {
      scheme: EVIDENCE_SCHEME,
      verified: false,
      status: expectedEvents ? 'invalid' : 'unavailable',
      event_count: 0,
      verified_event_count: 0,
      root,
      head: null,
      stored_head: storedAnchor?.head ?? null,
      stored_event_count: storedAnchor?.eventCount ?? null,
      errors: [
        expectedEvents
          ? 'The evidence list is empty, but the order anchor records appended evidence.'
          : 'No fulfillment evidence events have been appended yet.',
      ],
    };
  }

  const legacyIndexes = events.flatMap((event, index) => (isLegacyEvent(event) ? [index] : []));
  if (legacyIndexes.length === events.length && storedAnchor?.head === undefined) {
    return {
      scheme: EVIDENCE_SCHEME,
      verified: false,
      status: 'unavailable',
      event_count: events.length,
      verified_event_count: 0,
      root,
      head: null,
      stored_head: storedAnchor?.head ?? null,
      stored_event_count: storedAnchor?.eventCount ?? null,
      errors: [
        'These events predate the evidence-chain format. The legacy polling feed remains ' +
          'readable, but the history cannot be verified.',
      ],
    };
  }

  const malformedIndex = events.findIndex((event) => !hasProofFields(event));
  if (malformedIndex !== -1) {
    return {
      scheme: EVIDENCE_SCHEME,
      verified: false,
      status: 'invalid',
      event_count: events.length,
      verified_event_count: 0,
      root,
      head: events.at(-1)?.event_hash ?? null,
      stored_head: storedAnchor?.head ?? null,
      stored_event_count: storedAnchor?.eventCount ?? null,
      errors: [
        `Event ${malformedIndex} is mixed legacy data or has incomplete/unsupported proof fields.`,
      ],
    };
  }

  const errors: string[] = [];
  let previousHash = root;
  let verifiedEventCount = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    // The legacy guard above establishes this; keep a defensive branch so a
    // future type change fails closed instead of throwing in the proof route.
    if (!hasProofFields(event)) break;
    if (event.seq !== index) errors.push(`Event ${index} has sequence ${event.seq}; expected ${index}.`);
    if (event.order_id !== orderId) errors.push(`Event ${index} is bound to a different order id.`);
    if (event.previous_hash !== previousHash) {
      errors.push(`Event ${index} does not reference the expected predecessor hash.`);
    }
    const computedHash = await hashEvidenceEvent(event);
    if (computedHash !== event.event_hash) errors.push(`Event ${index} content hash does not match.`);
    if (errors.length === 0) verifiedEventCount += 1;
    previousHash = event.event_hash;
  }
  const head = events.at(-1)?.event_hash ?? null;
  if (storedAnchor?.eventCount !== undefined && storedAnchor.eventCount !== events.length) {
    errors.push(
      `The order anchor records ${storedAnchor.eventCount} events, but the evidence list has ${events.length}.`,
    );
  }
  if (storedAnchor?.head !== undefined && storedAnchor.head !== head) {
    errors.push('The evidence-list head does not match the redundant order anchor.');
  }

  return {
    scheme: EVIDENCE_SCHEME,
    verified: errors.length === 0,
    status: errors.length === 0 ? 'verified' : 'invalid',
    event_count: events.length,
    verified_event_count: verifiedEventCount,
    root,
    head,
    stored_head: storedAnchor?.head ?? null,
    stored_event_count: storedAnchor?.eventCount ?? null,
    errors,
  };
}

export async function evidenceReceipt(
  order: OrderRecord,
  verification: EvidenceVerification,
): Promise<Record<string, unknown>> {
  const final = ['ready_to_place', 'placed', 'failed'].includes(order.status);
  const body = {
    receipt_version: 'buywith402/evidence-receipt/v1',
    order_id: order.order_id,
    product_id: order.product_id,
    quantity: order.quantity,
    dry_run: order.dry_run,
    status: order.status,
    final,
    outcome: final ? (order.status === 'failed' ? 'failure' : 'success') : null,
    created_at: order.created_at,
    updated_at: order.updated_at,
    evidence: {
      scheme: verification.scheme,
      verified: verification.verified,
      event_count: verification.event_count,
      root: verification.root,
      head: verification.head,
    },
  };
  return {
    ...body,
    receipt_hash: await sha256Hex(RECEIPT_DOMAIN + canonicalJson(body as unknown as JsonValue)),
  };
}
