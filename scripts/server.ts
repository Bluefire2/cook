/**
 * Production HTTP server: API routes plus static `dist/` and SPA fallback.
 * Run after `npm run build`:
 *
 *   node --env-file=.env.local scripts/server.ts
 *
 * `createRequestListener({ staticRoot: null })` is the API-only listener used
 * by `scripts/dev-api-server.ts`. With `staticRoot: null`, `/privacy`,
 * `/terms`, and `/about` return 404 on this port; Vite serves `public/` on
 * :5173 in dev. `/invite/:token` is handled here in both modes (Vite proxies
 * `/invite`).
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
import { importPost } from '../server/importRoute.ts';
import {
  authCallbackGoogle,
  authSession,
  authSignout,
  authStart,
} from '../server/auth.ts';
import { redirectUri } from '../server/env.ts';
import {
  adminDecisionPost,
  adminInviteRevokePost,
  adminInvitesGet,
  adminInvitesPost,
  adminRequestsGet,
} from '../server/admin.ts';
import { accessRequestPost } from '../server/access.ts';
import { extensionImport, extensionImportOptions } from '../server/extensionImport.ts';
import { inviteLandingGet } from '../server/invites.ts';
import { withMembership } from '../server/membership.ts';
import { photosGet, photosPost } from '../server/photos.ts';
import { sttPost } from '../server/stt.ts';
import {
  collectionGrantsGet,
  collectionGrantsPost,
  collectionGrantsRevokePost,
} from '../server/grantsHttp.ts';
import { syncPull, syncPush, syncSharedPull } from '../server/sync.ts';

type ApiHandler = (req: Request) => Promise<Response>;

interface ApiRoute {
  method: string;
  path: string;
  handler: ApiHandler;
}

const apiRoutes: ApiRoute[] = [
  { method: 'POST', path: '/api/chat', handler: withMembership(chatPost) },
  { method: 'POST', path: '/api/import', handler: withMembership(importPost) },
  { method: 'POST', path: '/api/stt', handler: sttPost },
  { method: 'POST', path: '/api/access-request', handler: accessRequestPost },
  { method: 'GET', path: '/api/admin/requests', handler: adminRequestsGet },
  { method: 'POST', path: '/api/admin/decision', handler: adminDecisionPost },
  { method: 'GET', path: '/api/admin/invites', handler: adminInvitesGet },
  { method: 'POST', path: '/api/admin/invites', handler: adminInvitesPost },
  { method: 'POST', path: '/api/admin/invites/revoke', handler: adminInviteRevokePost },
  { method: 'GET', path: '/api/auth/start', handler: authStart },
  { method: 'GET', path: '/api/auth/callback/google', handler: authCallbackGoogle },
  { method: 'GET', path: '/api/auth/session', handler: authSession },
  { method: 'POST', path: '/api/auth/signout', handler: authSignout },
  { method: 'GET', path: '/api/sync/pull', handler: syncPull },
  { method: 'GET', path: '/api/sync/shared', handler: syncSharedPull },
  { method: 'POST', path: '/api/sync/push', handler: syncPush },
  { method: 'POST', path: '/api/extension/import', handler: extensionImport },
  { method: 'OPTIONS', path: '/api/extension/import', handler: extensionImportOptions },
];

const PUBLIC_HTML: Record<string, string> = {
  '/privacy': '/privacy.html',
  '/terms': '/terms.html',
  '/about': '/about.html',
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
  'privacy.html',
  'terms.html',
  'about.html',
]);

let loggedRedirectUri = false;

function logRedirectUriOnce(): void {
  if (loggedRedirectUri) {
    return;
  }
  loggedRedirectUri = true;
  try {
    console.log(`OAuth redirect URI: ${redirectUri()}`);
  } catch {
    // PUBLIC_ORIGIN may be unset in API-only dev without full auth env.
  }
}

export function createRequestListener(options: { staticRoot: string | null }) {
  logRedirectUriOnce();
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

    if (decodedPath === '/invite' || decodedPath.startsWith('/invite/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(nodeReq, nodeRes, 405, 'Method not allowed');
        return;
      }
      await dispatchFetch(nodeReq, nodeRes, decodedPath, method, inviteLandingGet);
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

    const publicRelative = PUBLIC_HTML[decodedPath];
    if (publicRelative !== undefined) {
      const publicPath = resolveContained(staticRoot, publicRelative);
      if (publicPath !== null && (await serveIfFile(nodeRes, publicPath, decodedPath, method))) {
        return;
      }
      sendText(nodeReq, nodeRes, 404, 'Not found');
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

function matchApiRoute(pathname: string, method: string): ApiHandler | 'wrongMethod' | null {
  let pathMatched = false;
  for (const route of apiRoutes) {
    if (route.path === pathname) {
      pathMatched = true;
      if (route.method === method) {
        return route.handler;
      }
    }
  }
  if (pathMatched) {
    return 'wrongMethod';
  }

  const photosPrefix = '/api/photos/';
  if (pathname.startsWith(photosPrefix)) {
    const rest = pathname.slice(photosPrefix.length);
    if (rest !== '' && !rest.includes('/')) {
      if (method === 'POST') {
        return photosPost;
      }
      if (method === 'GET' || method === 'HEAD') {
        return photosGet;
      }
      return 'wrongMethod';
    }
  }

  const grantsMatch = pathname.match(/^\/api\/collections\/[^/]+\/grants$/);
  if (grantsMatch) {
    if (method === 'GET') {
      return collectionGrantsGet;
    }
    if (method === 'POST') {
      return collectionGrantsPost;
    }
    return 'wrongMethod';
  }
  const revokeMatch = pathname.match(/^\/api\/collections\/[^/]+\/grants\/revoke$/);
  if (revokeMatch) {
    if (method === 'POST') {
      return collectionGrantsRevokePost;
    }
    return 'wrongMethod';
  }

  return null;
}

async function handleApi(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  pathname: string,
  method: string,
): Promise<void> {
  const match = matchApiRoute(pathname, method);
  if (match === null) {
    sendText(nodeReq, nodeRes, 404, 'Not found');
    return;
  }
  if (match === 'wrongMethod') {
    sendText(nodeReq, nodeRes, 405, 'Method not allowed');
    return;
  }

  await dispatchFetch(nodeReq, nodeRes, pathname, method, match);
}

async function dispatchFetch(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  pathname: string,
  method: string,
  handler: ApiHandler,
): Promise<void> {
  const host = nodeReq.headers.host;
  const port = nodeReq.socket.localPort ?? Number(process.env.PORT || 8080);
  const origin = host ? `http://${host}` : `http://localhost:${port}`;

  const request = new Request(`${origin}${nodeReq.url ?? pathname}`, {
    method: nodeReq.method,
    headers: nodeReq.headers as Record<string, string>,
    body: method === 'GET' || method === 'HEAD' ? undefined : (Readable.toWeb(nodeReq) as ReadableStream),
    duplex: method === 'GET' || method === 'HEAD' ? undefined : 'half',
  });

  const response = await handler(request);
  await writeFetchResponse(nodeRes, response);
}

async function writeFetchResponse(nodeRes: ServerResponse, response: Response): Promise<void> {
  nodeRes.statusCode = response.status;
  const setCookies = response.headers.getSetCookie();
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'set-cookie') {
      return;
    }
    nodeRes.setHeader(key, value);
  });
  if (setCookies.length > 0) {
    nodeRes.setHeader('Set-Cookie', setCookies);
  }
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
