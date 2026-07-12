/** Thin client for the BuyWith402 merchant API (real or built-in mock). */

import type { PayFetch } from './payment.js';
import type { OrderStatusResponse, Product, PurchaseBody, PurchaseResponse } from './types.js';

export class MerchantClient {
  constructor(
    private baseUrl: string,
    private payFetch: PayFetch,
  ) {}

  async products(): Promise<Product[]> {
    const res = await fetch(`${this.baseUrl}/products`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GET /products failed: ${res.status}`);
    const data = (await res.json()) as { products?: Product[] };
    if (!Array.isArray(data.products)) throw new Error('unexpected /products response shape');
    return data.products;
  }

  /** POST purchase; the payFetch wrapper answers the 402 challenge. */
  async purchase(productId: string, body: PurchaseBody): Promise<PurchaseResponse> {
    const res = await this.payFetch(
      `${this.baseUrl}/products/${encodeURIComponent(productId)}/purchase`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (res.status === 402) {
      throw new Error('merchant still demands payment after the payment attempt (402)');
    }
    if (!res.ok) {
      throw new Error(`purchase failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as PurchaseResponse;
    if (!data.order_id) throw new Error('purchase response missing order_id');
    return data;
  }

  async order(orderId: string, since = 0): Promise<OrderStatusResponse> {
    const res = await fetch(
      `${this.baseUrl}/orders/${encodeURIComponent(orderId)}?since=${since}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`GET /orders/${orderId} failed: ${res.status}`);
    return (await res.json()) as OrderStatusResponse;
  }
}
