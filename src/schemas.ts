import { z } from 'zod';

/**
 * The shipping fields any physical-goods buy needs.
 * Kept intentionally minimal for the demo — a real adapter would
 * validate the country, state, and postal-code shape more strictly.
 */
export const Shipping = z.object({
  name: z.string().min(1).max(120),
  address_1: z.string().min(1).max(200),
  address_2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().length(2),
  zip: z.string().min(3).max(20),
  country: z.string().length(2).default('US'),
});
export type Shipping = z.infer<typeof Shipping>;

export const PurchaseBody = z.object({
  quantity: z.number().int().min(1).max(12).default(1),
  email: z.email().optional(),
  shipping: Shipping,
  gift_note: z.string().max(300).optional(),
});
export type PurchaseBody = z.infer<typeof PurchaseBody>;

/** Reply shape after a paid purchase settles successfully. */
export const OrderResponse = z.object({
  order_id: z.uuid(),
  product_id: z.string(),
  quantity: z.number().int(),
  status: z.enum(['queued', 'processing', 'completed', 'failed']),
  message: z.string(),
});
export type OrderResponse = z.infer<typeof OrderResponse>;
