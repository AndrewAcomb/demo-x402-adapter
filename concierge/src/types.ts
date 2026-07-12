/** Shared types: merchant API shapes + browser WebSocket protocol. */

import type { ShippingAddress } from './config.js';

// --- Merchant API (BuyWith402) ---------------------------------------------

export interface Product {
  id: string;
  name: string;
  description: string;
  price_usd: string; // "$23.04"
  merchant_price_usd?: string;
}

export interface OrderEvent {
  seq: number;
  t: string;
  stage: string; // worker | agent | checkpoint | live_view | local | ...
  message: string;
  screenshot_url?: string;
}

export interface OrderStatusResponse {
  order_id: string;
  product_id: string;
  quantity: number;
  dry_run?: boolean;
  status: string;
  final?: boolean;
  outcome?: 'success' | 'failure';
  created_at?: string;
  updated_at?: string;
  result?: unknown;
  events?: OrderEvent[];
  next_since?: number;
}

export interface PurchaseResponse {
  order_id: string;
  product_id: string;
  quantity: number;
  dry_run?: boolean;
  status: string;
  message?: string;
}

export interface PurchaseBody {
  quantity: number;
  shipping: ShippingAddress;
  dry_run: boolean;
  gift_note?: string;
}

// --- Intent (parsed from speech) --------------------------------------------

export interface Intent {
  /** Free-text product query, e.g. "pack of 4-40 quarter-inch screws". */
  query: string;
  quantity: number;
  /** Address-book key, e.g. "office". */
  recipient: string;
}

export interface ProductChoice {
  product_id: string;
  /** One spoken sentence justifying the pick. */
  reason: string;
}

// --- Browser WebSocket protocol ---------------------------------------------

/** Client -> server. */
export type ClientMsg =
  | { type: 'start_audio' }
  | { type: 'audio'; audio: string } // base64 24kHz mono PCM16
  | { type: 'stop_audio' }
  | { type: 'text_input'; text: string }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'reset' };

/** Server -> client. */
export type ServerMsg =
  | {
      type: 'config';
      modes: { voice: string; llm: string; merchant: string; pay: string };
      merchant_url: string;
      dry_run: boolean;
    }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'say'; text: string; audio_b64?: string } // spoken narration (wav when live TTS)
  | { type: 'thought'; text: string } // on-screen reasoning, not spoken
  | { type: 'stage'; name: string; detail?: string } // pipeline stage changes
  | { type: 'products'; items: Product[] }
  | {
      type: 'choice';
      product: Product;
      reason: string;
      quantity: number;
      recipient: string;
      total_usd: string;
    }
  | { type: 'await_confirmation'; summary: string }
  | { type: 'order'; order_id: string; dry_run: boolean }
  | { type: 'fulfillment_event'; event: OrderEvent }
  | { type: 'order_status'; status: string; final: boolean; outcome?: string }
  | { type: 'done'; outcome: string; order_id?: string }
  | { type: 'error'; message: string }
  | { type: 'mic'; state: 'listening' | 'idle' };
