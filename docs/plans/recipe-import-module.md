# Recipe import as one module with one API

Recipe import (HTML or pasted text in, a recipe draft out) has no home of its
own. It lives inside the Vercel/Cloud Run entrypoint `api/import.ts`, and each
of its three callers assembles the pipeline differently. This slice moves it
into `server/recipeImport.ts` behind a small, dependency-injected API, so the
web route, the extension route, and the import evals all run the same code.

It comes before writing evals against `evals/import-sites/` (22 cached pages,
branch `eval-import-sites`): an eval is only worth having if it tests the path
production runs.

This slice **deploys nothing**. There are no `[ui]` changes: the API responses
keep the same shape, statuses, and copy, except for the normalization noted in
Decision 4.

## What is wrong today

All of this is `api/import.ts` (573 lines): the Vercel session gate
(`sessionSub`), the HTTP handler, env reads at module scope, HTML region
scanning, JSON-LD selection, the page fetch, and the Gemini call.
`server/extensionImport.ts`, `src/lib/import.eval.ts`, and
`src/lib/extractRecipeSource.test.ts` all import from it.

**Three callers, three pipelines:**

| Caller | Pipeline | Output cleanup |
| --- | --- | --- |
| `POST /api/import` | `fetchPageHtml` → `extractRecipeSource` → `generateRecipeFromSource` | **None.** Raw Gemini object + `sourceUrl`. `src/lib/importApi.ts` only defaults the three arrays, and bulk import passes that straight into `recipeStore.create`. |
| `POST /api/extension/import` | `extractRecipeSource` → `extractRecipeDraft` | `recipePutFromExtraction` (server): servings < 1 or missing → **1** |
| `src/lib/import.eval.ts` | `extractRecipeSource` → `generateRecipeFromSource` | `normalizeRecipeDraft` (client): servings < 1 or missing → **reject** |

So the evals test a cleanup step that neither production path runs. The web
handler also re-implements `extractRecipeDraft`'s status mapping inline.

**Hidden dependencies.** `generateRecipeFromSource` builds its own
`GoogleGenAI` from `process.env.GEMINI_API_KEY`, and `MODEL` is read from
`CHAT_MODEL` at module load. `vitest.eval.config.ts` has to load `.env.local`
before any test file imports `api/import.ts` purely because of that. Neither
the model, the client, nor the prompt can be chosen per call.

**HTTP-shaped domain results.** `fetchPageHtml` and `extractRecipeDraft`
return HTTP statuses and user-facing copy rather than outcomes.

**Untyped output.** Everything downstream of Gemini is
`Record<string, unknown>`.

## Decisions (settled — do not reopen while implementing)

1. **The module is `server/recipeImport.ts`.** No `Request`/`Response`, no
   HTTP status codes, no user-facing copy, no `process.env` reads outside one
   named helper, nothing read at module scope. It may import from `server/`
   only (the runtime image copies `api`, `server`, `scripts`, `dist` — never
   `src`).

2. **`api/import.ts` becomes a Vercel-only stub** that returns
   `401 Unauthorized` for every request. AGENTS.md already says chat/import
   returning 401 on `https://cook-seven-mu.vercel.app` is intended, so this
   removes a copy nobody should be reaching, and it means the Vercel
   no-sibling-imports constraint stops dictating where import code lives.
   `vercel.json` and Vercel env are not touched. `api/chat.ts` is **out of
   scope** (see Follow-ups).

3. **The Cloud Run handler moves to `server/importRoute.ts`** as `importPost`,
   wired in `scripts/server.ts` behind `withMembership` exactly as today. It
   no longer needs the `authorizedSub ?? sessionSub(req)` fallback: on Cloud
   Run `withMembership` is the only gate.

4. **One normalizer, on the server, with the extension's repair rules.**
   `recipePutFromExtraction`'s cleanup is split into
   `normalizeImportedRecipe(raw): ImportedRecipe | null` (title required;
   servings missing or < 1 → 1; empty items/sections/steps dropped; tags
   de-duplicated; negative times dropped). `recipePutFromExtraction` becomes
   that plus `id`/`createdAt`/`updatedAt`/`sourceUrl` and the payload-size
   check. **Behaviour change:** `POST /api/import` now returns the normalized
   recipe instead of Gemini's raw object. That is strictly safer for the
   review screen and for bulk import, which saves without review.
   `src/lib/recipeShape.ts#normalizeRecipeDraft` stays as the client's guard
   for chat proposals; import no longer depends on it.

5. **`ImportedRecipe` is declared in `server/recipeImport.ts`**, structurally
   identical to `RecipeDraft` minus `sourceUrl`/photo fields. A type-level
   assertion in `src/lib/importApi.ts` (`ImportedRecipe` assignable to
   `RecipeDraft`) catches drift at `tsc -b`. Do not add fields to `Recipe`.

