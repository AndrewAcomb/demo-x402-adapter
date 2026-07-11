/**
 * Vercel serverless entrypoint.
 *
 * A single Vercel Function that hosts the entire Hono app. All
 * incoming paths are rewritten to /api via vercel.json, so this
 * function sees the original path in c.req.path and Hono routes
 * as normal.
 *
 * Runs on Vercel's Node.js runtime (not Edge) so `@x402/hono` and
 * its Node built-in deps work unchanged.
 */

import { handle } from 'hono/vercel';
import app from '../src/app.js';

export default handle(app);
