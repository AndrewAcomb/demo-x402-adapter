/**
 * Voice Concierge server — single process serving:
 *   GET  /            the projector UI (self-contained HTML, no CDNs)
 *   GET  /healthz     mode/status probe (used by the smoke test)
 *   WS   /ws          browser bridge (mic audio up, narration/events down)
 *   /mock-merchant/*  built-in fake BuyWith402 (only when MOCK_MERCHANT=1)
 *
 * All keys stay server-side; the browser only ever sees transcripts,
 * narration text/audio, and fulfillment events.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';

import { loadConfig, logError } from './config.js';
import { Brain } from './llm.js';
import { createMockMerchant } from './mockMerchant.js';
import { createPaymentRig } from './payment.js';
import { Session } from './session.js';
import type { ClientMsg } from './types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const cfg = loadConfig();
const rig = createPaymentRig(cfg);
const brain = new Brain(cfg);

const app = new Hono();

app.get('/healthz', (c) =>
  c.json({
    ok: true,
    modes: {
      voice: cfg.mockVoice ? 'mock' : 'live',
      llm: cfg.mockLlm ? 'mock' : 'live',
      merchant: cfg.mockMerchant ? 'mock' : 'live',
      pay: rig.mode,
    },
    merchant_url: cfg.merchantUrl,
    dry_run: cfg.demoDryRun,
    max_spend_usd: cfg.maxSpendUsd,
  }),
);

if (cfg.mockMerchant) {
  app.route(
    '/mock-merchant',
    createMockMerchant({ network: cfg.network, eventIntervalMs: cfg.mockEventMs }),
  );
}

const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
app.get('/', (c) => c.html(html));

const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  const modes = `voice=${cfg.mockVoice ? 'MOCK' : 'live'} llm=${cfg.mockLlm ? 'MOCK' : 'live'} merchant=${cfg.mockMerchant ? 'MOCK' : 'live'} pay=${rig.mode.toUpperCase()}`;
  console.log(`[concierge] listening on http://localhost:${info.port}`);
  console.log(`[concierge] ${modes}`);
  console.log(`[concierge] merchant: ${cfg.merchantUrl}`);
  console.log(
    `[concierge] dry_run=${cfg.demoDryRun} allow_real_purchase=${cfg.allowRealPurchase} max_spend_usd=${cfg.maxSpendUsd}`,
  );
  if (rig.mode === 'real') console.log(`[concierge] buyer wallet: ${rig.address}`);
});

const wss = new WebSocketServer({ server: server as HttpServer, path: '/ws' });

wss.on('connection', (ws) => {
  const session = new Session(cfg, brain, rig, (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  });
  ws.on('message', (data) => {
    try {
      session.handleMessage(JSON.parse(data.toString()) as ClientMsg);
    } catch (e) {
      logError('[ws] bad client message:', e);
    }
  });
  ws.on('close', () => session.close());
  ws.on('error', (e) => logError('[ws] socket error:', e));
});
