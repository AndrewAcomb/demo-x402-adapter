#!/usr/bin/env node
/**
 * DEV-ONLY in-memory Redis stub speaking the Upstash REST wire shape.
 *
 * Lets the TS server (src/orders.ts, src/catalogStore.ts, src/onboarding.ts)
 * and the python workers run the full Merchant Factory loop offline — no
 * Upstash account, no network. Implements only the commands this repo uses:
 * HSET HGETALL HINCRBY LPUSH RPUSH RPOP LRANGE LTRIM EXPIRE SADD SMEMBERS DEL.
 *
 * NOT for production. No auth (the Authorization header is ignored), no
 * persistence (state dies with the process), no expiry (EXPIRE is a no-op).
 *
 * Usage:
 *   node scripts/dev-redis-stub.mjs           # listens on :8199
 *   DEV_REDIS_PORT=7000 node scripts/dev-redis-stub.mjs
 *
 * Then point both sides at it:
 *   KV_REST_API_URL=http://localhost:8199 KV_REST_API_TOKEN=dev npm run dev
 *   KV_REST_API_URL=http://localhost:8199 KV_REST_API_TOKEN=dev \
 *     ONBOARD_MOCK=1 uv run python onboard_worker.py
 */

import http from 'node:http';

const PORT = Number(process.env.DEV_REDIS_PORT ?? 8199);

/** key -> { hash: Map } | { list: [] } | { set: Set } */
const store = new Map();

function typed(key, kind, create) {
  let entry = store.get(key);
  if (!entry) {
    entry = create();
    store.set(key, entry);
  }
  if (!(kind in entry)) throw new Error(`WRONGTYPE key ${key} is not a ${kind}`);
  return entry;
}

// Redis LRANGE/LTRIM index semantics: negative counts from the end, stop inclusive.
function range(list, start, stop) {
  const n = list.length;
  let a = start < 0 ? Math.max(n + start, 0) : start;
  let b = stop < 0 ? n + stop : Math.min(stop, n - 1);
  if (a > b || a >= n) return [];
  return list.slice(a, b + 1);
}

function execute(command) {
  if (!Array.isArray(command) || command.length === 0) throw new Error('empty command');
  const [op, ...args] = command.map(String);
  switch (op.toUpperCase()) {
    case 'PING':
      return 'PONG';
    case 'HSET': {
      const entry = typed(args[0], 'hash', () => ({ hash: new Map() }));
      let added = 0;
      for (let i = 1; i + 1 < args.length; i += 2) {
        if (!entry.hash.has(args[i])) added += 1;
        entry.hash.set(args[i], args[i + 1]);
      }
      return added;
    }
    case 'HGETALL': {
      const entry = store.get(args[0]);
      if (!entry) return [];
      if (!entry.hash) throw new Error('WRONGTYPE');
      return [...entry.hash.entries()].flat();
    }
    case 'HINCRBY': {
      const entry = typed(args[0], 'hash', () => ({ hash: new Map() }));
      const next = Number(entry.hash.get(args[1]) ?? 0) + Number(args[2]);
      entry.hash.set(args[1], String(next));
      return next;
    }
    case 'LPUSH': {
      const entry = typed(args[0], 'list', () => ({ list: [] }));
      for (const value of args.slice(1)) entry.list.unshift(value);
      return entry.list.length;
    }
    case 'RPUSH': {
      const entry = typed(args[0], 'list', () => ({ list: [] }));
      for (const value of args.slice(1)) entry.list.push(value);
      return entry.list.length;
    }
    case 'RPOP': {
      const entry = store.get(args[0]);
      if (!entry?.list?.length) return null;
      return entry.list.pop();
    }
    case 'LRANGE': {
      const entry = store.get(args[0]);
      if (!entry?.list) return [];
      return range(entry.list, Number(args[1]), Number(args[2]));
    }
    case 'LTRIM': {
      const entry = store.get(args[0]);
      if (entry?.list) entry.list = range(entry.list, Number(args[1]), Number(args[2]));
      return 'OK';
    }
    case 'SADD': {
      const entry = typed(args[0], 'set', () => ({ set: new Set() }));
      let added = 0;
      for (const value of args.slice(1)) {
        if (!entry.set.has(value)) added += 1;
        entry.set.add(value);
      }
      return added;
    }
    case 'SMEMBERS': {
      const entry = store.get(args[0]);
      return entry?.set ? [...entry.set] : [];
    }
    case 'DEL': {
      let removed = 0;
      for (const key of args) if (store.delete(key)) removed += 1;
      return removed;
    }
    case 'EXPIRE':
      return store.has(args[0]) ? 1 : 0; // accepted, never enforced (dev only)
    default:
      throw new Error(`unsupported command in dev stub: ${op}`);
  }
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    try {
      const result = execute(JSON.parse(body || '[]'));
      res.end(JSON.stringify({ result }));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[dev-redis-stub] Upstash-REST-shaped in-memory store on http://localhost:${PORT}`);
  console.log('[dev-redis-stub] DEV ONLY: no auth, no persistence, no expiry.');
});
