/**
 * Local stand-in for Vercel functions: serves the handlers in api/ on port
 * 3001 so `npm run dev` works end-to-end without the Vercel CLI. Run with:
 *
 *   node --env-file=.env.local scripts/dev-api-server.ts
 *
 * (Requires Node 22.18+ for native TypeScript type stripping.)
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { POST as chatPost } from '../api/chat.ts';
import { POST as importPost } from '../api/import.ts';

const routes: Record<string, (req: Request) => Promise<Response>> = {
  'POST /api/chat': chatPost,
  'POST /api/import': importPost,
};

createServer(async (nodeReq, nodeRes) => {
  const route = routes[`${nodeReq.method} ${(nodeReq.url ?? '').split('?')[0]}`];
  if (!route) {
    nodeRes.statusCode = 404;
    nodeRes.end('Not found');
    return;
  }

  try {
    const hasBody = nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD';
    const request = new Request(`http://localhost:3001${nodeReq.url}`, {
      method: nodeReq.method,
      headers: nodeReq.headers as Record<string, string>,
      body: hasBody ? (Readable.toWeb(nodeReq) as ReadableStream) : undefined,
      // @ts-expect-error required by undici for streaming request bodies
      duplex: 'half',
    });

    const response = await route(request);
    nodeRes.statusCode = response.status;
    response.headers.forEach((value, key) => nodeRes.setHeader(key, value));
    if (response.body) {
      for await (const chunk of response.body) nodeRes.write(chunk);
    }
    nodeRes.end();
  } catch (err) {
    console.error(err);
    nodeRes.statusCode = 500;
    nodeRes.end('Internal error');
  }
}).listen(3001, () => {
  console.log('API dev server listening on http://localhost:3001');
});
