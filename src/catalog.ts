/**
 * Product catalog — GENERATED from the fulfillment-side McMaster catalog.
 *
 * Do not edit by hand. Regenerate with:
 *   node scripts/gen-catalog.mjs python/runtime/catalogs/001-20260711T225139Z-mcmaster-screws.json
 *
 * Product ids are durable ids shared with the python fulfillment worker.
 * price_usd is the x402 demo charge; merchant_price_usd is the real
 * McMaster package price the fulfillment run will pay.
 */

export interface Product {
  id: string;
  name: string;
  description: string;
  /** USDC price charged via x402, in dollars. The middleware parses "$0.10" style. */
  price_usd: string;
  /** Underlying merchant's real package price (informational). */
  merchant_price_usd?: string;
  /** URL of the underlying merchant's product page — the target of computer-use fulfillment. Not exposed publicly. */
  source_url?: string;
}

export const catalog: Record<string, Product> = {
  'mcmaster:92224A100': {
    id: 'mcmaster:92224A100',
    name: "Steel Pan Head Phillips Screw 2-56 x 1/8 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, 2-56 thread, 1/8 inch length, Black-Oxide Steel, Fully Threaded Package of 100. McMaster-Carr part 92224A100.",
    price_usd: '$0.10',
    merchant_price_usd: "$13.39",
    source_url: "https://www.mcmaster.com/92224A100",
  },
  'mcmaster:92224A101': {
    id: 'mcmaster:92224A101',
    name: "Steel Pan Head Phillips Screw 2-56 x 3/16 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, 2-56 thread, 3/16 inch length, Black-Oxide Steel, Fully Threaded Package of 100. McMaster-Carr part 92224A101.",
    price_usd: '$0.10',
    merchant_price_usd: "$11.52",
    source_url: "https://www.mcmaster.com/92224A101",
  },
  'mcmaster:92224A102': {
    id: 'mcmaster:92224A102',
    name: "Steel Pan Head Phillips Screw 2-56 x 1/4 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, 2-56 thread, 1/4 inch length, Black-Oxide Steel, Fully Threaded Package of 100. McMaster-Carr part 92224A102.",
    price_usd: '$0.10',
    merchant_price_usd: "$10.12",
    source_url: "https://www.mcmaster.com/92224A102",
  },
  'mcmaster:92224A103': {
    id: 'mcmaster:92224A103',
    name: "Steel Pan Head Phillips Screw 2-56 x 5/16 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, 2-56 thread, 5/16 inch length, Black-Oxide Steel, Fully Threaded Package of 100. McMaster-Carr part 92224A103.",
    price_usd: '$0.10',
    merchant_price_usd: "$10.81",
    source_url: "https://www.mcmaster.com/92224A103",
  },
  'mcmaster:92224A104': {
    id: 'mcmaster:92224A104',
    name: "Steel Pan Head Phillips Screw 2-56 x 3/8 inch (pack of 50)",
    description: "Steel Pan Head Phillips Screw, 2-56 thread, 3/8 inch length, Black-Oxide Steel, Fully Threaded Package of 50. McMaster-Carr part 92224A104.",
    price_usd: '$0.10',
    merchant_price_usd: "$8.59",
    source_url: "https://www.mcmaster.com/92224A104",
  },
  'mcmaster:92224A105': {
    id: 'mcmaster:92224A105',
    name: "Steel Pan Head Phillips Screw 2-56 x 7/16 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, 2-56 thread, 7/16 inch length, Black-Oxide Steel, Fully Threaded Package of 100. McMaster-Carr part 92224A105.",
    price_usd: '$0.10',
    merchant_price_usd: "$11.12",
    source_url: "https://www.mcmaster.com/92224A105",
  },
  'mcmaster:92224A106': {
    id: 'mcmaster:92224A106',
    name: "Steel Pan Head Phillips Screw 2-56 x 1/2 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, 2-56 thread, 1/2 inch length, Black-Oxide Steel, Fully Threaded Package of 100. McMaster-Carr part 92224A106.",
    price_usd: '$0.10',
    merchant_price_usd: "$11.23",
    source_url: "https://www.mcmaster.com/92224A106",
  },
  'mcmaster:92224A109': {
    id: 'mcmaster:92224A109',
    name: "Steel Pan Head Phillips Screw 3-48 x 3/8 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, 3-48 thread, 3/8 inch length, Black-Oxide Steel, Fully Threaded Package of 100. McMaster-Carr part 92224A109.",
    price_usd: '$0.10',
    merchant_price_usd: "$13.33",
    source_url: "https://www.mcmaster.com/92224A109",
  },
  'mcmaster:92224A111': {
    id: 'mcmaster:92224A111',
    name: "Steel Pan Head Phillips Screw 4-40 x 3/16 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, 4-40 thread, 3/16 inch length, Black-Oxide Steel, Fully Threaded Package of 100. McMaster-Carr part 92224A111.",
    price_usd: '$0.10',
    merchant_price_usd: "$5.49",
    source_url: "https://www.mcmaster.com/92224A111",
  },
  'mcmaster:92224A112': {
    id: 'mcmaster:92224A112',
    name: "Steel Pan Head Phillips Screw 4-40 x 1/4 inch (pack of 100)",
    description: "Steel Pan Head Phillips Screw, 4-40 thread, 1/4 inch length, Black-Oxide Steel, Fully Threaded Package of 100. McMaster-Carr part 92224A112.",
    price_usd: '$0.10',
    merchant_price_usd: "$5.36",
    source_url: "https://www.mcmaster.com/92224A112",
  },
};

export function listProducts() {
  return Object.values(catalog).map(({ source_url, ...rest }) => rest);
}

export function getProduct(id: string): Product | undefined {
  return catalog[id];
}
