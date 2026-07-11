/**
 * Local development entrypoint.
 *
 * `npm run dev` → tsx watch this file → boots a Node HTTP server on
 * $PORT and serves the Hono app defined in ./app.ts.
 *
 * Vercel does NOT run this file; it uses api/index.ts instead.
 */

import { serve } from '@hono/node-server';
import app, { NETWORK, PAY_TO, FACILITATOR_URL } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`x402 adapter listening on http://localhost:${port}`);
  console.log(`  network=${NETWORK}`);
  console.log(`  facilitator=${FACILITATOR_URL}`);
  console.log(`  pay_to=${PAY_TO}`);
});
