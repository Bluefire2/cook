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
  IMPORT_BAD_LANGUAGE_CODE,
  IMPORT_BAD_LANGUAGE_ERROR,
  fetchPageHtml,
  importFromHtml,
  importFromImages,
  importFromSource,
  readImportTranslateTo,
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
  /** Supported UI language. When set, the response may include a translation. */
  translateTo?: unknown;
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
      return fail('import-too-many-photos', 'Up to 4 photos.', 400);
    case 'bad_type':
      return fail('import-bad-photo-type', 'Photos must be JPEG, PNG, or WebP.', 400);
    case 'unreadable':
      return fail('import-photos-unreadable', "Those photos couldn't be read.", 400);
    case 'too_large':
      return fail('import-photos-too-large', 'Those photos are too large.', 413);
  }
}

function fail(code: string, error: string, status: number, siteStatus?: number): Response {
  const body: { error: string; code: string; status?: number } = { error, code };
  if (siteStatus !== undefined) {
    body.status = siteStatus;
  }
  return Response.json(body, { status });
}

function fetchFailure(page: Exclude<PageFetchOutcome, { kind: 'ok' }>): Response {
  switch (page.kind) {
    case 'invalid_url':
      return fail('import-bad-url', 'That does not look like a web address.', 422);
    case 'unsupported_scheme':
      return fail('import-bad-scheme', 'Only http and https URLs are supported.', 422);
    case 'unreachable':
      return fail('import-unreachable', 'Could not reach that URL.', 422);
    case 'refused':
      return fail(
        'import-refused',
        `The site refused the request (${page.status}). Try pasting the recipe text instead.`,
        422,
        page.status,
      );
  }
}

function outcomeResponse(
  outcome: ImportOutcome,
  sourceUrl: string | undefined,
  notARecipe: { code: string; error: string } = {
    code: 'import-no-recipe',
    error: "Couldn't find a recipe in that content.",
  },
): Response {
  switch (outcome.kind) {
    case 'ok': {
      const recipe = { ...outcome.recipe, sourceUrl };
      const translation = outcome.translation;
      if (translation?.kind === 'ok') {
        return Response.json({
          recipe,
          translation: {
            lang: translation.lang,
            recipe: { ...translation.recipe, sourceUrl },
          },
        });
      }
      if (translation?.kind === 'failed') {
        return Response.json({ recipe, translationFailed: true });
      }
      return Response.json({ recipe });
    }
    case 'empty_source':
      return fail('import-empty', NOTHING_TO_IMPORT, 400);
    case 'not_a_recipe':
      return fail(notARecipe.code, notARecipe.error, 422);
    case 'parse_error':
      return fail('import-extract-failed', 'Extraction failed — no structured result.', 502);
    case 'unusable':
      return fail('import-unusable', 'Extraction produced an unusable recipe.', 502);
  }
}

export async function importPost(
  req: Request,
  _ctx?: MembershipHandlerContext,
  deps?: RecipeImportDeps,
): Promise<Response> {
  const raw = await readBoundedText(req, MAX_IMPORT_BODY_BYTES);
  if (raw === null) {
    return fail('import-body-too-large', BODY_TOO_LARGE, 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('bad-request', 'Bad request', 400);
  }
  if (!isPlainObject(parsed)) {
    return fail('bad-request', 'Bad request', 400);
  }
  const body = parsed as ImportRequestBody;
  const target = readImportTranslateTo(body.translateTo);
  if (!target.ok) {
    return fail(IMPORT_BAD_LANGUAGE_CODE, IMPORT_BAD_LANGUAGE_ERROR, 400);
  }

  if (body.url) {
    const page = await fetchPageHtml(body.url);
    if (page.kind !== 'ok') {
      return fetchFailure(page);
    }
    return outcomeResponse(
      await importFromHtml(page.html, deps ?? recipeImportDepsFromEnv(), target.translateTo),
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
        target.translateTo,
      );
    } catch {
      // Nothing from the error is logged: SDK errors can echo the request.
      console.error(`import images failed count=${images.length} bytes=${bytes}`);
      return fail('import-photos-failed', "Couldn't read those photos — try again.", 502);
    }
    return outcomeResponse(outcome, undefined, {
      code: 'import-no-recipe-photos',
      error: PHOTOS_NOT_A_RECIPE,
    });
  }
  if (check.kind !== 'absent') {
    return imagesFailure(check);
  }

  const text = body.text?.trim() ?? '';
  if (text === '') {
    return fail('import-empty', NOTHING_TO_IMPORT, 400);
  }
  return outcomeResponse(
    await importFromSource(text, deps ?? recipeImportDepsFromEnv(), target.translateTo),
    undefined,
  );
}
