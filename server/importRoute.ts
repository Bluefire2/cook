/**
 * `POST /api/import` — URL or pasted text in, a recipe draft out for the
 * client to review and save. Gated by `withMembership` in `scripts/server.ts`.
 * The pipeline lives in `server/recipeImport.ts`; this file only maps its
 * outcomes to HTTP.
 */
import type { MembershipHandlerContext } from './membership.ts';
import {
  IMPORT_BAD_LANGUAGE_CODE,
  IMPORT_BAD_LANGUAGE_ERROR,
  fetchPageHtml,
  importFromHtml,
  importFromSource,
  readImportTranslateTo,
  recipeImportDepsFromEnv,
  type ImportOutcome,
  type PageFetchOutcome,
  type RecipeImportDeps,
} from './recipeImport.ts';

interface ImportRequestBody {
  /** URL of a recipe page to fetch and extract. */
  url?: string;
  /** Raw recipe text pasted by the user (used when no url is given). */
  text?: string;
  /** Supported UI language. When set, the response may include a translation. */
  translateTo?: unknown;
}

const NOTHING_TO_IMPORT = 'Provide a URL or recipe text.';

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

function outcomeResponse(outcome: ImportOutcome, sourceUrl: string | undefined): Response {
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
      return fail('import-no-recipe', "Couldn't find a recipe in that content.", 422);
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
  const body = (await req.json()) as ImportRequestBody;
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

  const text = body.text?.trim() ?? '';
  if (text === '') {
    return fail('import-empty', NOTHING_TO_IMPORT, 400);
  }
  return outcomeResponse(
    await importFromSource(text, deps ?? recipeImportDepsFromEnv(), target.translateTo),
    undefined,
  );
}
