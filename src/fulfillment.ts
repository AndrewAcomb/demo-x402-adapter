/**
 * Fulfillment stub.
 *
 * In the real adapter, this is where the computer-use flow (or a
 * scraper, or a merchant-API integration) actually checks out on the
 * underlying merchant's site. For the MMVP it just logs the intent
 * and returns a queued order ID immediately.
 *
 * Keep this function purely additive — never touch payment state.
 * Payment has already settled by the time this runs; a failure here
 * is a fulfillment problem, not a payment problem, and should be
 * handled by an operator-visible queue rather than by refunding
 * inline.
 */

import { randomUUID } from 'node:crypto';
import type { Product } from './catalog.js';
import type { PurchaseBody } from './schemas.js';

export interface FulfillmentIntent {
  order_id: string;
  product: Product;
  body: PurchaseBody;
  created_at: string;
}

const queue = new Map<string, FulfillmentIntent>();

export function enqueueFulfillment(product: Product, body: PurchaseBody): FulfillmentIntent {
  const intent: FulfillmentIntent = {
    order_id: randomUUID(),
    product,
    body,
    created_at: new Date().toISOString(),
  };
  queue.set(intent.order_id, intent);

  console.log(
    `[fulfillment] queued order=${intent.order_id} product=${product.id} qty=${body.quantity} ` +
      `ship=${body.shipping.city},${body.shipping.state}`,
  );

  // TODO: swap for a real fulfillment worker.
  // For now we just log — the demo agent gets an order_id back and
  // that's the extent of the merchant-side story.

  return intent;
}

export function getFulfillment(orderId: string): FulfillmentIntent | undefined {
  return queue.get(orderId);
}
