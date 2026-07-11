/**
 * Vercel serverless entrypoint.
 *
 * A single Vercel Function that hosts the entire Hono app. All
 * incoming paths are rewritten to /api via vercel.json, so this
 * function sees the original path in c.req.path and Hono routes
 * as normal.
 *
 * IMPORTANT: Vercel's Node bridge pre-reads the request body to
 * provide its `req.body` helper, which leaves the underlying stream
 * un-consumable — any handler that later awaits `c.req.json()` hangs
 * forever. So we do NOT pipe the Node stream into Hono; instead we
 * rebuild a fetch `Request` from the bridge's already-parsed body.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import app from '../src/app.js';

export const maxDuration = 60;

type VercelReq = IncomingMessage & { body?: unknown };

export default async function handler(req: VercelReq, res: ServerResponse): Promise<void> {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
  const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? 'localhost';
  const url = `${proto}://${host}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  // Re-serialize the body the bridge already consumed. `req.body` is a
  // parsed object for JSON, a string for text, a Buffer for octet-stream,
  // or undefined when there was no body.
  let body: string | Buffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
    }
  }
  // Content-length no longer matches after re-serialization; let fetch set it.
  headers.delete('content-length');

  const response = await app.fetch(new Request(url, { method: req.method, headers, body }));

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}
