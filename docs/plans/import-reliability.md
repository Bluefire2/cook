# Recipe import reliability

**Status:** Approved 2026-09-30. The import log line (2c) and its
privacy/terms copy (2f) are built ahead of the rest on `claude/import-logs`,
not deployed. That first version of the line has no `source`, `attempts`, or
`codes`; phase 2 adds them. Phase 1 is waiting on the reporter's failing
URLs.

## Context

A ~50-recipe bulk import surfaced two problems. Some URL imports fail outright.
Others "succeed" with whole sections missing, most often ingredients with no
steps. Today `server/recipeImport.ts` makes one Gemini call. When the call
throws, the URL path has no try/catch and the request 500s. `parse_error` and
`unusable` become 502s. A recipe with zero steps comes back as `ok`. The
preview shows a generic `import.fixBeforeSaving` banner, and bulk import shows
nothing at all.

The goal is to check every import deterministically, record **specific** typed
warnings on the saved recipe, retry only where a retry can help, and log
enough to measure the spec's open questions.

**Decisions from the owner (this session)**
- Warnings persist as an **optional `Recipe.importCheck` field**. This is a
  deliberate break of the AGENTS.md schema lock, the second after `lang`,
  and it amends that rule in the same PR.
- The owner will supply the dogfooder's failing URLs. Phase 1 turns them into
  cached fixtures and calibrates the thresholds against them.
- JSON-LD is used **as a reference only**. Gemini still runs on every page.
  The deterministic fast path (spec §4.1) is out of scope and gets a later plan
  once the logs show how much it would save.

**Other decisions (mine, locked unless the owner objects)**
- **Photo import is out of scope.** Constitution `image-import.md` P1 says one
  call, and the photo retry was measured and reverted (`evals/EXPERIMENTS.md`,
  2026-09-27). `importFromImages`, its schema, and its prompt stay unchanged.
  Paste, URL, and extension imports all go through `importFromSource`, so all
  three get the checks.
- **Retries are a code constant (`MAX_IMPORT_RETRIES`), not an env var.**
  Phase 2 ships it at `0` and phase 3 sets it to `2`. This avoids a deploy-time
  flag that `--env-vars-file` could silently revert.
- **Logs record the account `sub` and the source URL with its query string and
  fragment removed. They never record the email or any recipe text.** With
  these, "show me this account's recent imports" is a single log query; with
  only a hostname it can't be answered. The query and fragment are removed
  because real imported URLs carry other people's tracking and access data:
  the reporter's library has NYT links with `user_id=` and
  `unlocked_article_code=`, and an `fbclid=`. `/privacy` and `/terms` disclose
  this in the same PR (step 2f).
- **Self-report fields** are `instructionsOnPage` and `ingredientsOnPage`, in
  camelCase like the rest of the schema. They go on a page/paste-only schema;
  the photo schema and the `api/chat.ts` copy do not change. `extraction_notes`
  is dropped: nothing would read it, and logging model text could echo page
  content.
- **Warnings are computed on the original extraction**, before translation.
  `UNGROUNDED_INGREDIENT` stores the ingredient's position, not its name, so
  the banner shows the current name, translated or edited. This works because
  i18n P4 says translation never changes structure.
- **No `ImportOutcome` kind is added for warnings.** `ok` gains
  `warnings: ImportWarning[]`, which may be empty. Failures keep their existing
  kinds.

Constitutions that apply: **i18n** (P9, P10, P16: codes from the server, words
in the catalogs, in-context review), **client-state** (RecipeView reads and
any new sheet), and **image-import** (checked, and untouched).

---

## Phase 1: Fixtures and hand classification (spec §10.1; no product code)

