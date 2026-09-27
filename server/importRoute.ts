/**
 * `POST /api/import` — URL, pasted text, or up to 4 photos in, a recipe draft
 * out for the client to review and save. Gated by `withMembership` in
 * `scripts/server.ts`. The pipeline lives in `server/recipeImport.ts`; this
 * file only maps its outcomes to HTTP.
 *
 * Photo import is bound by `docs/constitutions/image-import.md`.
 */
import { readBoundedText, type MembershipHandlerContext } from './membership.ts';
import {
  fetchPageHtml,
  importFromHtml,
  importFromImages,
  importFromSource,
  recipeImportDepsFromEnv,
  type ImportImage,
  type ImportOutcome,
  type PageFetchOutcome,
  type RecipeImportDeps,
} from './recipeImport.ts';

export const MAX_IMPORT_IMAGES = 4;
/** Decoded bytes, per image. */
export const MAX_IMPORT_IMAGE_BYTES = 3 * 1024 * 1024;
/** Raw request body. Four images at the per-image cap exceed it. */
export const MAX_IMPORT_BODY_BYTES = 12 * 1024 * 1024;
export const IMPORT_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

interface ImportRequestBody {
  /** URL of a recipe page to fetch and extract. */
  url?: string;
  /** Raw recipe text pasted by the user (used when no url is given). */
  text?: string;
  /**
   * Photos of one recipe, `{ mediaType, base64 }`, used only when `url` is
   * absent. `text` becomes extra context.
   */
  images?: unknown;
}

export type ImportImagesCheck =
  | { kind: 'absent' } // undefined, null, or []
  | { kind: 'ok'; images: ImportImage[]; bytes: number } // bytes = decoded total
  | { kind: 'too_many' }
  | { kind: 'bad_type' }
  | { kind: 'unreadable' }
  | { kind: 'too_large' };

const NOTHING_TO_IMPORT = 'Provide a URL or recipe text.';
const BODY_TOO_LARGE = "That's too large to import — try fewer photos.";
const PHOTOS_NOT_A_RECIPE = "Couldn't find a recipe in those photos.";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function startsWith(bytes: Uint8Array, magic: readonly number[], at = 0): boolean {
  return magic.every((byte, i) => bytes[at + i] === byte);
}

function hasMagic(mediaType: string, base64: string): boolean {
  const head = Buffer.from(base64.slice(0, 16), 'base64');
  switch (mediaType) {
    case 'image/jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8);
    default:
      return false;
  }
}

/** Validates `images` from a request body. The first failure wins, in the order checked. */
export function checkImportImages(raw: unknown): ImportImagesCheck {
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (!Array.isArray(raw)) return { kind: 'unreadable' };
  if (raw.length === 0) return { kind: 'absent' };
  if (raw.length > MAX_IMPORT_IMAGES) return { kind: 'too_many' };

  const images: ImportImage[] = [];
  let bytes = 0;
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.mediaType !== 'string' || typeof item.base64 !== 'string') {
      return { kind: 'unreadable' };
    }
    const mediaType = item.mediaType.trim().toLowerCase();
    if (!IMPORT_IMAGE_TYPES.has(mediaType)) return { kind: 'bad_type' };
    const base64 = item.base64;
    if (base64 === '' || base64.length % 4 !== 0 || !BASE64.test(base64)) {
      return { kind: 'unreadable' };
    }
    const size = decodedBytes(base64);
    if (size > MAX_IMPORT_IMAGE_BYTES) return { kind: 'too_large' };
    if (!hasMagic(mediaType, base64)) return { kind: 'unreadable' };
    images.push({ mediaType, base64 });
    bytes += size;
  }
  return { kind: 'ok', images, bytes };
}

function imagesFailure(check: Exclude<ImportImagesCheck, { kind: 'absent' } | { kind: 'ok' }>): Response {
  switch (check.kind) {
    case 'too_many':
      return Response.json({ error: 'Up to 4 photos.' }, { status: 400 });
    case 'bad_type':
      return Response.json({ error: 'Photos must be JPEG, PNG, or WebP.' }, { status: 400 });
    case 'unreadable':
      return Response.json({ error: "Those photos couldn't be read." }, { status: 400 });
    case 'too_large':
      return Response.json({ error: 'Those photos are too large.' }, { status: 413 });
  }
}

function fetchFailure(page: Exclude<PageFetchOutcome, { kind: 'ok' }>): Response {
  switch (page.kind) {
    case 'invalid_url':
      return Response.json({ error: 'That does not look like a web address.' }, { status: 422 });
    case 'unsupported_scheme':
      return Response.json({ error: 'Only http and https URLs are supported.' }, { status: 422 });
    case 'unreachable':
      return Response.json({ error: 'Could not reach that URL.' }, { status: 422 });
    case 'refused':
      return Response.json(
        {
          error: `The site refused the request (${page.status}). Try pasting the recipe text instead.`,
        },
        { status: 422 },
      );
  }
}

function outcomeResponse(
  outcome: ImportOutcome,
  sourceUrl: string | undefined,
  notARecipe = "Couldn't find a recipe in that content.",
): Response {
  switch (outcome.kind) {
    case 'ok':
      return Response.json({ recipe: { ...outcome.recipe, sourceUrl } });
    case 'empty_source':
      return Response.json({ error: NOTHING_TO_IMPORT }, { status: 400 });
    case 'not_a_recipe':
      return Response.json({ error: notARecipe }, { status: 422 });
    case 'parse_error':
      return Response.json({ error: 'Extraction failed — no structured result.' }, { status: 502 });
    case 'unusable':
      return Response.json({ error: 'Extraction produced an unusable recipe.' }, { status: 502 });
  }
}

export async function importPost(
  req: Request,
  _ctx?: MembershipHandlerContext,
  deps?: RecipeImportDeps,
): Promise<Response> {
  const raw = await readBoundedText(req, MAX_IMPORT_BODY_BYTES);
  if (raw === null) {
    return Response.json({ error: BODY_TOO_LARGE }, { status: 413 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }
  if (!isPlainObject(parsed)) {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }
  const body = parsed as ImportRequestBody;

  if (body.url) {
    const page = await fetchPageHtml(body.url);
    if (page.kind !== 'ok') {
      return fetchFailure(page);
    }
    return outcomeResponse(
      await importFromHtml(page.html, deps ?? recipeImportDepsFromEnv()),
      body.url,
    );
  }

  const check = checkImportImages(body.images);
  if (check.kind === 'ok') {
    const { images, bytes } = check;
    console.log(`import images count=${images.length} bytes=${bytes}`);
    let outcome: ImportOutcome;
    try {
      outcome = await importFromImages(
        images,
        typeof body.text === 'string' ? body.text : '',
        deps ?? recipeImportDepsFromEnv(),
      );
    } catch {
      // Nothing from the error is logged: SDK errors can echo the request.
      console.error(`import images failed count=${images.length} bytes=${bytes}`);
      return Response.json({ error: "Couldn't read those photos — try again." }, { status: 502 });
    }
    return outcomeResponse(outcome, undefined, PHOTOS_NOT_A_RECIPE);
  }
  if (check.kind !== 'absent') {
    return imagesFailure(check);
  }

  const text = body.text?.trim() ?? '';
  if (text === '') {
    return Response.json({ error: NOTHING_TO_IMPORT }, { status: 400 });
  }
  return outcomeResponse(await importFromSource(text, deps ?? recipeImportDepsFromEnv()), undefined);
}
