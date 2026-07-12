import { z } from 'zod';

import { listProducts, type Product } from './catalog.js';

export const VoiceMatchRequest = z.object({
  transcript: z.string().trim().min(2).max(1_000),
});

export type VoiceMatch = ReturnType<typeof matchCatalog>;

const LENGTH_ALIASES: ReadonlyArray<[RegExp, string]> = [
  [/\bthree\s+sixteenths?(?:\s+of\s+an?)?(?:\s+inch)?\b|\b3\s*\/\s*16(?:\s*(?:in|inch|inches|\"))?\b/i, '3/16'],
  [/\b(?:one\s+)?quarter(?:\s+of\s+an?)?(?:\s+inch)?\b|\b1\s*\/\s*4(?:\s*(?:in|inch|inches|\"))?\b/i, '1/4'],
  [/\bfive\s+sixteenths?(?:\s+of\s+an?)?(?:\s+inch)?\b|\b5\s*\/\s*16(?:\s*(?:in|inch|inches|\"))?\b/i, '5/16'],
  [/\bthree\s+eighths?(?:\s+of\s+an?)?(?:\s+inch)?\b|\b3\s*\/\s*8(?:\s*(?:in|inch|inches|\"))?\b/i, '3/8'],
  [/\bseven\s+sixteenths?(?:\s+of\s+an?)?(?:\s+inch)?\b|\b7\s*\/\s*16(?:\s*(?:in|inch|inches|\"))?\b/i, '7/16'],
  [/\b(?:one\s+)?half(?:\s+of\s+an?)?(?:\s+inch)?\b|\b1\s*\/\s*2(?:\s*(?:in|inch|inches|\"))?\b/i, '1/2'],
  [/\b(?:one\s+)?eighth(?:s)?(?:\s+of\s+an?)?(?:\s+inch)?\b|\b1\s*\/\s*8(?:\s*(?:in|inch|inches|\"))?\b/i, '1/8'],
];

function extractLength(text: string): string | undefined {
  return LENGTH_ALIASES.find(([pattern]) => pattern.test(text))?.[1];
}

function packageSize(product: Product): number {
  return Number(product.name.match(/pack of (\d+)/i)?.[1] ?? 1);
}

function productSpec(product: Product) {
  const text = `${product.name} ${product.description}`;
  return {
    thread: text.match(/\b(\d+-\d+)\b/)?.[1],
    length: text.match(/\b(\d+\/\d+) inch\b/i)?.[1],
    packSize: packageSize(product),
  };
}

function spokenNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const hundreds = value.toLowerCase().match(/^(one|two|three|four|five|six) hundred$/);
  if (hundreds) return spokenNumber(hundreds[1])! * 100;
  return ({ a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 } as Record<string, number>)[
    value.toLowerCase()
  ];
}

/** Deterministic, inspectable matching for the small free catalog. */
export function matchCatalog(transcript: string) {
  const normalized = transcript.toLowerCase().replace(/[–—]/g, '-');
  const thread = normalized.match(/\b(2-56|3-48|4-40)\b/)?.[1];
  const length = extractLength(normalized);
  const packageRequest = normalized.match(/\b(\d+|a|an|one|two|three|four|five|six)\s+(?:packs?|packages?)\b/i);
  const unitRequest = normalized.match(
    /\b(\d+|(?:one|two|three|four|five|six) hundred)\s+(?:black\s+)?(?:machine\s+)?screws?\b/i,
  );
  const requestedPackages = spokenNumber(packageRequest?.[1]);
  const requestedUnits = spokenNumber(unitRequest?.[1]);
  const wantsPhillips = /\bphillips\b/.test(normalized);
  const wantsPanHead = /\bpan[ -]?head\b/.test(normalized);
  const wantsBlack = /\b(?:black|black[ -]?oxide)\b/.test(normalized);

  const scored = listProducts()
    .filter((product) => product.id !== 'test-item')
    .map((product) => {
      const spec = productSpec(product);
      let score = 5;
      if (thread) score += spec.thread === thread ? 48 : -60;
      if (length) score += spec.length === length ? 38 : -45;
      if (wantsPhillips && /phillips/i.test(product.name)) score += 4;
      if (wantsPanHead && /pan head/i.test(product.name)) score += 4;
      if (wantsBlack && /black-oxide/i.test(product.description)) score += 4;
      if (normalized.includes(product.id.split(':')[1]?.toLowerCase())) score += 100;
      return { product, spec, score };
    })
    .sort((a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id));

  const best = scored[0];
  if (!best) throw new Error('Catalog has no purchasable products');
  const quantity = Math.min(
    12,
    Math.max(1, requestedPackages ?? (requestedUnits ? Math.ceil(requestedUnits / best.spec.packSize) : 1)),
  );
  const matchedConstraints = [
    thread && `thread ${thread}`,
    length && `${length} inch`,
    wantsPanHead && 'pan head',
    wantsPhillips && 'Phillips drive',
    wantsBlack && 'black oxide',
  ].filter((value): value is string => Boolean(value));
  const missingConstraints = [!thread && 'thread size', !length && 'length'].filter(
    (value): value is string => Boolean(value),
  );
  const confidence = thread && length ? 'high' : thread || length ? 'medium' : 'low';

  return {
    transcript,
    product: best.product,
    quantity,
    requested_units: requestedUnits,
    package_size: best.spec.packSize,
    confidence,
    matched_constraints: matchedConstraints,
    missing_constraints: missingConstraints,
    rationale:
      confidence === 'high'
        ? `Exact catalog match on ${thread} thread and ${length} inch length.`
        : `Best available catalog match; review ${missingConstraints.join(' and ')} before payment.`,
    alternatives: scored.slice(1, 3).map(({ product }) => ({
      id: product.id,
      name: product.name,
      price_usd: product.price_usd,
    })),
  };
}

const GradiumMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), request_id: z.string().optional() }).passthrough(),
  z.object({ type: z.literal('end_text') }).passthrough(),
  z.object({ type: z.literal('error'), message: z.string().optional() }).passthrough(),
]);

export function parseGradiumNdjson(body: string) {
  const segments: string[] = [];
  let requestId: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = GradiumMessage.safeParse(JSON.parse(line));
    if (!parsed.success) continue;
    if (parsed.data.type === 'error') {
      throw new Error(parsed.data.message ?? 'Gradium transcription failed');
    }
    if (parsed.data.type === 'text') {
      if (parsed.data.text.trim()) segments.push(parsed.data.text.trim());
      requestId ??= parsed.data.request_id;
    }
  }
  return { transcript: segments.join(' ').replace(/\s+/g, ' ').trim(), request_id: requestId };
}

export async function transcribeWithGradium(
  audio: ArrayBuffer,
  contentType: string,
  options: { apiKey: string; fetchImpl?: typeof fetch },
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL('https://api.gradium.ai/api/post/speech/asr');
  url.searchParams.set('model', 'default');
  url.searchParams.set('input_format', contentType === 'audio/wav' ? 'wav' : 'opus');
  url.searchParams.set('json_config', JSON.stringify({ language: 'en' }));
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'x-api-key': options.apiKey, 'content-type': contentType },
    body: audio,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Gradium returned HTTP ${response.status}`);
  const result = parseGradiumNdjson(body);
  if (!result.transcript) throw new Error('Gradium returned no transcript');
  return { ...result, provider: 'gradium' as const };
}
