/**
 * The buyer's brain: H Company's Holo3 model (OpenAI-compatible API),
 * with a deterministic keyword-matching fallback (MOCK_LLM=1 or on any
 * live-call failure) so the demo never stalls.
 */

import type { Config } from './config.js';
import { logError } from './config.js';
import type { Intent, OrderEvent, Product, ProductChoice } from './types.js';

const HAI_URL = 'https://api.hcompany.ai/v1/chat/completions';

// --- Live Holo3 calls --------------------------------------------------------

async function chat(cfg: Config, system: string, user: string, maxTokens = 300): Promise<string> {
  const res = await fetch(HAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.haiApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.haiModel,
      temperature: 0.1,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`H API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('H API returned no content');
  return content.trim();
}

/** Tolerate imperfect JSON: extract the first {...} block that parses. */
function extractJson<T>(text: string): T {
  const direct = text.trim();
  for (const candidate of [direct, direct.replace(/^```(?:json)?|```$/g, '').trim()]) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* keep trying */
    }
  }
  const match = direct.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]) as T;
  throw new Error(`no JSON found in model output: ${direct.slice(0, 120)}`);
}

// --- Deterministic mock implementations --------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12,
};

const FRACTION_WORDS: Array<[RegExp, string]> = [
  [/quarter[- ]inch|1\/4|one quarter/i, '1/4'],
  [/half[- ]inch|1\/2/i, '1/2'],
  [/three[- ]eighths?|3\/8/i, '3/8'],
  [/three[- ]sixteenths?|3\/16/i, '3/16'],
  [/five[- ]sixteenths?|5\/16/i, '5/16'],
  [/seven[- ]sixteenths?|7\/16/i, '7/16'],
  [/eighth[- ]inch|1\/8/i, '1/8'],
];

export function mockParseIntent(transcript: string, addressKeys: string[]): Intent {
  const lower = transcript.toLowerCase();

  // Quantity: "two packs" / "3 packs" — but NOT thread specs like "4-40".
  let quantity = 1;
  const numMatch = lower.match(/\b(\d+)\s+(?:packs?|boxes?|of)\b/);
  if (numMatch) quantity = Math.min(12, Math.max(1, parseInt(numMatch[1], 10)));
  else {
    const wordMatch = lower.match(/\b(two|three|four|five|six|seven|eight|nine|ten|dozen)\s+packs?\b/);
    if (wordMatch) quantity = NUMBER_WORDS[wordMatch[1]] ?? 1;
  }

  const recipient =
    addressKeys.find((k) => lower.includes(k.toLowerCase())) ?? addressKeys[0] ?? 'office';

  // Strip the command verb and the shipping clause so the query reads as a
  // product description ("a pack of 4-40 quarter-inch screws").
  let query = transcript
    .trim()
    .replace(/^(?:please\s+)?(?:can you\s+|could you\s+)?(?:order|buy|get|purchase|send)\s+(?:me\s+|us\s+)?/i, '')
    .replace(/[.?!]+$/, '');
  for (const key of addressKeys) {
    const safe = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query = query.replace(new RegExp(`\\s+(?:to|for)\\s+(?:the\\s+|my\\s+)?${safe}\\b.*$`, 'i'), '');
  }

  return { query: query.trim() || transcript.trim(), quantity, recipient };
}

export function mockChooseProduct(intent: Intent, products: Product[]): ProductChoice {
  const q = intent.query.toLowerCase();
  const thread = q.match(/\b(\d+)[- ](\d+)\b/); // "4-40", "4 40"
  const threadSpec = thread ? `${thread[1]}-${thread[2]}` : undefined;
  const lengthSpec = FRACTION_WORDS.find(([re]) => re.test(q))?.[1];

  let best: Product | undefined;
  let bestScore = -1;
  const reasons = new Map<string, string[]>();
  for (const p of products) {
    if (p.id === 'test-item') continue;
    const hay = `${p.name} ${p.description}`.toLowerCase();
    let score = 0;
    const why: string[] = [];
    if (threadSpec && hay.includes(threadSpec)) {
      score += 10;
      why.push(`${threadSpec} thread`);
    }
    if (lengthSpec && hay.includes(`${lengthSpec} inch`)) {
      score += 5;
      why.push(`${lengthSpec} inch length`);
    }
    for (const word of q.split(/\W+/)) {
      if (word.length > 3 && hay.includes(word)) score += 1;
    }
    // Tie-break toward the cheaper package.
    score -= parseFloat(p.price_usd.replace('$', '')) / 1000;
    if (score > bestScore) {
      bestScore = score;
      best = p;
      reasons.set(p.id, why);
    }
  }
  if (!best) throw new Error('no products available to choose from');
  const why = reasons.get(best.id) ?? [];
  const reason = why.length
    ? `It matches your ${why.join(' and ')} exactly.`
    : `It is the closest match in the catalog for "${intent.query}".`;
  return { product_id: best.id, reason };
}

const CHECKPOINT_LINES: Record<string, string> = {
  'cart-cleared': 'The browser agent cleared the merchant cart, so we start from a clean slate.',
  'product-in-cart': 'The screws are in the cart. You can see the screenshot on screen.',
  'place-order-review': 'The agent reached the order review screen and the totals check out.',
};

export function mockNarrateEvent(event: OrderEvent, productName: string): string {
  if (event.stage === 'checkpoint') {
    return (
      CHECKPOINT_LINES[event.message.replace(/ \(simulated\)$/, '')] ??
      `Checkpoint reached: ${event.message}.`
    );
  }
  if (event.stage === 'live_view') return 'The browser agent is live. Watch it work on screen.';
  if (event.stage === 'worker' && /finished|complete/i.test(event.message)) {
    return event.message.includes('ready_to_place')
      ? 'Dry run complete. The order is staged at the review screen, ready to place.'
      : event.message.includes('placed')
        ? `The order for ${productName} has been placed. All done.`
        : 'Fulfillment finished.';
  }
  if (event.stage === 'worker' && /started/i.test(event.message)) {
    return `A browser agent has picked up the order and is heading to the merchant site.`;
  }
  return event.message.length > 90 ? `${event.message.slice(0, 87)}...` : event.message;
}

// --- Public brain -------------------------------------------------------------

export class Brain {
  constructor(private cfg: Config) {}

  get live(): boolean {
    return !this.cfg.mockLlm && !!this.cfg.haiApiKey;
  }

  async parseIntent(transcript: string, addressKeys: string[]): Promise<Intent> {
    const fallback = () => mockParseIntent(transcript, addressKeys);
    if (!this.live) return fallback();
    try {
      const out = await chat(
        this.cfg,
        'You parse spoken shopping requests. Reply with ONLY a JSON object: ' +
          '{"query": "<product description words only>", "quantity": <integer >= 1>, ' +
          `"recipient": "<one of: ${addressKeys.join(', ')}>"}. ` +
          'quantity is how many packages to buy (default 1). recipient is where to ship.',
        `Request: "${transcript}"`,
      );
      const parsed = extractJson<Partial<Intent>>(out);
      const intent = fallback();
      if (typeof parsed.query === 'string' && parsed.query) intent.query = parsed.query;
      if (typeof parsed.quantity === 'number' && parsed.quantity >= 1)
        intent.quantity = Math.min(12, Math.round(parsed.quantity));
      if (typeof parsed.recipient === 'string' && addressKeys.includes(parsed.recipient))
        intent.recipient = parsed.recipient;
      return intent;
    } catch (e) {
      logError('[llm] parseIntent fell back to mock:', e);
      return fallback();
    }
  }

  async chooseProduct(intent: Intent, products: Product[]): Promise<ProductChoice> {
    const fallback = () => mockChooseProduct(intent, products);
    if (!this.live) return fallback();
    try {
      const menu = products
        .filter((p) => p.id !== 'test-item')
        .map((p) => `- id: ${p.id} | ${p.name} | ${p.price_usd}`)
        .join('\n');
      const out = await chat(
        this.cfg,
        'You pick the best product for a buyer. Reply with ONLY a JSON object: ' +
          '{"product_id": "<exact id from the list>", "reason": "<one short spoken sentence ' +
          'justifying the choice>"}.',
        `Buyer wants: "${intent.query}" (quantity ${intent.quantity}).\nCatalog:\n${menu}`,
      );
      const parsed = extractJson<Partial<ProductChoice>>(out);
      if (!parsed.product_id || !products.some((p) => p.id === parsed.product_id)) {
        throw new Error(`model chose unknown product: ${parsed.product_id}`);
      }
      return {
        product_id: parsed.product_id,
        reason:
          typeof parsed.reason === 'string' && parsed.reason
            ? parsed.reason.slice(0, 200)
            : fallback().reason,
      };
    } catch (e) {
      logError('[llm] chooseProduct fell back to mock:', e);
      return fallback();
    }
  }

  async narrateEvent(event: OrderEvent, productName: string): Promise<string> {
    const fallback = () => mockNarrateEvent(event, productName);
    if (!this.live) return fallback();
    try {
      const out = await chat(
        this.cfg,
        'You narrate a live purchase for a stage audience. Given one fulfillment event from a ' +
          'browser agent checking out on a merchant site, reply with ONE short spoken sentence ' +
          '(no emojis, no quotes, plain text, under 20 words). Present tense, confident.',
        `Product: ${productName}\nEvent stage: ${event.stage}\nEvent message: ${event.message}`,
        80,
      );
      const line = out.replace(/^["']|["']$/g, '').trim();
      return line && line.length < 220 ? line : fallback();
    } catch (e) {
      logError('[llm] narrateEvent fell back to mock:', e);
      return fallback();
    }
  }
}