0. **[core]** Add `scripts/import-audit.ts <email>`. It is read-only and uses
   ADC like the backfill scripts. It resolves the account by `emailLower`,
   then lists the live recipes in `createdAt` order with the URL (query and
   fragment removed), ingredient and step counts, and whether the recipe was
   edited. It also lists the recipes with no `sourceUrl` and the tombstones.

   **What it found for the reporter (2026-09-30):**
   - The whole session ran from 2026-09-20 03:44 to 04:12 UTC: 36 URL imports
     interleaved with 10 recipes that have no `sourceUrl`, plus 2 deletions.
   - The no-`sourceUrl` recipes were not photo imports (none has a photo).
     They are very likely the same recipes **pasted as text after the URL
     import failed**. That makes them the hard failures, and their URLs are
     not stored anywhere.
   - Neither deletion keeps content (tombstones hold only
     `id`/`updatedAt`/`deletedAt`). One URL recipe was created 13 s after the
     second deletion, which looks like a bad import deleted and re-imported.
   - **No surviving URL import has zero steps or zero ingredients.** One was
     edited after import. The silent partial failures were fixed or deleted by
     hand, so the library can't show them.
   - So the failing URLs must come from the reporter. The paste-imported
     titles narrow down which recipes they were.

1. **[core]** Cache each failing URL the owner supplies as
   `evals/import-sites/<name>/page.html` plus `sourceUrl.txt`. Fetch them with
   the **same UA and headers as `fetchPageHtml`**, because a source failure
   depends on what the server sees, not what a browser renders. Add each one to
   `EXPECTED` in `evals/pageFixtures.test.ts`.
2. **[core]** Add `evals/import-sites/<name>/class.json`:
   `{ "class": "source" | "extraction" | "ok", "why": "…" }`, classified by
   hand. Record the source/extraction split in the plan doc. If source failures
   dominate, tell the owner before phase 3, because the spec says page fetching
   is the better investment in that case.

## Phase 2: Checks, warnings, logging, UI (spec §10.2; retries off)

### 2a. Pure checks: `server/importChecks.ts` (new) **[core]**

Nothing in this module calls Gemini or does I/O. Exports:

- `ImportWarningCode`: the ten codes from spec §6.1–6.2, plus `BLOCKING`, the
  set from §6.3.
- `ImportWarning = { code; at?: [section: number, item: number] }`.
- `readRecipeJsonLd(html)`: refactor the JSON-LD scan out of
  `extractRecipeSource` so both callers share one parser. It returns the Recipe
  node, plus the ingredient count and step count with `HowToSection`
  flattened.
- `hasInstructionLikeContent(html | text)`: an `<ol>` with at least 2 `<li>`
  in `primaryRegion`, or a heading or line that matches a small multilingual
  word list ("instructions", "directions", "method", "preparation", "steps",
  "how to make", plus the uk/ru/zh/es/fr/it/de equivalents), or `Step 1` /
  numbered-line patterns. It also returns true when the JSON-LD
  `recipeInstructions` is non-empty. **Conservative by design:** when unsure it
  returns true, so the source-failure banner (which needs this to be false)
  stays rare.
- `groundingCorpus(html)`: the full untruncated page text plus the JSON-LD
  text. `stripToText` drops `<script>`, so JSON-LD must be added back. For
  paste, the corpus is the pasted text.
- `checkImport({ recipe, selfReport, jsonLd?, sourceHasInstructions, corpus })
  → { warnings, failureClass: 'none' | 'extraction' | 'source' }`:
  - Structural checks (§6.1). `TOO_FEW_STEPS` uses `MIN_STEPS = 2`; phase 1
    calibrates it.
  - `INSTRUCTIONS_NOT_ON_PAGE` fires only when steps are empty **and**
    `!sourceHasInstructions` **and** `selfReport.instructionsOnPage === false`.
    It classifies as **source**.
  - `INSTRUCTIONS_DROPPED` fires when steps are empty and
    `sourceHasInstructions`. It classifies as **extraction**. If steps are
    empty and the signals disagree, only `MISSING_INSTRUCTIONS` fires, classed
    as extraction, so a retry is allowed.
  - `MISSING_INGREDIENTS` is classed as extraction unless the JSON-LD has no
    ingredients and `ingredientsOnPage === false`.
  - The count checks run only when the JSON-LD has the list, and they flag only
    the *fewer* direction. Ingredients flag when
    `extracted < jsonLd − max(2, 20%)`. Steps flag when
    `extracted < 50% of jsonLd`, because the prompt tells Gemini to "trim fluff"
    and it legitimately merges steps. Phase 1 calibrates both thresholds.
  - The grounding check normalizes each item: NFKD, strip diacritics,
    lowercase, drop numbers, units (`src/lib/units.ts` vocabulary), and
    stopwords, then strip a trailing `s`/`es`. The item is grounded if any
    token of 3+ characters appears in the normalized corpus; CJK uses a
    substring match. It reports at most 3 items. It skips entirely when more
    than half the items look ungrounded, because that means the corpus is
    wrong, not the model.
