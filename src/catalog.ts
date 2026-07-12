/**
 * Product catalog — GENERATED from the fulfillment-side McMaster catalog.
 *
 * Do not edit by hand. Regenerate with:
 *   node scripts/gen-catalog.mjs python/runtime/catalogs/004-20260711T231817Z-mcmaster-screws.json
 *
 * Product ids are durable ids shared with the python fulfillment worker.
 * price_usd is the x402 charge (1.5x the real merchant price so payments
 * cover fulfillment); merchant_price_usd is the real McMaster package price.
 */

export interface Product {
  id: string;
  name: string;
  description: string;
  /** USDC price charged via x402, in dollars. The middleware parses "$0.10" style. */
  price_usd: string;
  /** Underlying merchant's real package price (informational). */
  merchant_price_usd?: string;
  /** Estimated sales tax included in price_usd (informational). */
  est_tax_usd?: string;
  /** Estimated per-order delivery/shipping cost included in price_usd. */
  est_fulfillment_fee_usd?: string;
  /** How the item reaches the buyer. Fixed per item — not selectable at purchase. */
  fulfillment?: 'pickup' | 'shipping';
  /** URL of the underlying merchant's product page — the target of computer-use fulfillment. Not exposed publicly. */
  source_url?: string;
}

export const catalog: Record<string, Product> = {
  'mcmaster:92224A100': {
    id: 'mcmaster:92224A100',
    name: "Steel Pan Head Phillips Screw 2-56 x 1/8 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, Black-Oxide Steel, 2-56 Thread, 1/8 inch Length, Fully Threaded Package of 100. McMaster-Carr part 92224A100.",
    price_usd: "$34.49",
    merchant_price_usd: "$13.39",
    est_tax_usd: "$1.16",
    est_fulfillment_fee_usd: "$13.25",
    fulfillment: 'shipping',
    source_url: "https://www.mcmaster.com/92224A100",
  },
  'mcmaster:92224A101': {
    id: 'mcmaster:92224A101',
    name: "Steel Pan Head Phillips Screw 2-56 x 3/16 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, Black-Oxide Steel, 2-56 Thread, 3/16 inch Length, Fully Threaded Package of 100. McMaster-Carr part 92224A101.",
    price_usd: "$31.52",
    merchant_price_usd: "$11.52",
    est_tax_usd: "$0.99",
    est_fulfillment_fee_usd: "$13.25",
    fulfillment: 'shipping',
    source_url: "https://www.mcmaster.com/92224A101",
  },
  'mcmaster:92224A102': {
    id: 'mcmaster:92224A102',
    name: "Steel Pan Head Phillips Screw 2-56 x 1/4 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, Black-Oxide Steel, 2-56 Thread, 1/4 inch Length, Fully Threaded Package of 100. McMaster-Carr part 92224A102.",
    price_usd: "$29.30",
    merchant_price_usd: "$10.12",
    est_tax_usd: "$0.87",
    est_fulfillment_fee_usd: "$13.25",
    fulfillment: 'shipping',
    source_url: "https://www.mcmaster.com/92224A102",
  },
  'mcmaster:92224A103': {
    id: 'mcmaster:92224A103',
    name: "Steel Pan Head Phillips Screw 2-56 x 5/16 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, Black-Oxide Steel, 2-56 Thread, 5/16 inch Length, Fully Threaded Package of 100. McMaster-Carr part 92224A103.",
    price_usd: "$30.40",
    merchant_price_usd: "$10.81",
    est_tax_usd: "$0.93",
    est_fulfillment_fee_usd: "$13.25",
    fulfillment: 'shipping',
    source_url: "https://www.mcmaster.com/92224A103",
  },
  'mcmaster:92224A104': {
    id: 'mcmaster:92224A104',
    name: "Steel Pan Head Phillips Screw 2-56 x 3/8 inch (pack of 50)",
    description: "Steel Pan Head Phillips Screw, Black-Oxide Steel, 2-56 Thread, 3/8 inch Length, Fully Threaded Package of 50. McMaster-Carr part 92224A104.",
    price_usd: "$26.88",
    merchant_price_usd: "$8.59",
    est_tax_usd: "$0.74",
    est_fulfillment_fee_usd: "$13.25",
    fulfillment: 'shipping',
    source_url: "https://www.mcmaster.com/92224A104",
  },
  'mcmaster:92224A105': {
    id: 'mcmaster:92224A105',
    name: "Steel Pan Head Phillips Screw 2-56 x 7/16 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, Black-Oxide Steel, 2-56 Thread, 7/16 inch Length, Fully Threaded Package of 100. McMaster-Carr part 92224A105.",
    price_usd: "$30.89",
    merchant_price_usd: "$11.12",
    est_tax_usd: "$0.96",
    est_fulfillment_fee_usd: "$13.25",
    fulfillment: 'shipping',
    source_url: "https://www.mcmaster.com/92224A105",
  },
  'mcmaster:92224A106': {
    id: 'mcmaster:92224A106',
    name: "Steel Pan Head Phillips Screw 2-56 x 1/2 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, Black-Oxide Steel, 2-56 Thread, 1/2 inch Length, Fully Threaded Package of 100. McMaster-Carr part 92224A106.",
    price_usd: "$31.06",
    merchant_price_usd: "$11.23",
    est_tax_usd: "$0.97",
    est_fulfillment_fee_usd: "$13.25",
    fulfillment: 'shipping',
    source_url: "https://www.mcmaster.com/92224A106",
  },
  'mcmaster:92224A109': {
    id: 'mcmaster:92224A109',
    name: "Steel Pan Head Phillips Screw 3-48 x 3/8 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, Black-Oxide Steel, 3-48 Thread, 3/8 inch Length, Fully Threaded Package of 100. McMaster-Carr part 92224A109.",
    price_usd: "$34.40",
    merchant_price_usd: "$13.33",
    est_tax_usd: "$1.15",
    est_fulfillment_fee_usd: "$13.25",
    fulfillment: 'shipping',
    source_url: "https://www.mcmaster.com/92224A109",
  },
  'mcmaster:92224A111': {
    id: 'mcmaster:92224A111',
    name: "Steel Pan Head Phillips Screw 4-40 x 3/16 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, Black-Oxide Steel, 4-40 Thread, 3/16 inch Length, Fully Threaded Package of 100. McMaster-Carr part 92224A111.",
    price_usd: "$21.96",
    merchant_price_usd: "$5.49",
    est_tax_usd: "$0.47",
    est_fulfillment_fee_usd: "$13.25",
    fulfillment: 'shipping',
    source_url: "https://www.mcmaster.com/92224A111",
  },
  'mcmaster:92224A112': {
    id: 'mcmaster:92224A112',
    name: "Steel Pan Head Phillips Screw 4-40 x 1/4 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, Black-Oxide Steel, 4-40 Thread, 1/4 inch Length, Fully Threaded Package of 100. McMaster-Carr part 92224A112.",
    price_usd: "$21.75",
    merchant_price_usd: "$5.36",
    est_tax_usd: "$0.46",
    est_fulfillment_fee_usd: "$13.25",
    fulfillment: 'shipping',
    source_url: "https://www.mcmaster.com/92224A112",
  },
  'test-item': {
    id: 'test-item',
    name: 'Test Item (integration test, no fulfillment)',
    description:
      'A ten-cent item for testing the x402 purchase flow end to end. ' +
      'Fulfillment completes immediately without contacting any merchant.',
    price_usd: '$0.10',
  },
};

export function listProducts() {
  return Object.values(catalog).map(({ source_url, ...rest }) => rest);
}

export function getProduct(id: string): Product | undefined {
  return catalog[id];
}
