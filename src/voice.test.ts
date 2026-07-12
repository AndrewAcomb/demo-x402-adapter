import assert from 'node:assert/strict';
import test from 'node:test';

import { matchCatalog, parseGradiumNdjson, transcribeWithGradium } from './voice.js';

test('matches an interrupted, natural-language workshop request exactly', () => {
  const result = matchCatalog(
    'I need—hang on—one hundred black screws. Pan head Phillips, 4-40… quarter-inch long.',
  );

  assert.equal(result.product.id, 'mcmaster:92224A112');
  assert.equal(result.quantity, 1);
  assert.equal(result.requested_units, 100);
  assert.equal(result.package_size, 100);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.missing_constraints, []);
});

test('does not confuse three-eighths with one-eighth', () => {
  const result = matchCatalog('3-48 Phillips screws, three eighths inch long');
  assert.equal(result.product.id, 'mcmaster:92224A109');
});

test('marks an underspecified request for human review', () => {
  const result = matchCatalog('I need some black Phillips screws');
  assert.equal(result.confidence, 'low');
  assert.deepEqual(result.missing_constraints, ['thread size', 'length']);
});

test('parses Gradium NDJSON transcript segments and provider errors', () => {
  assert.deepEqual(
    parseGradiumNdjson(
      '{"type":"text","text":"I need","request_id":"req_1"}\n' +
        '{"type":"end_text","stop_s":0.8}\n' +
        '{"type":"text","text":"some screws"}\n',
    ),
    { transcript: 'I need some screws', request_id: 'req_1' },
  );
  assert.throws(
    () => parseGradiumNdjson('{"type":"error","message":"bad audio"}\n'),
    /bad audio/,
  );
});

test('calls the official Gradium binary REST contract with a server-side key', async () => {
  let observedUrl = '';
  let observedInit: RequestInit | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    observedUrl = String(input);
    observedInit = init;
    return new Response('{"type":"text","text":"quarter inch screws"}\n', {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    });
  };

  const audio = new Uint8Array([82, 73, 70, 70]).buffer;
  const result = await transcribeWithGradium(audio, 'audio/wav', {
    apiKey: 'server-secret',
    fetchImpl: fakeFetch,
  });

  assert.equal(result.transcript, 'quarter inch screws');
  assert.equal(result.provider, 'gradium');
  assert.match(observedUrl, /^https:\/\/api\.gradium\.ai\/api\/post\/speech\/asr\?/);
  assert.match(observedUrl, /input_format=wav/);
  assert.equal(new Headers(observedInit?.headers).get('x-api-key'), 'server-secret');
  assert.equal(new Headers(observedInit?.headers).get('content-type'), 'audio/wav');
  assert.equal(observedInit?.body, audio);
});