- `pickBestAttempt(attempts)`: the fewest blocking warnings, then the most
  steps, then the earliest attempt.

`server/importChecks.test.ts` covers each code, each failure class, the
precedence rules, and the CJK and diacritic grounding cases.

### 2b. Pipeline: `server/recipeImport.ts` **[core]**

- Add `PAGE_RECIPE_SCHEMA`, which is `RECIPE_SCHEMA` plus `instructionsOnPage`
  and `ingredientsOnPage` (BOOLEAN). `importFromSource` uses it.
  `outcomeFromModelText` reads the self-report next to
  `normalizeImportedRecipe`, which still strips unknown keys.
- `importFromHtml` builds its check context from the HTML through 2a.
  `importFromSource` called directly (the paste path) builds a text-only
  context.
- Add an attempt loop inside `importFromSource`, before translation, with up
  to `1 + MAX_IMPORT_RETRIES` calls:
  - A thrown `generateContent`, `parse_error`, or `unusable` is a hard failure:
    retry.
  - `ok` with a blocking warning and `failureClass === 'extraction'`: retry.
  - `source`, `not_a_recipe`, `empty_source`: never retry.
  - Stop starting new attempts after `IMPORT_RETRY_DEADLINE_MS` (≈40 s), so a
    bulk row cannot stall. Retries are immediate; spec §9.4 backoff waits for
    data that shows rate limits.
  - When every attempt has warnings, return `pickBestAttempt`. When none is
    usable, return the last failure kind. A final throw becomes a new
    `{ kind: 'model_error' }`, so the URL path no longer 500s; the routes map
    it to a 502 with code `import-model-failed`.
- `ImportOutcome.ok` gains `warnings` and `attempts`. `attempts` is a list of
  `{ result: 'ok' | 'warn' | 'parse_error' | 'unusable' | 'threw' | …, codes }`
  and is used only for logging. `finishImport` passes both through unchanged.
- `export const MAX_IMPORT_RETRIES = 0` in this phase.

Extend `server/recipeImport.test.ts` with fake `generateContent` sequences:
throw → ok, empty steps on an instruction page → retry, source failure → no
retry, the deadline, best-attempt selection, and that the photo path still
makes exactly one call. While retries are 0, the fakes override the constant
through a `deps.maxRetries?` test seam.

### 2c. Routes and logs **[core]**

- In `server/importRoute.ts` `outcomeResponse`, add `warnings` to the JSON when
  it is non-empty. The server sends codes and the client owns the words (i18n
  P10). Map `model_error`.
- In `server/extensionImport.ts`, map `model_error`.
  `recipePutFromExtraction` gains an optional `importCheck` and writes it when
  there are warnings.
- Add one structured log line for **every** import request, through a helper
  `logImport({ sub, via: 'url'|'paste'|'photos'|'extension', url?, host?,
  source?: 'jsonld'|'text', fetch?: 'ok'|'unreachable'|'refused:<status>'|…,
  attempts, final: 'clean'|'warnings'|'failed', failure?: <error code>,
  codes, ms })`.
  - The line covers page-fetch failures too. Today those return without a log,
    and they are exactly the hard failures the reporter hit.
  - `url` is `origin + pathname`, and only for `url` and `extension`.
  - `sub` comes from `ctx.authorizedSub` (`MembershipHandlerContext`) in
    `importPost` and from `access.sub` in `extensionImport`.
  - It is `console.log(JSON.stringify({ event: 'import', … }))`, so Cloud
    Logging parses it as `jsonPayload`.
  - Unit-test the line's shape and that a URL's query string and fragment never
    appear in it.
  - The line answers spec §8 (path, attempts, codes, final state, URL and
    domain) and the per-account question.

