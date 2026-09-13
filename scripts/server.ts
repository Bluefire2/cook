/**
 * Production HTTP server: API routes plus static `dist/` and SPA fallback.
 * Run after `npm run build`:
 *
 *   node --env-file=.env.local scripts/server.ts
 *
 * `createRequestListener({ staticRoot: null })` is the API-only listener used
 * by `scripts/dev-api-server.ts`.
 *
 * Requires Node 22.18+ for native TypeScript type stripping.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { POST as chatPost } from '../api/chat.ts';
import { POST as importPost } from '../api/import.ts';

const apiHandlers: Record<string, (req: Request) => Promise<Response>> = {
  '/api/chat': chatPost,
  '/api/import': importPost,
};

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const NO_CACHE_NAMES = new Set([
  'index.html',
  'sw.js',
  'registerSW.js',
  'manifest.webmanifest',
]);

export function createRequestListener(options: { staticRoot: string | null }) {
  const staticRoot = options.staticRoot === null ? null : resolve(options.staticRoot);

  return (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
    void handleRequest(nodeReq, nodeRes, staticRoot);
  };
}

async function handleRequest(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  staticRoot: string | null,
): Promise<void> {
  try {
    const rawUrl = nodeReq.url ?? '/';
    const q = rawUrl.indexOf('?');
    const rawPath = q === -1 ? rawUrl : rawUrl.slice(0, q);
    const method = nodeReq.method ?? 'GET';

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      sendText(nodeReq, nodeRes, 400, 'Bad request');
      return;
    }

    if (!decodedPath.startsWith('/') || decodedPath.includes('\0')) {
      sendText(nodeReq, nodeRes, 400, 'Bad request');
      return;
    }

    if (decodedPath.startsWith('/api/')) {
      await handleApi(nodeReq, nodeRes, decodedPath, method);
      return;
    }

    if (staticRoot === null) {
      sendText(nodeReq, nodeRes, 404, 'Not found');
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendText(nodeReq, nodeRes, 405, 'Method not allowed');
      return;
    }

    const filePath = resolveContained(staticRoot, decodedPath);
    if (filePath === null) {
      sendText(nodeReq, nodeRes, 400, 'Bad request');
      return;
    }

    if (await serveIfFile(nodeRes, filePath, decodedPath, method)) {
      return;
    }

    const lastSegment = decodedPath.slice(decodedPath.lastIndexOf('/') + 1);
    if (!lastSegment.includes('.')) {
      const indexPath = resolve(staticRoot, 'index.html');
      if (resolveContained(staticRoot, '/index.html') && (await fileExists(indexPath))) {
        await sendFile(nodeRes, indexPath, '/index.html', method, 200);
        return;
      }
    }

    sendText(nodeReq, nodeRes, 404, 'Not found');
  } catch (err) {
    console.error(err);
    if (nodeRes.headersSent) {
      nodeRes.destroy();
      return;
    }
    nodeRes.statusCode = 500;
    if (nodeReq.method === 'HEAD') {
      nodeRes.end();
      return;
    }
    nodeRes.end('Internal error');
  }
}

async function handleApi(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  pathname: string,
  method: string,
): Promise<void> {
  const handler = apiHandlers[pathname];
  if (!handler) {
    sendText(nodeReq, nodeRes, 404, 'Not found');
    return;
  }
  if (method !== 'POST') {
    sendText(nodeReq, nodeRes, 405, 'Method not allowed');
    return;
  }

  const host = nodeReq.headers.host;
  const port = nodeReq.socket.localPort ?? Number(process.env.PORT || 8080);
  const origin = host ? `http://${host}` : `http://localhost:${port}`;

  const request = new Request(`${origin}${nodeReq.url ?? pathname}`, {
    method: nodeReq.method,
    headers: nodeReq.headers as Record<string, string>,
    body: Readable.toWeb(nodeReq) as ReadableStream,
    duplex: 'half',
  });

  const response = await handler(request);
  nodeRes.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-length') return;
    nodeRes.setHeader(key, value);
  });
  nodeRes.flushHeaders();

  if (!response.body) {
    nodeRes.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(response.body), nodeRes);
  } catch (err) {
    console.error(err);
    nodeRes.destroy();
  }
}

function resolveContained(root: string, decodedPath: string): string | null {
  const relativePart = decodedPath.replace(/^\/+/, '');
  const candidate = resolve(root, relativePart);
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return candidate;
}

/** `stat()` codes that mean "this path is not an existing regular file". */
const STAT_NOT_A_FILE = new Set([
  'ENOENT',
  'ENOTDIR',
  'ENAMETOOLONG',
  'EISDIR',
  'EINVAL',
  'ELOOP',
]);

function isStatNotAFile(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' && STAT_NOT_A_FILE.has(code);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const st = await stat(filePath);
    return st.isFile();
  } catch (err) {
    if (isStatNotAFile(err)) return false;
    throw err;
  }
}

async function serveIfFile(
  nodeRes: ServerResponse,
  filePath: string,
  urlPath: string,
  method: string,
): Promise<boolean> {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return false;
  } catch (err) {
    if (isStatNotAFile(err)) return false;
    throw err;
  }
  await sendFile(nodeRes, filePath, urlPath, method, 200);
  return true;
}

async function sendFile(
  nodeRes: ServerResponse,
  filePath: string,
  urlPath: string,
  method: string,
  status: number,
): Promise<void> {
  const ext = extname(filePath).toLowerCase();
  const type = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  nodeRes.statusCode = status;
  nodeRes.setHeader('Content-Type', type);
  nodeRes.setHeader('Cache-Control', cacheControl(urlPath, basename(filePath)));

  if (method === 'HEAD') {
    nodeRes.end();
    return;
  }

  nodeRes.flushHeaders();
  try {
    await pipeline(createReadStream(filePath), nodeRes);
  } catch (err) {
    console.error(err);
    if (nodeRes.headersSent) {
      nodeRes.destroy();
      return;
    }
    throw err;
  }
}

function cacheControl(urlPath: string, fileName: string): string {
  if (urlPath.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  if (NO_CACHE_NAMES.has(fileName) || /^workbox-.*\.js$/.test(fileName)) {
    return 'no-cache';
  }
  if (urlPath.startsWith('/icons/')) {
    return 'public, max-age=86400';
  }
  return 'no-cache';
}

function sendText(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  status: number,
  body: string,
): void {
  nodeRes.statusCode = status;
  if (nodeReq.method === 'HEAD') {
    nodeRes.end();
    return;
  }
  nodeRes.end(body);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const port = Number(process.env.PORT || 8080);
  const staticRoot = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
  createServer(createRequestListener({ staticRoot })).listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}
