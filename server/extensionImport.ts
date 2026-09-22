/**
 * `POST /api/extension/import` — the Chrome extension's one-shot import.
 *
 * Unlike `/api/import`, which extracts and hands the recipe back for the client
 * to save, this route extracts **and writes**: the extension has no Dexie, no
 * outbox and no sync engine. It writes through `applyPushOp` so validation, LWW
 * and `compactRecipeFields` keep their single home in `server/sync.ts`.
 */
import { randomUUID } from 'node:crypto';
import { extractRecipeDraft, extractRecipeSource } from '../api/import.ts';
import { recipePutFromExtraction } from './recipeFromExtraction.ts';
import { sessionFromHeader } from './session.ts';
import { applyPushOp } from './sync.ts';

/** Buffered then measured, matching `syncPush`'s `raw.length` convention. */
const MAX_BODY_CHARS = 1_500_000;
/** The extension caps itself at 400 000; this is the server refusing to be the one that runs out of memory. */
const MAX_HTML_CHARS = 600_000;
const TOO_LARGE = 'Page was too large to import.';

// A Gemini extraction regularly outlasts a 10s default, same as `/api/import`.
export const maxDuration = 60;

interface ExtensionImportBody {
  url?: unknown;
  html?: unknown;
}

/**
 * Real Chrome extension ids are 32 characters drawn from a–p. Used to decide
 * whether a preflight deserves an answer; it grants no authority on its own,
 * since the session header is what authenticates.
 */
export function isExtensionOrigin(origin: string | null): boolean {
  return origin !== null && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!isExtensionOrigin(origin)) {
    return {};
  }
  return {
    // No Allow-Credentials: the cookie is deliberately not what authenticates
    // here, and omitting it makes a credentialed cross-origin request fail.
    'Access-Control-Allow-Origin': origin as string,
    Vary: 'Origin',
  };
}

const SOURCE_MARKERS = ['ingredient', 'ingredients', 'recipe', 'kapusnyak', 'sauerkraut', 'pork'];

function importSourceDebug(url: string, html: string, source: string) {
  const haystack = `${html}\n${source}`.toLowerCase();
  return {
    url,
    htmlChars: html.length,
    sourceChars: source.length,
    via: source.trimStart().startsWith('{') ? 'ld+json' : 'text',
    hasMain: /<main\b/i.test(html),
    hasArticle: /<article\b/i.test(html),
    hits: SOURCE_MARKERS.filter((word) => haystack.includes(word)),
    sourceHead: source.replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}

function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(req),
    },
  });
}

export function extensionImportOptions(req: Request): Promise<Response> {
  const cors = corsHeaders(req);
  if (Object.keys(cors).length === 0) {
    return Promise.resolve(
      new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } }),
    );
  }
  return Promise.resolve(
    new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'content-type, x-sous-session',
        'Access-Control-Max-Age': '600',
      },
    }),
  );
}

export async function extensionImport(req: Request): Promise<Response> {
  const session = sessionFromHeader(req);
  if (session === null) {
    return jsonResponse(req, { error: 'Unauthorized' }, 401);
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return jsonResponse(req, { error: 'Bad request' }, 400);
  }
  if (raw.length > MAX_BODY_CHARS) {
    return jsonResponse(req, { error: TOO_LARGE }, 413);
  }

  let body: ExtensionImportBody;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    body = parsed as ExtensionImportBody;
  } catch {
    return jsonResponse(req, { error: 'Bad request' }, 400);
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  // `sourceUrl` is stored on the recipe even though this route never fetches
  // the URL: empty html is an error, not a `fetchPageHtml` fallback.
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    return jsonResponse(req, { error: 'That does not look like a web address.' }, 422);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return jsonResponse(req, { error: 'Only http and https URLs are supported.' }, 422);
  }

  const html = typeof body.html === 'string' ? body.html : '';
  if (html.length > MAX_HTML_CHARS) {
    return jsonResponse(req, { error: TOO_LARGE }, 413);
  }
  if (html.trim() === '') {
    return jsonResponse(req, { error: 'Could not read that page.' }, 422);
  }

  const source = extractRecipeSource(html);
  const debug = importSourceDebug(url, html, source);
  console.info('sous extensionImport', debug);

  if (source.trim() === '') {
    return jsonResponse(req, { error: 'Could not read that page.', debug }, 422);
  }

  const extracted = await extractRecipeDraft(source);
  console.info('sous extensionImport extract', {
    url,
    ok: extracted.ok,
    status: extracted.ok ? 200 : extracted.status,
    error: extracted.ok ? undefined : extracted.error,
  });
  if (!extracted.ok) {
    return jsonResponse(
      req,
      { error: extracted.error, debug: { ...debug, extractStatus: extracted.status } },
      extracted.status,
    );
  }

  const payload = recipePutFromExtraction(extracted.recipe, {
    id: randomUUID(),
    now: Date.now(),
    sourceUrl: url,
  });
  if (payload === null) {
    return jsonResponse(req, { error: 'Extraction produced an unusable recipe.' }, 502);
  }

  // Firestore is the likeliest thing to fail here, and an escaping throw would
  // reach the dispatcher as a text/plain 500 the popup cannot parse.
  let applied: boolean;
  try {
    const result = await applyPushOp(session.sub, { kind: 'recipe.put', payload });
    applied = result.applied;
  } catch (err) {
    console.error(err);
    applied = false;
  }
  if (!applied) {
    return jsonResponse(req, { error: 'Could not save the recipe.' }, 500);
  }

  return jsonResponse(req, { id: payload.id, title: payload.title });
}