### 2d. `Recipe.importCheck`: schema amendment **[core]**

```ts
importCheck?: {
  at: number;                 // import time
  warnings: ImportWarning[];  // non-empty when present
  dismissedAt?: number;
  editedAt?: number;          // first content change after import
}
```

- Add the field to `src/lib/types.ts`. Update `compactRecipe` and the server
  `compactRecipeFields` / `validateRecipePut` in `server/store.ts`: codes must
  be in the known set, at most 10 warnings, integer `at`, finite timestamps.
  An invalid value is dropped, not rejected, so old clients never break.
- Update the key-set lock in `src/lib/recipeStore.test.ts`, the AGENTS.md
  schema-lock paragraph (`importCheck` becomes the second deliberate exception,
  and code must work when it is missing), and any `scripts/invariants.test.ts`
  rule that names the key set.
- Add a pure `reconcileImportCheck(prev, next)`, applied in the
  `recipeStore` update path. It covers Edit, Ask Apply, and the editor role. It
  sets `editedAt` on the first content change. It drops a structural or source
  warning once its condition no longer holds (for example, steps were added).
  It drops position-addressed warnings when `ingredientSections` changes. It
  keeps `dismissedAt`.
- Backup round-trips through `compactRecipe`, so no further change is needed
  there. Add a `backup.test.ts` case for it.

### 2e. UI **[ui]**

All copy goes in `en`, `uk`, `ru`, and `zh-Hans`, with one key per warning
code plus action and summary keys. New states go in
`docs/i18n-review/screens.json`.

- **Import preview** (`ImportScreen.tsx`): remove the
  `import.fixBeforeSaving` banner and its catalog keys (spec §7.3). When the
  result has warnings, show a specific warning list in its place. Saving puts
  `importCheck` on the draft (`ImportPreview` → `recipeStore.create`).
  `importApi.ts` parses `warnings` defensively and ignores unknown codes.
- **Recipe view banner** (new `components/ImportWarningBanner.tsx`): shown when
  `importCheck` has warnings, no `dismissedAt`, and the viewer can edit
  (owner, or a shared-collection editor; viewers never see it). It uses the
  spec §7.2 copy per code and renders `UNGROUNDED_INGREDIENT` with the current
  ingredient name at `at`. Actions:
  - **View original** links to `sourceUrl`, with the same http/https guard
    RecipeView already uses.
  - **Dismiss** calls `recipeStore.update` with `dismissedAt`.
  - **Retry import**, shown only with a `sourceUrl`, calls `importRecipe({ url,
    translateTo: recipe.lang if it is a supported locale })`. It then opens a
    confirm sheet: "Replace the ingredients and steps with the new import?"
    Confirming replaces title, description, servings, times, sections, steps,
    notes, `lang`, and `importCheck`. It keeps id, createdAt, tags, photos,
    `sourceUrl`, collections, and cook logs. The sheet follows client-state P6.
- **Bulk summary**: the heading changes to
  "{imported} imported · {attention} need attention · {failed} failed". The
  last two counts are buttons that filter the list, and a third button clears
  the filter. Each row gets a warning or error indicator plus the first
  warning's short copy. A failed row shows "Couldn't import this recipe." with
  the reason, and gets its own **Retry** button, which re-runs that URL with a
  fresh fetch into the same batch destination. **Try again** for all failed
  rows stays.

### 2f. Privacy and terms disclosure **[ui]**

`public/privacy.html` and `public/terms.html` are English-only static pages.
i18n P9 keeps legal text out of machine translation, so this is not a catalog
change.
- Add one sentence where the pages already describe import. It says that each
  import is logged with the account id, the page address without its query
  string, and the outcome, so failures can be diagnosed, and that these logs
  are kept for N days.
- N is 30. Checked 2026-09-30 with `gcloud logging buckets list`: `_Default`
  keeps logs 30 days, and the only sinks are `_Default` and `_Required`, so
  there is no export. Re-check before changing the retention text.
- This ships in the same PR as the log line, never after it.

## Phase 3: Turn on retries (spec §10.3)

- Once phase 2 has been deployed and has some data, set
  `MAX_IMPORT_RETRIES = 2`.
