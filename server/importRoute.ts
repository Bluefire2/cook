/**
 * `POST /api/import` — URL or pasted text in, a recipe draft out for the
 * client to review and save. Gated by `withMembership` in `scripts/server.ts`.
 * The pipeline lives in `server/recipeImport.ts`; this file only maps its
 * outcomes to HTTP.
 */
import type { MembershipHandlerContext } from './membership.ts';
import {
  fetchPageHtml,
  importFromHtml,
  importFromSource,
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
}

const NOTHING_TO_IMPORT = 'Provide a URL or recipe text.';

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

function outcomeResponse(outcome: ImportOutcome, sourceUrl: string | undefined): Response {
  switch (outcome.kind) {
    case 'ok':
      return Response.json({ recipe: { ...outcome.recipe, sourceUrl } });
    case 'empty_source':
      return Response.json({ error: NOTHING_TO_IMPORT }, { status: 400 });
    case 'not_a_recipe':
      return Response.json({ error: "Couldn't find a recipe in that content." }, { status: 422 });
    case 'parse_error':
    case 'unusable':
      return Response.json({ error: 'Extraction failed — no structured result.' }, { status: 502 });
  }
}

export async function importPost(
  req: Request,
  _ctx?: MembershipHandlerContext,
  deps?: RecipeImportDeps,
): Promise<Response> {
  const body = (await req.json()) as ImportRequestBody;

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

  const text = body.text?.trim() ?? '';
  if (text === '') {
    return Response.json({ error: NOTHING_TO_IMPORT }, { status: 400 });
  }
  return outcomeResponse(await importFromSource(text, deps ?? recipeImportDepsFromEnv()), undefined);
}