6. **Dependencies are passed in.** The Gemini client and model name are
   arguments. `recipeImportDepsFromEnv()` is the only place that reads
   `GEMINI_API_KEY` / `CHAT_MODEL` (keeping the `||` so a blank `CHAT_MODEL=`
   falls back). The prompt and `RECIPE_SCHEMA` stay module constants — they
   are the product, not configuration — but live in this module, once.

7. **Routes own HTTP.** Status codes and copy are mapped in the route files
   from outcome kinds. Every existing status and message is preserved (table
   below), so `ImportScreen` and the extension popup need no changes.

8. **No new behaviour.** No proxy, no new fetch strategy, no `html` field on
   `/api/import` (per `docs/plans/import-blocked-fetch.md`), same prompt, same
   schema, same `MAX_SOURCE_CHARS`, same `maxOutputTokens`.

## The API

```ts
// server/recipeImport.ts

export interface ImportedRecipe {
  title: string;
  servings: number;
  ingredientSections: { name?: string; items: Ingredient[] }[];
  steps: { text: string }[];
  tags: string[];
  description?: string;
  notes?: string;
  prepMinutes?: number;
  cookMinutes?: number;
}

export interface RecipeImportDeps {
  /** Only `models.generateContent` is used; fakes implement exactly this. */
  ai: { models: Pick<GoogleGenAI['models'], 'generateContent'> };
  model: string;
}

export type ImportOutcome =
  | { kind: 'ok'; recipe: ImportedRecipe }
  | { kind: 'empty_source' }   // nothing to send; Gemini is not called
  | { kind: 'not_a_recipe' }   // model said NOT_A_RECIPE
  | { kind: 'parse_error' }    // model output was not a JSON object
  | { kind: 'unusable' };      // JSON, but normalizeImportedRecipe rejected it

/** Pure. HTML → the text Gemini sees (JSON-LD Recipe, else main/article text). */
export function extractRecipeSource(html: string): string;

/** Pure. Raw model object → a saveable draft, or null. */
export function normalizeImportedRecipe(raw: unknown): ImportedRecipe | null;

/** Source text (pasted or extracted) → outcome. The one Gemini call. */
export function importFromSource(source: string, deps: RecipeImportDeps): Promise<ImportOutcome>;

/** extractRecipeSource + importFromSource. What the extension route and page evals call. */
export function importFromHtml(html: string, deps: RecipeImportDeps): Promise<ImportOutcome>;

export type PageFetchOutcome =
  | { kind: 'ok'; html: string }
  | { kind: 'invalid_url' }
  | { kind: 'unsupported_scheme' }
  | { kind: 'unreachable' }
  | { kind: 'refused'; status: number };

/** Website URL path only. The extension never calls this. */
export function fetchPageHtml(url: string, fetchImpl?: typeof fetch): Promise<PageFetchOutcome>;

/** The only env read in the module. */
export function recipeImportDepsFromEnv(): RecipeImportDeps;
```

Callers:

- `server/importRoute.ts` (`POST /api/import`): `url` → `fetchPageHtml` →
  `importFromHtml`; else `text` → `importFromSource`. Adds `sourceUrl` to the
  response.
- `server/extensionImport.ts`: `importFromHtml` → `recipePutFromExtraction`
  (which takes the already-normalized recipe) → `applyPushOp`. Its body, size,
  URL, CORS and auth checks are unchanged.
- `server/recipeImport.eval.ts`: `importFromHtml` / `importFromSource` with
  `recipeImportDepsFromEnv()`.

## Status and copy mapping (must not change)

