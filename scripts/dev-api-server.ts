/**
 * Local stand-in for Vercel functions: serves the handlers in api/ on port
 * 3001 so `npm run dev` works end-to-end without the Vercel CLI. Shares the
 * request listener in `server.ts` with static serving off. Run with:
 *
 *   node --env-file=.env.local scripts/dev-api-server.ts
 *
 * (Requires Node 22.18+ for native TypeScript type stripping.)
 */
import { createServer } from 'node:http';
import { createRequestListener } from './server.ts';

createServer(createRequestListener({ staticRoot: null })).listen(3001, () => {
  console.log('API dev server listening on http://localhost:3001');
});