- Before and after the change, run `npm run test:import` and, per
  `evals/AGENTS.md` (it covers retry policy in `recipeImport.ts`),
  `npm run eval:ocr-compare -- --split=all --runs=3` to show the photo path is
  unchanged. Log both in `evals/EXPERIMENTS.md`.

## Measurement (spec §8)

- **Retry efficacy, path, codes, and domain** come from the `event: 'import'`
  log lines, read with a saved Cloud Logging query documented in the plan doc.
- **One account's recent imports**: filter on `jsonPayload.event="import"`
  and `jsonPayload.sub="<sub>"`. Get the sub from `scripts/import-audit.ts`.
  Document the query in the plan doc.
- **Dismissals and edits** come from `scripts/import-check-report.ts` (new,
  owner-run, ADC, read-only). It prints aggregates only: warnings per code,
  dismissed with no `editedAt` (the false-positive proxy), and edited after
  import. It never prints recipe text or user ids.

## Out of scope

- The JSON-LD fast path (§4.1)
- Headless or JS rendering, "jump to recipe" link following (§9.1)
- An LLM judge (§6.4)
- Retrying on advisory warnings (§9.3)
- Photo import
- Extension popup copy (the warning shows on the recipe view instead)
- Any change to `api/import.ts`, `api/chat.ts`, or the Gemini request shape for
  chat

## Critical files

`server/recipeImport.ts`, `server/importChecks.ts` (new),
`server/importRoute.ts`, `server/extensionImport.ts`,
`server/recipeFromExtraction.ts`, `server/store.ts`, `src/lib/types.ts`,
`src/lib/compactRecipe.ts`, `src/lib/recipeStore.ts`, `src/lib/importApi.ts`,
`src/screens/ImportScreen.tsx`, `src/components/ImportPreview.tsx`,
`src/screens/RecipeView.tsx`, `src/i18n/*.ts`,
`docs/i18n-review/screens.json`, `evals/pageFixtures.test.ts`, `AGENTS.md`.

Reuse: `primaryRegion` / `scanTags` / `stripToText` (move them where 2a can
import them, or export them from `recipeImport.ts`), `normalizeImportedRecipe`,
`serverErrorText`, `translatedPreviewDraft`, `SaveToCollectionSheet`'s batch
destination, and the unit vocabulary in `src/lib/units.ts`.

## Verification

- `npm test` and `npm run build`. Build is the only type gate on `server/`.
  `erasableSyntaxOnly` applies: no enums, so codes are a string-literal union.
- **Offline calibration test** (new, in `evals/pageFixtures.test.ts` or beside
  it): run `checkImport`'s source-side checks over every cached page.
  - Every `class: ok` page and every existing site fixture must get **no**
    source warning.
  - Every `class: source` page must produce `INSTRUCTIONS_NOT_ON_PAGE` when
    given an empty-steps extraction.
  - The three golden fixtures, checked against their own goldens, must produce
    no warnings at all. This catches a false positive in grounding or the count
    checks.
- **Live**: `npm run test:import`, with the phase 1 fixtures added to the site
  eval as "warnings expected / not expected" assertions.
- **Browser** (Vite + `dev:api`, signed in at `http://localhost:5173`; dev
  writes to the **real** library, so use throwaway recipes):
  - Import a clean URL: no banner, and the generic message is gone.
  - Import a phase-1 source-failure URL: the preview shows the specific
    warning, and after saving, the recipe view shows the banner.
  - Dismiss, then reload: the banner stays hidden.
  - Retry import → confirm → content replaced, photos and tags kept.
  - Bulk-import a mix: the summary counts, the filters, per-row Retry.
  - A shared viewer sees no banner.
  - Check the Library and the `/cooks` journal still render.
- **Before the PR**: run the in-context translation review
  (`docs/i18n-review/README.md`) for the import preview, the recipe banner,
  and the bulk summary in uk, ru, and zh-Hans, and attach the report.
- **After a deploy**: confirm `event: 'import'` lines arrive as `jsonPayload`
  in Cloud Logging for `sous`, project `cooking-assistant-508423`.
