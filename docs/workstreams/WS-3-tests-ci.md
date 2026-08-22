# WS-3 — Test harness + CI

**Branch** `ws-3-tests-ci` · **Wave** 1 · **Depends on** nothing · **Size** M

Read `CONTEXT.md` first.

## Why this exists

The repo has no test runner, no linter, and no CI — there is no `.github/`
directory at all. Nothing runs `tsc -b` on push. The two pieces of logic most
likely to break silently are both pure functions with no coverage:

- `src/lib/quantity.ts` — 31 lines, nine tolerance-based branches, and the thing
  every displayed ingredient quantity passes through when the serving scaler is
  used. A wrong branch here misprints measurements in a recipe someone is
  cooking from.
- `extractRecipeSource` in `api/import.ts:70-98` — parses JSON-LD in several
  shapes (bare object, array, `@graph`, `@type` as string or array), with an
  HTML-stripping fallback. It is the difference between a clean import and
  sending 60k characters of navigation chrome to Claude.

Neither needs a DOM, which is why this workstream stays cheap: no jsdom, no
Testing Library, no component tests.

## What to build

### Vitest

Add Vitest as a dev dependency with a `test` script (and a `test:watch` if you
want one). Configure it in `vitest.config.ts`. Use the `node` environment — none
of the code under test touches the DOM, and adding jsdom would slow every run for
no benefit.

Do **not** enable `globals`. Import `describe` / `it` / `expect` from `vitest`
explicitly; it keeps the existing tsconfigs working untouched, since the only new
thing the type-checker sees is a normal package import.

Colocate tests next to their subjects: `src/lib/quantity.test.ts` and
`api/import.test.ts`. Vitest picks up `**/*.test.ts` by default. Vite only
bundles what is reachable from `index.html`, so test files will not end up in the
production build.

One gotcha: `tsconfig.api.json` does not set `allowImportingTsExtensions`, so in
`api/import.test.ts` import from `'./import'` without the `.ts` extension. Vite
resolves it fine. (`tsconfig.app.json` does allow the extension, so tests under
`src/` can go either way — match whichever style the file's neighbours use.)

Importing `api/import.ts` in a test is safe: `new Anthropic()` is called inside
the request handler, not at module scope, so no API key is needed.

### Export the extractor

`extractRecipeSource` is currently module-private. Add `export` to it. That is the
only change `api/import.ts` needs for testability — do not restructure the file.

### Tests for `quantity.ts`

Cover, at minimum:

- Whole numbers, including zero.
- Every one of the nine unicode fractions at its exact value.
- A fraction combined with a whole number (`1.5` → `1½`).
- The `frac < 0.01` short-circuit, which makes a near-whole number render as the
  whole number.
- The 0.02 tolerance on both sides of a fraction.
- **Ordering sensitivity.** `UNICODE_FRACTIONS` is scanned in ascending order and
  returns the first match within tolerance, not the nearest. `1/3` and `3/8` are
  only 0.0417 apart, so their tolerance windows nearly touch. Pin down the
  behaviour at the boundary between them, so a future reorder of the table breaks
  a test instead of a recipe.
- The two-decimal fallback for values that match nothing.
- The near-integer gap: values a little under a whole number, like `0.99`, miss
  every fraction window and fall through to the decimal fallback. Write the test
  to document what actually happens rather than what you might wish happened.

Where behaviour is merely odd rather than wrong, assert current behaviour and say
so in the test name. These are characterisation tests; their job is to make
change visible, not to relitigate the design.

Negative quantities are not a real input — recipes have no negative amounts — so
do not add tests or guards for them.

### Tests for `extractRecipeSource`

Feed it small hand-written HTML strings. Cover:

- A bare JSON-LD object with `"@type": "Recipe"`.
- A JSON-LD array of nodes where only one is a Recipe.
- A `@graph` wrapper.
- `"@type": ["Recipe", "NewsArticle"]` — the array form.
- A malformed JSON-LD block followed by a valid Recipe block; the malformed one
  must be skipped, not fatal.
- `<script type="application/ld+json">null</script>` — this currently reaches
  `null['@graph']` inside the `try`, so it must be swallowed rather than thrown.
  Worth an explicit test because it is only safe by accident.
- JSON-LD that exists but contains no Recipe, which must fall through to the text
  path.
- No JSON-LD at all: assert that `<script>` and `<style>` **contents** are
  dropped, tags are stripped, `&nbsp;` becomes a space, and runs of whitespace
  collapse to one.

### Two small fixes while you are in `api/import.ts`

Both are one-liners in a file you own, and neither has anywhere better to live.

1. **Add `export const maxDuration = 60;`.** The handler sends up to 60,000
   characters to Claude and awaits a complete non-streaming response
   (`api/import.ts:142`). Vercel's default function timeout on Hobby is 10
   seconds, so slow pages currently fail as a timeout rather than an import
   error. `api/chat.ts` does not need this because it streams.
2. **Cap the JSON-LD return value.** The text path slices to 60,000 characters
   (`api/import.ts:97`) but the JSON-LD path returns `JSON.stringify(node)`
   uncapped (`:83`). A site with an enormous embedded blob sends all of it into
   the prompt. Apply the same cap to both paths.

Add a test for the cap.

### CI

Add `.github/workflows/ci.yml`, triggered on push and pull request. It should
install dependencies against the lockfile, run `tsc -b`, and run the tests. Pin
Node to 22 or newer — `scripts/dev-api-server.ts` documents a 22.18+ floor for
native type stripping, and CI should not run below what the project supports.

CI must not need any secrets. Nothing in this workstream calls Anthropic.

## Files you own

- `package.json`, `package-lock.json`
- `vitest.config.ts` *(new)*
- `src/lib/quantity.test.ts`, `api/import.test.ts` *(new)*
- `.github/workflows/ci.yml` *(new)*
- `api/import.ts`
- `tsconfig.app.json`, `tsconfig.api.json` — only if a test genuinely will not
  type-check without it. Try to need neither.

`src/lib/quantity.ts` is frozen: read it, test it, do not change it. If a test
reveals a bug you believe is real, write the test to document current behaviour
and note the finding in your PR description rather than fixing it — that file is
load-bearing for WS-1's serving scaler and a behaviour change mid-flight would
be invisible to them.

## Acceptance criteria

1. `npm test` runs and passes from a clean `npm install`.
2. `npm run build` still exits 0.
3. Tests fail if you deliberately break a branch in `quantity.ts` — check this,
   don't assume it. Revert afterwards.
4. The CI workflow is valid and would pass on the current tree. Validate the YAML
   rather than eyeballing it.
5. No secrets or network access required to run the suite.

## Out of scope

No ESLint, Prettier, or Biome — formatting is already consistent and a linter
would touch every file in the repo, which breaks the parallel plan. No component
or integration tests, no jsdom, no Playwright. No tests for the Dexie stores
(they would need fake-indexeddb, and WS-1 is actively changing the schema). No
deduplicating `RECIPE_SCHEMA` between the two `api/` files.