| Outcome | `/api/import` | `/api/extension/import` |
| --- | --- | --- |
| no url and blank text | 400 `Provide a URL or recipe text.` | — |
| `invalid_url` | 422 `That does not look like a web address.` | 422 same (route's own URL check) |
| `unsupported_scheme` | 422 `Only http and https URLs are supported.` | 422 same |
| `unreachable` | 422 `Could not reach that URL.` | — |
| `refused` | 422 `The site refused the request (<status>). Try pasting the recipe text instead.` | — |
| `empty_source` | 400 `Provide a URL or recipe text.` | 422 `Could not read that page.` |
| `parse_error` | 502 `Extraction failed — no structured result.` | 502 same |
| `not_a_recipe` | 422 `Couldn't find a recipe in that content.` | 422 same |
| `unusable` | 502 `Extraction failed — no structured result.` | 502 `Extraction produced an unusable recipe.` |

## Steps

1. `[core]` Create `server/recipeImport.ts`. Move `extractRecipeSource` and
   its HTML helpers, `RECIPE_SCHEMA`, the prompt, and `fetchPageHtml`
   verbatim from `api/import.ts`; convert `fetchPageHtml`'s returns to
   `PageFetchOutcome` and accept an injected `fetchImpl`. Add
   `importFromSource`, `importFromHtml`, `recipeImportDepsFromEnv`.
2. `[core]` Move the cleanup out of `server/recipeFromExtraction.ts` into
   `normalizeImportedRecipe`; `recipePutFromExtraction` takes an
   `ImportedRecipe` and keeps only id/timestamps/sourceUrl/size.
   `server/recipeFromExtraction.test.ts` keeps passing (split its cases
   between the two functions; do not weaken any).
3. `[core]` Add `server/importRoute.ts` (`importPost`) with the mapping table
   above; wire it in `scripts/server.ts` in place of `api/import.ts`'s `POST`.
4. `[core]` Switch `server/extensionImport.ts` to `importFromHtml` +
   `recipeImportDepsFromEnv()`; delete `extractRecipeDraft`.
5. `[core]` Replace `api/import.ts` with the 401 stub (keep `maxDuration`
   out; nothing to wait for). Remove the `import` case from
   `api/sessionGate.test.ts`; the `chat` case stays.
6. `[core]` Tests (pure, no network — see Tests below). Move
   `src/lib/extractRecipeSource.test.ts` to `server/recipeImport.test.ts`
   unchanged apart from the import path.
7. `[core]` Move `src/lib/import.eval.ts` to `server/recipeImport.eval.ts`;
   point `vitest.eval.config.ts` `include` at `server/**/*.eval.ts`; drop the
   "module scope" comment there (the `.env.local` loader stays, for the key).
   Goldens are normalized with `normalizeImportedRecipe`, not the client's
   `normalizeRecipeDraft`. Existing `evals/import/` fixtures and thresholds
   unchanged. Writing goldens for `evals/import-sites/` is the **next**
   slice, not this one.
8. `[core]` `src/lib/importApi.ts`: add the `ImportedRecipe` → `RecipeDraft`
   type assertion (type-only import from `../../server/recipeImport`; check
   `tsc -b` accepts the cross-project reference, else put the assertion in a
   `server/` test against a local copy of the `RecipeDraft` keys).
9. `[core]` Docs: AGENTS.md (the `api/chat.ts` / `api/import.ts` bullet, the
   plan table, "New HTTP routes go in `server/`"), README.md lines ~343 and
   ~369, and `docs/plans/import-blocked-fetch.md` Decision 2's reference to
   `fetchPageHtml` "on `api/import.ts`".

## Tests

Unit tests stay pure (AGENTS.md: no emulators, no DOM library):

- `importFromSource` with a fake `ai` typed as
  `RecipeImportDeps['ai']` (derive it from the real type, not from memory):
  blank source → `empty_source` and **zero** calls; non-JSON text →
  `parse_error`; `{"title":"NOT_A_RECIPE",…}` → `not_a_recipe`; missing title
  → `unusable`; servings 0 → `ok` with servings 1; passes `deps.model`
  through to `generateContent`.
- `fetchPageHtml` with an injected `fetchImpl`: bad URL, `ftp:`, throw,
  403 → `refused` with 403, 200 → `ok`.
- `importPost` / `extensionImport`: each row of the mapping table, with the
  Gemini deps faked. If injecting deps into a route needs a seam, add a
  `deps` parameter defaulting to `recipeImportDepsFromEnv()` — do not mock
  modules.

## Verification

- `npm run build` (the only type gate on `server/`) and `npm test`.
- `npm run test:import` before and after on the existing `evals/import/`
  fixtures: same pass/fail set. A single failure is re-run before diagnosing
  (Gemini is non-deterministic).
- Browser, Vite + `dev:api` signed in at `http://localhost:5173` (restart
  `dev:api` after the `server/` changes): single URL import, paste import,
  bulk import of 3 links from `evals/import-sites/*/sourceUrl.txt`, a known
  403 site (paste fallback message unchanged), and a non-recipe paste.
- Extension: load `extension/` unpacked against local, import one page, and
  confirm it saves.
- No deploy. The Vercel stub takes effect on Vercel's next deploy of `main`;
  before merging, confirm `POST https://cook-seven-mu.vercel.app/api/import`
  already returns 401 with no cookie, so the stub is not a visible change.

## Follow-ups (not this slice)

- `api/chat.ts` has the same shape (Vercel gate + `RECIPE_SCHEMA` copy +
  module-scope `MODEL`) and is what `scripts/server.ts` serves on Cloud Run.
  Same treatment, separate plan; it touches chat framing, which is on the
  do-not-touch list, so it needs its own care.
- Goldens + harness entries for the 22 `evals/import-sites/` pages.
