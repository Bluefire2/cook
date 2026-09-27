# Handwritten evals: dev/holdout split, hill-climbing rules, one photo retry

Make the handwritten photo evals able to tell a real improvement from tuning
on the cards being measured. Then add one content-independent robustness
change to the photo path: a runaway-unit check, plus a single retry when an
extraction has already failed. Also add a thinking-level switch to
`evals/ocrCompare.ts` so the owner can run that experiment. The production
thinking level does not change.

**Binding:** `docs/constitutions/image-import.md` and `AGENTS.md`. Step 4
breaks principle 1 as written ("makes **one** Gemini call"), so it amends the
constitution in the same change (see Constitution impact). Nothing else here
may contradict the constitution. If an implementer has to deviate, amend it
under "How to change this document" in the same change, or stop and ask.

Checked against branch `cursor/image-import-38e9` at `0b7d79e` ("Revert the
recipe-card shorthand line in the photo prompt"). `@google/genai` is 1.52.0
(`node_modules/@google/genai/dist/genai.d.ts`).

## Why this exists

Live runs of `evals/ocrCompare.ts` on the 10 fixtures in
`evals/import-handwritten/` showed `sweet-sour-pork` failing repeatably:

- In 1 of 3 runs Gemini finished with `MAX_TOKENS` at 3,490 output tokens.
  The reply was cut-off JSON, so the outcome was `parse_error`, which was
  correctly rejected.
- In 2 of 3 runs it finished with `STOP` but produced a tiny recipe
  (1 ingredient, 0 steps, about 115–160 output tokens), and the pipeline
  accepted it as `ok`.
- An earlier run wrote reasoning into a unit field:
  `lb combat/lb weight (#) converted to lb/lb format -> lb (1.5 lb)`
  (64 characters).

An agent then added a prompt line about recipe-card shorthand (`#` means lb,
and so on) to fix that one card (`58d193a`). The owner pointed out that this
is hill-climbing on the eval: the change was tuned on the same card it was
then measured on. It was reverted in `0b7d79e`. The measured A/B already
recorded in constitution P2 is photos-to-Gemini 6/9 against
Vision-OCR-then-Gemini 3/9.

## Goal

1. The 10 handwritten fixtures live in `evals/import-handwritten/dev/` (5) or
   `evals/import-handwritten/holdout/` (5). The harness cannot silently pick
   up a fixture outside a split. Holdout failures report only which check
   failed and the numbers, never the extracted recipe or the judge's reasons.
2. `evals/AGENTS.md` states the rules for changing the photo prompt, model
   settings, output checks, retry policy, or goldens. Every experiment is
   recorded in `evals/EXPERIMENTS.md`.
3. `importFromImages` rejects a recipe with a runaway ingredient unit as
   `unusable`. On `parse_error` or `unusable` it makes exactly one more,
   identical call and returns that second outcome. Text, HTML, and extension
   import are unchanged.
4. `ocrCompare` accepts `--split=dev|holdout|all` and `--thinking=<level>`,
   and has a `calls` column, so retries and thinking-level experiments are
   visible.

## Non-goals

- **Changing the photo prompt.** The reverted shorthand line stays reverted.
  Any future prompt change follows `evals/AGENTS.md`.
- **Changing production model settings.** That covers the thinking level,
  `maxOutputTokens` (4096), temperature, the model, and `mediaResolution`.
  `--thinking` exists only in `ocrCompare`. A later change can adopt a level
  if it is measured across both splits.
- **Detecting a short but clean recipe** (the 2 `STOP` runs with 1 ingredient
  and 0 steps). Without reading the card, that cannot be told apart from a
  genuinely short recipe: `broccoli-salad` has no steps, and P5 forbids
  inventing them. Those runs remain eval failures, and P4's review is the
  safety net. The unit check targets only the reasoning-in-a-field failure,
  and it does so by length, not by content.
- **Retrying or checking units on text, HTML, or extension import.** Nothing
  has been observed failing there, and changing it would need its own
  evidence. `importFromSource`, `importFromHtml`, and `outcomeFromModelText`
  keep their behaviour.
- **New `ImportOutcome` kinds, a new route, a retry log line, or any change to
  `server/importRoute.ts`** (P3, P7).
- **Editing goldens or fixture bytes.** Fixtures are moved with `git mv`, and
  the content is byte-identical.
- **A second judge, per-field scoring, or statistics beyond pass counts.**

## Decisions (settled — do not reopen while implementing)

- **Split assignment, fixed:**

  | Split | Fixtures | Why |
  | --- | --- | --- |
  | `dev` | `blueberry-muffins`, `choc-pie-tea-towel`, `hundred-good-cookies`, `lemon-tea-bread`, `sweet-sour-pork` | Already inspected, debugged, or golden-adjusted (`803f29c`, `58d193a`). |
  | `holdout` | `broccoli-salad`, `peanut-butter-cookies`, `potatoe-pancakes-platter`, `split-pea-soup`, `taffy-apple-salad` | Not used for debugging or prompt tuning (the taffy golden was reconciled in `f6f7b72` against an independent transcription, not against model output). |

  New fixtures, including the owner's own cards when they arrive, go into
  `holdout/` by default. A fixture may move from holdout to dev, for example
  after the owner asks an agent to debug it, but never from dev to holdout:
  once a card has been looked at, it cannot become unseen. Record every move
  in `evals/EXPERIMENTS.md`.
- **Split layout is enforced, not conventional.** Every non-dot directory
  directly under `evals/import-handwritten/` must be `dev` or `holdout`.
  Anything else throws. Files at that level are still ignored, as today. The
  same fixture name in both splits throws. A missing split directory yields
  `[]`.
- **Holdout redaction** (both the vitest suite and `ocrCompare`). A holdout
  failure may show the fixture name, the split, which check failed
  (outcome kind, servings, ingredient count, step count, judge), numbers
  (counts, deltas, token counts, latency, the judge's failure count), and the
  finish reason. It never shows the extracted recipe, the judge's `field` or
  `reason` strings, or the message of an error thrown by the import or the
  judge. Error messages are hidden because a `JSON.parse` `SyntaxError`
  message quotes the start of the text it failed on. Dev keeps today's full
  detail.
- **Experiments are logged in a new `evals/EXPERIMENTS.md`, not in
  `evals/README.md`.** The README is about fixture provenance, licences,
  layout, and how to run things; it has to stay short and stable. An
  append-only log (newest first) gives agents one file to read before they
  propose a change and one file to update after measuring, and a reviewer
  can see "experiment recorded" as a diff to one file. The log records
  aggregate numbers only: dev per fixture, holdout as a pass count.
  Transcriptions and judge reasons stay out of it, because the notes are
  personal data (P10) and holdout detail would leak.
- **Acceptance rule for an experiment.** The same command runs at the parent
  commit (before) and at the change (after), with the same model and flags:
  `npm run eval:ocr-compare -- --split=all --runs=3` (or more runs).
  - A **holdout** A-approach pass count below the before count fails the
    change. A tie passes.
  - A **dev** A-approach pass count below the before count fails the change.
    Per-fixture movement within dev is allowed if the total is not lower.
  - Do not re-run to get a better number. If a run is repeated (for example
    after a network error), record every run and use the sums.
- **Runaway-unit threshold: `MAX_PHOTO_UNIT_CHARS = 32`, measured on the
  normalized (trimmed) unit with `String.length`.**
  - The units `RECIPE_SCHEMA` lists are at most 5 characters (`piece`). The
    longest unit in the dev, text, and cached-page goldens is 7 (`package`,
    dev `hundred-good-cookies`; `packet` in `beef-stew` is 6). Holdout goldens
    were deliberately not surveyed (`evals/AGENTS.md`).
    Common real units are `square` (6), `fl oz` (5), `tablespoons` (11),
    `fluid ounces` (12), and the longest plausible ones are
    `heaping tablespoons` (19) and `rounded tablespoonfuls` (22). Models
    also put package sizes in the unit: `cans (14.5 ounces each)` is 23 and
    `packages (10 ounces each)` is 25, so 32 leaves room for those.
  - The observed runaway unit is 64 characters.
  - A false positive costs a whole import: after the retry, the person gets a
    502. A false negative costs nothing new: that output was accepted before
    this change. So the threshold sits above every real unit, with headroom,
    and still well below the failure. It is length only, so it encodes no
    card's content.
  - It is a constitution number (it goes into P1's text, and rule 4 applies),
    locked by a unit test. It does **not** go in P6: P6 caps *input*, and
    this is a check on model *output*.
- **The unit check is a rejection, not cleanup.** It never modifies a recipe.
  `normalizeImportedRecipe` remains the only cleanup of model output
  (AGENTS.md) and is not edited. The check runs after
  `outcomeFromModelText`, on the photo path only, in a private
  `photoOutcome(text)` that wraps the shared helper.
- **Retry shape.**
  - `importFromImages` builds its `GenerateContentParameters` object once. If
    the first outcome (after the unit check) is `parse_error` or `unusable`,
    it passes the same object to `generateContent` a second time and returns
    the second outcome, whatever it is.
  - Nothing else triggers a retry: not `ok`, `not_a_recipe`, `empty_source`
    (which makes no call), or a thrown error.
  - A throw on the second call propagates, so the route returns its existing
    502 `Couldn't read those photos — try again.` and logs its existing
    `import images failed …` line. The throw is not swallowed in favour of
    the first outcome, because both are 502s and propagating keeps
    `importFromImages` free of error handling.
  - Identical calls differ only by sampling (the default temperature is not
    0), which is the point of retrying.
- **No retry logging.** `server/recipeImport.ts` logs nothing, and the route
  still logs exactly one `import images count=<n> bytes=<b>` line per request
  (P3). A retry marker could be a follow-up, but it would need its own P3
  review.
- **Cost of the retry.** It only happens on extractions that had already
  failed. At `ocrCompare`'s estimate constants, a worst-case extra call (4
  pages at about 1,100 prompt tokens each, plus 4,096 output tokens) is about
  $0.044, and the extra wait is one more Gemini round trip (roughly 3–10 s).
  The client has no fetch timeout, and Cloud Run's request timeout is far
  above two calls.
- **`--thinking` is eval-only and A-only.** It accepts `minimal`, `low`,
  `medium`, or `high` (case-insensitive) and maps each to the `ThinkingLevel`
  enum value exported by `@google/genai` (`MINIMAL`, `LOW`, `MEDIUM`,
  `HIGH`). The `recordingDeps` wrapper for approach A sends
  `{ ...params, config: { ...params.config, thinkingConfig: { ...params.config?.thinkingConfig, thinkingLevel } } }`.
  The field is `GenerateContentConfig.thinkingConfig: ThinkingConfig`, with
  `ThinkingConfig.thinkingLevel?: ThinkingLevel`. Do not use the
  Interactions-API `thinking_level` string type (`ThinkingLevel_2`).
  Approach B and the judge are untouched. The SDK serialises this as
  `generationConfig.thinkingConfig.thinkingLevel` in the REST body, which
  was checked with a fake base-URL server. If the model rejects a level, that
  run shows as `gemini_error`. Importing a library enum is fine under
  `erasableSyntaxOnly`.
- **`calls` counts invocations, not successes.** The counter increments
  before `generateContent` is awaited, so a call that throws or times out
  still counts.
- **Sequenced fake.** `test/fakeGemini.ts` gains
  `fakeImportDepsReplies(replies: readonly (string | undefined | Error)[])`.
  Call *n* returns reply *n* as a real `GenerateContentResponse`, an `Error`
  entry rejects with that error, and a call past the end of the list rejects
  with `Error('fakeImportDepsReplies: unexpected call <n>')`, so an extra
  call fails the test. `fakeImportDeps` keeps its behaviour: the same reply
  on every call. Both share a private helper that builds the response.
- **The old plan's "no retries" decision is superseded.** The "One pipeline"
  decision and the P1 checklist line ("exactly one `generateContent` in
  `importFromImages`") in `docs/plans/image-import.md` are superseded by this
  plan. Step 4 adds a one-line pointer there, so a future verifier following
  the old checklist does not reject the retry.
- **Node ≥ 22.18, `erasableSyntaxOnly`.** No declared enums, no constructor
  parameter properties, `import type` for types, and `.ts` extensions on
  relative imports. On this VM, run
  `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"` first.

## Constitution impact

| Principle | Effect | Where |
| --- | --- | --- |
| P1 One pipeline | **Amended.** One retry on `parse_error` / `unusable`, and the runaway-unit check with its number (32). | Step 4 |
| P2 No OCR in request path | Unchanged. `ocrCompare` B stays eval-only. | Steps 1–2 touch only `evals/` |
| P3 Never stored, counts-only logs | Unchanged. It is re-tested: one count line per request, even with a retry. | Step 4 |
| P4 Always reviewed | Unchanged. | — |
| P5 Faithful prompt | Unchanged: the prompt is not edited. `evals/AGENTS.md` makes P5 a precondition for any future prompt addition. | Steps 3, 4 |
| P6 Input caps | Unchanged. The unit threshold is an output check and lives in P1. | — |
| P7 Additive API | Unchanged: no new outcome kinds and no change to `RecipeImportDeps`. | Step 4 |
| P8, P9, P11 | Unchanged. | — |
| P10 Tests match the repo | Copy change: fixtures are in `dev/` and `holdout/`, and the rules are in `evals/AGENTS.md`. Nothing is broken. Evals stay out of `npm test`, CI, and the image. | Steps 1, 3, 4 |

**Scope line (copy change, step 4).** In the constitution's opening
paragraph, replace `` `evals/import-handwritten/`, `evals/ocrCompare.ts`, ``
with `` `evals/import-handwritten/` (`dev/` and `holdout/`), `evals/AGENTS.md`,
`evals/EXPERIMENTS.md`, `evals/ocrCompare.ts`, ``.

**P1, new text (step 4)** replaces the principle's first paragraph. Keep the
existing **Why:** paragraph, and add the second **Why the retry:** paragraph
after it:

> Photos go through `server/recipeImport.ts` like URLs and pasted text do.
> `importFromImages` makes one Gemini call with the photos as `inlineData`
> parts and the shared `RECIPE_SCHEMA`. Its response goes through the same
> helper as `importFromSource`: JSON parse, the `NOT_A_RECIPE` check, then
> `normalizeImportedRecipe`. On the photo path only, a recipe with any
> ingredient `unit` longer than 32 characters (`MAX_PHOTO_UNIT_CHARS`, after
> trimming) is then treated as `unusable`. If that outcome is `parse_error`
> or `unusable`, `importFromImages` makes exactly one more, identical call
> and returns its outcome, whatever it is. It does not retry `ok`,
> `not_a_recipe`, `empty_source`, or a thrown error. It returns the existing
> `ImportOutcome` kinds.
>
> **Why the retry:** a photo extraction can fail in ways that a second
> sample of the same call usually avoids: the model runs out of output tokens
> and returns cut-off JSON, or it writes its reasoning into a field. Both were
> already failures the person saw as a 502. So a retry costs at most one
> extra call, only on imports that had already failed, and adds one more wait
> on those. It is one retry, not a loop, so cost and latency stay bounded.
> The unit check looks only at length, never at what a unit says, so it
> encodes no particular card. A short but clean recipe is not detected: it
> cannot be told apart from a genuinely short one without reading the card,
> and principle 4's review is the safety net.

**P10 (copy change, step 4).** After "Live evals (`evals/import-handwritten/`,
`evals/ocrCompare.ts`) stay out of `npm test`, CI, and the runtime image.",
insert: "Handwritten fixtures are split into `dev/` and `holdout/`. Changes to
the photo prompt, model settings, output checks, retry policy, or goldens
follow `evals/AGENTS.md` and are logged in `evals/EXPERIMENTS.md`."

**Amendments entry (step 4).** Replace "None yet." with this entry. Keep the
"Add entries newest first…" sentence above it.

> - **2026-09-27, principle 1.** *Was:* `importFromImages` makes one Gemini
>   call, with no retries. *Now:* one call, plus exactly one identical retry
>   when the outcome is `parse_error` or `unusable`; on the photo path, an
>   ingredient unit longer than 32 characters makes the outcome `unusable`.
>   *Why it is worth it:* the one-call rule protected predictable cost and
>   latency and a single code path. The retry keeps the single path (same
>   request, same helper, same normalizer) and spends at most one extra call,
>   only on extractions that had already failed. *Evidence:*
>   `evals/ocrCompare.ts` on `sweet-sour-pork` (3 runs): one run finished
>   `MAX_TOKENS` at 3,490 output tokens and was `parse_error`. An earlier
>   run wrote reasoning into a unit ("lb combat/lb weight (#) converted to
>   lb/lb format -> lb (1.5 lb)", 64 characters). The before/after
>   measurement across both splits is in `evals/EXPERIMENTS.md`. *PR:*
>   https://github.com/Bluefire2/cook/pull/33.

The PR description must say that principle 1 was amended. The orchestrator
updates PR #33's description (subagents cannot write to the PR).

## Files

Changed:

- `evals/import-handwritten/<name>/` (all 10): moved with `git mv` to
  `dev/<name>/` or `holdout/<name>/`, byte-identical.
- `evals/handwrittenFixtures.ts`: splits, root-layout check, split-aware
  error prefix, and a `split` field.
- `evals/recipeImport.eval.ts`: dev and holdout describes, and holdout
  redaction.
- `evals/ocrCompare.ts`: `--split`, `--thinking`, the `split` and `calls`
  columns, holdout suppression, and a per-split summary.
- `evals/AGENTS.md`: **new**, the directory-scoped agent rules.
- `evals/EXPERIMENTS.md`: **new**, the experiment log.
- `evals/README.md`: pointer to `evals/AGENTS.md`, the split layout, the
  Split column, and the new flags.
- `AGENTS.md`: a one-line pointer in "Tests and verification", a
  plans-table row, and (step 4) the Constitutions-table scope row.
- `server/recipeImport.ts`: `MAX_PHOTO_UNIT_CHARS`, `photoOutcome`, and the
  retry in `importFromImages`.
- `server/recipeImport.test.ts`: retry and unit-check tests.
- `server/importRoute.test.ts`: tests that a retry still produces one log
  line, in both the ok and the throw case.
- `test/fakeGemini.ts`: `fakeImportDepsReplies`.
- `docs/constitutions/image-import.md`: scope line, P1, P10, and the
  Amendments entry.
- `docs/plans/image-import.md`: a one-line superseded note.

Must **not** change: `server/importRoute.ts`, `server/extensionImport.ts`,
`api/`, `extension/`, `scripts/`, `src/`, `evals/judge.ts`, every
`golden.json`, `page-*.jpg`, and `source.txt` (content), `evals/import/`,
`evals/import-sites/`, `vitest.config.ts`, `vitest.eval.config.ts`,
`package.json`, `Dockerfile`, `.github/`, `vercel.json`, and
`src/lib/recipeStore.test.ts`. In `server/recipeImport.ts`, the following
must not change: `RECIPE_SCHEMA`, `RECIPE_OUTPUT_CONFIG`, `imageImportPrompt`,
`normalizeImportedRecipe`, `outcomeFromModelText`, `importFromSource`,
`importFromHtml`, `ImportOutcome`, and `RecipeImportDeps`.

Commit each step on its own, with a descriptive message, and push it before
starting the next. Run `npm test` and `npm run build` before each commit.
The step 3 commit is the owner's **before** baseline for step 4's
measurement (see Verification).

## Steps

### 1. [core] Split the handwritten fixtures into dev and holdout

Principles: P10.

Files: `evals/import-handwritten/**` (moves only), `evals/handwrittenFixtures.ts`,
`evals/recipeImport.eval.ts`, `evals/ocrCompare.ts` (one line, so it still
compiles). This plan file (`docs/plans/image-import-evals-and-retry.md`, not
yet tracked) goes into step 1's commit.

1. Move the fixtures:

   ```bash
   mkdir -p evals/import-handwritten/dev evals/import-handwritten/holdout
   for f in blueberry-muffins choc-pie-tea-towel hundred-good-cookies lemon-tea-bread sweet-sour-pork; do
     git mv "evals/import-handwritten/$f" "evals/import-handwritten/dev/$f"; done
   for f in broccoli-salad peanut-butter-cookies potatoe-pancakes-platter split-pea-soup taffy-apple-salad; do
     git mv "evals/import-handwritten/$f" "evals/import-handwritten/holdout/$f"; done
   ```

2. `evals/handwrittenFixtures.ts`:
   - Export `type HandwrittenSplit = 'dev' | 'holdout'` and
     `const HANDWRITTEN_SPLITS: readonly HandwrittenSplit[] = ['dev', 'holdout']`.
   - `HandwrittenFixture` gains `split: HandwrittenSplit`.
   - The signature becomes
     `listHandwrittenFixtures(split: HandwrittenSplit, root: string = HANDWRITTEN_ROOT): HandwrittenFixture[]`.
     `split` is required, so every caller must choose.
   - Order of work:
     1. A missing `root` gives `[]`.
     2. Root-layout check, on every call, whichever split is asked for. For
        each non-dot **directory** directly under `root` that is not `dev`
        or `holdout`, throw
        `Error('evals/import-handwritten/<name>: not in dev/ or holdout/. Move it with git mv; new fixtures go in holdout/ (see evals/AGENTS.md).')`.
        Files at that level are ignored.
     3. Duplicate check: collect the non-dot directory names in both
        `root/dev` and `root/holdout`. If any name is in both, throw
        `Error('evals/import-handwritten: <name> is in both dev/ and holdout/')`.
     4. A missing `root/<split>` gives `[]`. Otherwise, list and validate its
        fixtures exactly as today (source, pages, EXIF, `checkImportImages`,
        body cap, golden), sorted by name.
   - `fixtureError` takes the split and produces
     `evals/import-handwritten/<split>/<name>: <problem>`.
   - Update the docblock: "fixtures in `evals/import-handwritten/dev/` and
     `holdout/`; a fixture outside a split throws. Rules: `evals/AGENTS.md`."
3. `evals/recipeImport.eval.ts`:
   - Replace `HANDWRITTEN` with `const HANDWRITTEN_DEV = listHandwrittenFixtures('dev')`
     and `const HANDWRITTEN_HOLDOUT = listHandwrittenFixtures('holdout')`, both
     at module scope, so a layout error fails the file on load.
   - `expectCloseToGolden(label, golden, result, options: { redact?: boolean } = {})`.
     With `redact` unset, behaviour is byte-for-byte today's, and the text
     and page suites call it without options. With `redact: true`:
     - outcome message: `` `${label} import outcome` `` (unchanged, because it
       shows only the kind);
     - servings: `expect(extracted.servings === golden.servings, `${label} servings mismatch (holdout: values hidden)`).toBe(true)`,
       so the diff shows no values;
     - ingredient message: `` `${label} ingredient count ${gotIng} vs golden ${goldIng}` ``
       with **no** JSON;
     - step message: `` `${label} step count ${gotSteps} vs golden ${goldSteps}` ``
       with **no** JSON;
     - judge: call `judgeRecipe` inside `try`. On a throw,
       `throw new Error(`${label} judge errored (holdout: message hidden)`)`.
       Otherwise, **outside** that `try` (so an assertion failure is not
       reported as a judge error), use
       `expect(verdict.pass, `${label} judge failed with ${verdict.failures.length} reason(s) (holdout: reasons hidden)`).toBe(true)`.
   - A helper `describeHandwritten(split, fixtures, redact)` produces:
     - with no fixtures:
       `describe(`import from handwritten photos, ${split} split (live Gemini)`, () => { it.skip(`no fixtures in evals/import-handwritten/${split}/ — see evals/README.md`, () => {}); })`;
     - otherwise, the existing `beforeAll` key check and the existing
       `it.each(names)('extracts %s from photos close to the golden recipe', …)`.
       For holdout, the `importFromImages` call is wrapped:
       `catch { throw new Error(`${name} import threw (holdout: message hidden)`) }`.
       Dev is not wrapped.
   - Call it as `describeHandwritten('dev', HANDWRITTEN_DEV, false)` and
     `describeHandwritten('holdout', HANDWRITTEN_HOLDOUT, true)`.
4. `evals/ocrCompare.ts`: change the one call to
   `listHandwrittenFixtures('dev')` (step 2 replaces it). Nothing else
   changes in this step.

**Tests.** None under `npm test`: there are no `*.test.ts` files under
`evals/`, and the harness reads the filesystem. The checks are under
Acceptance.

**Acceptance:**

- `npm test` and `npm run build` pass (`tsconfig.node.json` includes `evals/`).
- `git diff --cached -M --stat HEAD` (before commit) or
  `git show -M --stat HEAD` (after) shows exactly 30 renames
  (10 × `golden.json`, `page-1.jpg`, `source.txt`) and no content change:
  `git show -M --summary HEAD | rg -c "rename .*\(100%\)"` prints `30`.
- `node --input-type=module -e "import { listHandwrittenFixtures as l } from './evals/handwrittenFixtures.ts'; for (const s of ['dev','holdout']) console.log(s, l(s).map(f => f.name + ':' + f.split).join(' '))"`
  prints the dev and holdout lists from Decisions, each tagged with its split.
- These layout probes, which work before step 2's flags exist, produce the
  errors listed under Verification ("Harness discovery"): the missing-root
  `[]` listing; a stray directory directly under `import-handwritten/`
  (through both `node evals/ocrCompare.ts` with `GEMINI_API_KEY=dummy` and
  the vitest eval file); the same fixture name in both splits (fires
  through `'dev'`); and a holdout fixture without `source.txt`, checked with
  `GEMINI_API_KEY=dummy npx vitest run --config vitest.eval.config.ts 2>&1 | rg zz-probe`
  (the eval file lists holdout at module scope). The `--split` and
  `--thinking` probes belong to step 2 and the final Verification.

### 2. [core] `ocrCompare`: `--split`, `--thinking`, `calls`

Principles: P2 (B stays eval-only), P10.

File: `evals/ocrCompare.ts`.

1. `parseArgs` returns `{ names, runs, split, thinking }`.
   - `--split=dev|holdout|all`, default `dev`. Any other value: print
     `--split must be dev, holdout, or all.` and exit 1.
   - `--thinking=<level>`, where the level is `minimal`, `low`, `medium`, or
     `high` (case-insensitive), mapped through
     `const THINKING_LEVELS: Record<string, ThinkingLevel> = { minimal: ThinkingLevel.MINIMAL, low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH }`.
     Validate with `Object.hasOwn(THINKING_LEVELS, key)` (a plain lookup would
     accept prototype keys such as `constructor`).
     `ThinkingLevel` is a value import from `@google/genai`. Any other value:
     print `--thinking must be minimal, low, medium, or high.` and exit 1.
     Absent means `undefined` (the model default).
   - `--runs` is unchanged (1–5).
   - Validate the arguments before the `GEMINI_API_KEY` check, so a typo
     fails without a key.
2. Fixtures: `split === 'all'` uses
   `[...listHandwrittenFixtures('dev'), ...listHandwrittenFixtures('holdout')]`.
   Otherwise use the one split. A throw prints its message and exits 1, as
   today.
   - The name filter applies within the selected fixtures. The miss message
     becomes `No fixture named <name> in split <split>; ignoring it.`
   - The no-fixtures message becomes
     `No handwritten fixtures in evals/import-handwritten/<dev|holdout|{dev,holdout}>/. See evals/README.md to add some.`
     (exit 0).
3. `recordingDeps(base, thinkingLevel?: ThinkingLevel)` returns
   `{ deps, usage, counter }`, where `counter: { calls: number }`. Its
   `generateContent`:
   - increments `counter.calls` first;
   - if `thinkingLevel !== undefined`, sends
     `{ ...params, config: { ...params.config, thinkingConfig: { ...params.config?.thinkingConfig, thinkingLevel } } }`,
     otherwise `params` unchanged;
   - keeps the timeout and usage recording as today.

   `runA` passes the parsed level. `runB` passes nothing, so B never gets a
   thinking config. The judge does not go through `recordingDeps` and is
   untouched.
4. `RunResult` gains `split: HandwrittenSplit` and `calls: number`
   (`counter.calls`; `0` for B's `vision_error`).
5. Output:
   - Header:
     `` `Running ${n} fixture(s) x ${runs} run(s), split ${split}, thinking ${thinking ?? 'model default'} (A only): A${b.auth !== null ? ' and B' : ''}. Each line prints as a run finishes.` ``
   - Per-run line:
     `` `${r.split}/${r.fixture} run ${r.run} ${r.approach}: ${r.kind}, ${ms} ms, calls ${r.calls}, finish ${r.tokens.finish}, judge ${r.judge}` ``
   - `tableRow` adds `split` right after `fixture` and `calls` right after
     `outcome`. All other columns stay the same, including both deltas
     (numbers are allowed for holdout).
   - Judge failures: for `dev` rows, as today, but prefixed with
     `dev/<fixture>`. For `holdout` rows, one line per run:
     `` `  holdout/${r.fixture} run ${r.run} ${r.approach} — judge failed with ${r.judgeFailures.length} reason(s) (hidden: holdout)` ``.
     No `field` or `reason` text is printed for holdout, anywhere.
   - Summary: one row per (split, approach) that has results, with a
     `split` column first. The other columns are as today, and `passes` is
     `x/y` within that split.
6. Update the docblock: the `--split`, `--thinking`, and `calls` usage lines;
   that holdout rows hide judge reasons (see `evals/AGENTS.md`); and that
   `--thinking` is for experiments and does not change production.

**Tests.** None under `npm test`, for the same reason as step 1. The dry runs
are under Verification.

**Acceptance:**

- `npm test` and `npm run build` pass.
- `node evals/ocrCompare.ts --split=nope` and `--thinking=max` each print
  their message and exit 1, even with `GEMINI_API_KEY` unset.
- The fake-server dry runs under Verification pass, covering the thinking
  injection, the `calls` column, and holdout suppression.

### 3. [core] `evals/AGENTS.md`, `evals/EXPERIMENTS.md`, and pointers

Principles: P5 (as a precondition), P10.

Files: `evals/AGENTS.md` (new), `evals/EXPERIMENTS.md` (new),
`evals/README.md`, `AGENTS.md`.

**`evals/AGENTS.md`** must contain these sections. The wording can be
tightened, but every rule must survive:

1. **Scope.** These rules apply to any change to the import prompts
   (`imageImportPrompt`, the `importFromSource` prompt), model settings (the
   model, thinking level, temperature, `maxOutputTokens`, `mediaResolution`),
   output checks or retry policy in `server/recipeImport.ts`, `RECIPE_SCHEMA`
   descriptions, or any `golden.json`. They sit alongside
   `docs/constitutions/image-import.md` and do not replace it.
2. **What the split is for.** `dev/` holds cards that people and agents have
   already looked at, so they may be inspected, debugged, and quoted. A pass
   there shows a change works on cards it was designed around. `holdout/`
   holds cards nobody has used to design a change, so a pass there is the
   only evidence a change generalizes. Once someone designs against a
   holdout card, it becomes a dev card.
3. **Never look at holdout to design a change.** Do not open holdout
   `page-*.jpg` or `golden.json` files, and do not look for holdout
   extractions or judge reasons, in order to decide what to change. The
   harness hides them on purpose: do not add logging, flags, or scripts that
   reveal them. The fixture descriptions in `evals/README.md` are
   provenance, not a to-do list. If the owner asks for a holdout card to be
   debugged, first move it to `dev/` with `git mv` and log the move in
   `EXPERIMENTS.md`. Never move a card from dev to holdout.
4. **A qualifying change needs all three of these:**
   - (a) **A reason that is not specific to one fixture's content.** A
     failure seen on one card may prompt a change, but the change must not
     encode that card's words, symbols, layout, or quirks. Test: would the
     change make sense to someone who has never seen that card? A length
     check on units passes this test; "`#` after a number means pounds",
     written because one card used `#`, does not.
   - (b) **Measurement across all fixtures in both splits, before and
     after**, with `npm run eval:ocr-compare -- --split=all --runs=3` (or
     more runs), using the same model and flags, at the parent commit and at
     the change.
   - (c) **Acceptance:** the holdout A-approach pass count is not lower than
     before, and the dev A-approach total is not lower than before. Ties
     pass. Do not re-run to get a better number; if you repeat a run, record
     every run and use the sums.
5. **Goldens.** Edit a golden only when it misreads the card, meaning it
   records something the card does not say. Never edit a golden to match
   model output, unless the model's reading is what the card actually says;
   in that case, say in the commit message what the card shows and why the
   golden was wrong. Holdout goldens are edited only at the owner's request,
   from the card, not by comparing with model output. A golden edit is an
   experiment and is logged.
6. **Prompt text.** Additions must be domain-general, for example how to
   handle any crossed-out text, not a symbol one card uses. They are also
   bound by constitution P5: never remove the `(?)` markers, the
   tablespoon/teaspoon doubt notes, or the "Never invent" rule, and keep the
   pinned-substring test in `server/recipeImport.test.ts` green.
7. **Record every experiment** in `evals/EXPERIMENTS.md`, newest first,
   including rejected and reverted ones, in the format that file defines.
8. **Worked example: what not to do.** Commit `58d193a` added
   "Recipe cards use shorthand: # after a number means pounds (lb); T, Tbs,
   Tbsp, or Tbls means tablespoon; …" to the photo prompt after
   `sweet-sour-pork` derailed on "1½ #". The owner reverted it in
   `0b7d79e`, for three reasons:
   - It was written from one failing card's content, and was checked on
     that same card, so a pass there proves nothing about other cards.
   - It was not measured across the other fixtures, so a regression
     elsewhere would have gone unnoticed. On another card, `#` can mean
     "number" (`#10 can`).
   - It answered a symptom, reasoning written into a unit, that a
     content-independent check handles without teaching the model any
     card's notation: the unit-length check and retry in
     `docs/plans/image-import-evals-and-retry.md`.

   The allowed path would have been to state a general reason, run
   `--split=all --runs=3` before and after, keep the line only if holdout
   and dev are not worse, check it against P5, and log it.

**`evals/EXPERIMENTS.md`:**

- A short header: its purpose; that `evals/AGENTS.md` defines when an entry
  is required; newest first; aggregate numbers only (dev per fixture,
  holdout as a pass count, never transcriptions or judge reasons, because
  the notes are personal data and holdout must stay unseen); and that the
  `passes` numbers come from the `ocrCompare` summary, approach A.
- The entry template:

  ```
  ## <YYYY-MM-DD> — <short name>
  - Change: <what changed; commit(s)>
  - Reason (not fixture-specific): <…>
  - Command: npm run eval:ocr-compare -- --split=all --runs=<n> [--thinking=…]
  - Before (<sha>): dev <x>/<y>, holdout <x>/<y>; notable finishes/calls: <e.g. MAX_TOKENS 1, calls>1 in 2 runs>
  - After (<sha>): dev <x>/<y>, holdout <x>/<y>; notable finishes/calls: <…>
  - Decision: kept | reverted | pending owner run — <why, per the acceptance rule>
  - Run by: <owner | agent>, model <CHAT_MODEL or default>
  ```

- Seed entries, newest first:
  1. **2026-09-27 — Dev/holdout split.** A fixture move and no behaviour
     change. It lists both splits and says no measurement is needed.
  2. **2026-09-27 — Recipe-card shorthand line in the photo prompt
     (`58d193a`, reverted `0b7d79e`).** Measured only on `sweet-sour-pork`,
     so it is not a valid experiment. The decision is "reverted", with a
     pointer to the worked example in `evals/AGENTS.md`.
  3. **2026-09-27 — Photos to Gemini vs Vision OCR then Gemini (P2).**
     Before the split: 3 cards × 3 runs, A 6/9 and B 3/9, median 3.5 s
     against 5.7 s, mean cost about $0.013 against $0.012. It points to
     constitution P2. It is a copy of numbers already recorded there, not a
     new claim.

**`evals/README.md`:**

- The first line under the title:
  `Agents: read evals/AGENTS.md before changing an import prompt, model setting, output check, retry, or golden.`
- `## evals/import-handwritten/`:
  - the layout block becomes `<split>/<name>/page-1.jpg …`, with
    `<split>` being `dev` or `holdout`, and a sentence saying that a
    directory outside the two splits fails the run, and that new fixtures go
    in `holdout/`;
  - the fixture table gains a **Split** column, with values from Decisions;
  - the error prefix becomes `evals/import-handwritten/<split>/<name>: <problem>`;
  - **Running:** `npm run test:import` has a dev suite and a holdout suite,
    each `1 skipped` when empty, and holdout failures hide the extraction and
    the judge's reasons. For `npm run eval:ocr-compare -- [fixture…] [--runs=N] [--split=dev|holdout|all] [--thinking=minimal|low|medium|high]`,
    `--split` defaults to `dev`, `--thinking` applies to A only and does not
    change production, and the `calls` column shows retries. Experiments are
    logged in `evals/EXPERIMENTS.md`.

**`AGENTS.md`:**

- In "Tests and verification", after the live-evals paragraph, add one line:
  `Before changing an import prompt, model setting, output check, retry, or eval golden, read \`evals/AGENTS.md\` (dev/holdout split, no tuning on holdout, experiments logged in \`evals/EXPERIMENTS.md\`).`
- In the plans table, add a new row after `docs/plans/image-import.md`:
  `| \`docs/plans/image-import-evals-and-retry.md\` | Implementing. Handwritten evals split into dev/holdout with \`evals/AGENTS.md\` rules; photo import rejects runaway units and retries once on parse_error/unusable (constitution P1 amended); \`ocrCompare --thinking\`. |`

**Acceptance:**

- `npm test` and `npm run build` pass.
- `rg -n "evals/AGENTS.md" AGENTS.md evals/README.md` matches in both files.
- `rg -n "58d193a|0b7d79e" evals/AGENTS.md evals/EXPERIMENTS.md` matches in
  both files.
- `rg -n "holdout" evals/README.md` matches the layout, the table, and the
  running text.
- `rg -n "\(\?\)|Never invent" evals/AGENTS.md` matches (the P5 reference).

### 4. [core] Runaway-unit check and one retry in `importFromImages`, with the constitution amendment

Principles: P1 (amended), P3, P5, P7, P10.

Files: `server/recipeImport.ts`, `server/recipeImport.test.ts`,
`server/importRoute.test.ts`, `test/fakeGemini.ts`,
`docs/constitutions/image-import.md`, `docs/plans/image-import.md`,
`evals/EXPERIMENTS.md`, `AGENTS.md` (the Constitutions-table scope row,
required; the plans-row wording only if it needs to change).

1. `server/recipeImport.ts`:
   - `import type { GenerateContentParameters }` from `@google/genai`,
     alongside the existing imports.
   - Add:

     ```ts
     /**
      * A photo import whose ingredient unit is longer than this is `unusable`.
      * Real units reach about 25 (package sizes such as "packages (10 ounces each)");
      * a model that writes its reasoning into the field ran to 64. Constitution principle 1.
      */
     export const MAX_PHOTO_UNIT_CHARS = 32;
     ```

   - Add a private `hasRunawayUnit(recipe: ImportedRecipe): boolean`. It is
     true when any `section.items[i].unit` has `length > MAX_PHOTO_UNIT_CHARS`.
     Units are already trimmed by `normalizeImportedRecipe`.
   - Add a private `photoOutcome(text: string | undefined): ImportOutcome`.
     It computes `outcomeFromModelText(text)`, and if the result is `ok` and
     `hasRunawayUnit(outcome.recipe)`, returns `{ kind: 'unusable' }`.
     Otherwise it returns the outcome unchanged.
   - `importFromImages`, after the unchanged `empty_source` guard:

     ```ts
     const request: GenerateContentParameters = { /* today's model, contents, config — unchanged */ };
     const first = photoOutcome((await deps.ai.models.generateContent(request)).text);
     if (first.kind !== 'parse_error' && first.kind !== 'unusable') return first;
     return photoOutcome((await deps.ai.models.generateContent(request)).text);
     ```

     Its doc comment becomes: "Photos of one recipe, in page order, plus
     optional notes → outcome. One Gemini call, and one identical retry if
     that outcome is `parse_error` or `unusable` (constitution principle 1)."
   - Do not touch anything in the must-not-change list for this file.
2. `test/fakeGemini.ts`: add `fakeImportDepsReplies` as described in
   Decisions. Update the docblock to mention the sequenced variant. The
   observable behaviour of `fakeImportDeps` is unchanged.
3. `docs/constitutions/image-import.md`: the scope line, P1, P10, and the
   Amendments entry, exactly as in Constitution impact, with the PR link
   https://github.com/Bluefire2/cook/pull/33.
   Also update the image-import row of the Constitutions table in root
   `AGENTS.md` so its scope matches the new constitution scope line
   (`evals/import-handwritten/dev/` and `holdout/`, `evals/AGENTS.md`,
   `evals/EXPERIMENTS.md`).
4. `docs/plans/image-import.md`: after the "**One pipeline** (P1)" decision
   bullet, add a sub-bullet:
   `_Superseded 2026-09-27 by \`docs/plans/image-import-evals-and-retry.md\`: one identical retry on \`parse_error\` / \`unusable\`, and a runaway-unit check (constitution P1 amendment). The P1 checklist line below is superseded the same way._`
5. `evals/EXPERIMENTS.md`: add a new top entry,
   **2026-09-27 — Photo import: runaway-unit check (32) and one retry**.
   Fill in the change and the reason (general: truncated JSON and reasoning
   in a field are sampling failures, and the length check reads no content).
   Give the command, and before = the step 3 commit, after = the step 4
   commit (`Photo import: runaway-unit check…`), with SHAs filled in by the
   owner's run in a later commit. Record dev and holdout as `pending owner run`, and
   decision `pending owner run — do not merge until filled in; revert this
   commit (including the P1 amendment) if holdout or dev is worse`.

**Tests**, in `server/recipeImport.test.ts`. Keep the existing tests
unchanged: they still pass, because `fakeImportDeps` repeats its reply. Add
`describe('retry and unit check')` **nested inside** the existing
`describe('importFromImages')` (so `JPEG`, declared in that callback, is in
scope), using `fakeImportDepsReplies` and `MINIMAL`:

- `retries once after a reply that is not JSON, and returns the second outcome`:
  `['Sure!', JSON.stringify(MINIMAL)]` returns `{ kind: 'ok', recipe: MINIMAL }`.
  `calls` has length 2, and `calls[1]` `toEqual`s `calls[0]`.
- `retries once after an unusable reply`:
  `[JSON.stringify({ ...MINIMAL, title: ' ' }), JSON.stringify(MINIMAL)]`
  gives `ok`, with 2 calls.
- `retries once after a runaway unit`: the first reply is `MINIMAL` whose
  only ingredient has `unit: 'lb combat/lb weight (#) converted to lb/lb format -> lb (1.5 lb)'`,
  and the second is `MINIMAL`. The result is `ok` with the second recipe,
  after 2 calls.
- `returns the second outcome without a third call`: `['x', 'y']` gives
  `parse_error`. `[JSON.stringify({ ...MINIMAL, title: ' ' }), 'x']` gives
  `parse_error` (the second outcome, not the first). `['x', JSON.stringify({ ...MINIMAL, title: ' ' })]`
  gives `unusable`. A runaway unit on both attempts gives `unusable`. Every
  case makes exactly 2 calls; a third call would reject through the fake's
  "unexpected call".
- `does not retry an ok reply`: `[JSON.stringify(MINIMAL)]` gives `ok`, with
  1 call.
- `does not retry NOT_A_RECIPE`:
  `[JSON.stringify({ ...MINIMAL, title: 'NOT_A_RECIPE' })]` gives
  `not_a_recipe`, with 1 call.
- `does not retry when the model call throws`: `[new Error('boom')]` makes
  `importFromImages` reject with `boom`, after 1 call.
- `propagates a throw on the retry`: `['x', new Error('boom')]` rejects with
  `boom`, after 2 calls.
- `makes no call with no images`: `importFromImages([], '', deps)` with
  `fakeImportDepsReplies([])` gives `empty_source`, with 0 calls.
- `rejects a unit longer than MAX_PHOTO_UNIT_CHARS`:
  `MAX_PHOTO_UNIT_CHARS === 32` (constitution lock). A unit of
  `'x'.repeat(33)` on both attempts gives `unusable`. `'x'.repeat(32)` gives
  `ok` after 1 call. `'  ' + 'x'.repeat(32) + '  '` gives `ok` after 1 call,
  because the unit is measured after trimming. A 33-character unit in a
  **second** section also triggers the check.
- `keeps ordinary units`: one recipe with an item for each of `tsp`, `tbsp`,
  `cup`, `lb`, `oz`, `g`, `ml`, `piece`, `can`, `square`, `package`,
  `slice`, `stalk` (common real units, not taken from any fixture), `fl oz`,
  `heaping tablespoons`, and `packages (10 ounces each)` gives `ok` after 1
  call, and every unit is kept verbatim.
- `leaves text import without a retry or a unit check`:
  with `const fake = fakeImportDepsReplies(['x'])`,
  `importFromSource('soup', fake.deps)` gives `parse_error` and
  `fake.calls` has length 1. A reply with a 64-character unit gives `ok`
  from `importFromSource`, with the unit intact, after 1 call.
- `sends the same photo request on the retry`: for `['x', JSON.stringify(MINIMAL)]`,
  `calls[1].config?.mediaResolution` is `MediaResolution.MEDIA_RESOLUTION_HIGH`,
  and `calls[1].contents` deep-equals `calls[0].contents`, including the
  `inlineData` parts and the prompt text.

In `server/importRoute.test.ts`, inside `describe('POST /api/import with photos')`
(so its `afterEach(vi.restoreAllMocks)` cleans up the spies). `post()` returns
the `calls` of its own internal fake, not of `options.deps`, so write
`const fake = fakeImportDepsReplies([...])`, pass `deps: fake.deps`, and
assert on `fake.calls`. Give `fakeImportDepsReplies` an explicit return type,
`{ deps: RecipeImportDeps; calls: GenerateContentParameters[] }`:

- `retries a failed photo extraction inside one logged request`: spy on
  `console.log` and `console.error`, and use
  `const fake = fakeImportDepsReplies(['not json', JSON.stringify(RECIPE)])`.
  The response is 200 `{ recipe }`, `fake.calls` has length 2, exactly one
  `console.log` call matches `/^import images count=1 bytes=\d+$/`, and
  `console.error` is not called.
- `reports a throw on the retry as the photo 502`:
  `fakeImportDepsReplies(['not json', new Error('SECRET-UPSTREAM-DETAIL')])`
  gives 502 `Couldn't read those photos — try again.`, with exactly one
  count log and exactly one `console.error`, which matches
  `/^import images failed count=1 bytes=\d+$/`. No logged argument contains
  `SECRET-UPSTREAM-DETAIL`.
- All existing route tests pass unchanged, including every copy string and
  `never logs photo data`.

**Acceptance:**

- `npm test` (including `server/membership.test.ts`) and `npm run build`
  pass.
- `git diff HEAD~1 -- server/importRoute.ts api/ src/ scripts/ evals/judge.ts`
  is empty.
- In `git diff HEAD~1 -- server/recipeImport.ts`, the bodies of
  `imageImportPrompt`, `normalizeImportedRecipe`, `outcomeFromModelText`,
  `importFromSource`, `RECIPE_SCHEMA`, and `RECIPE_OUTPUT_CONFIG`, and the
  `ImportOutcome` and `RecipeImportDeps` declarations, are unchanged.
- `rg -n "generateContent\(" server/recipeImport.ts` shows 3 matches: one in
  `importFromSource` and two in `importFromImages`, both passing `request`.
- `rg -n "console\." server/recipeImport.ts` is empty.
- `rg -n "32 characters" docs/constitutions/image-import.md` matches P1's text, and the
  Amendments section has the 2026-09-27 principle 1 entry.

## Verification (verifier, after all steps)

This is not an implementation step. The verifier runs it against the whole
branch after steps 1–4.

**Environment**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"   # node >= 22.18
node -v
npm test
npm run build
```

Both must pass. Then check the following:

```bash
git diff --stat 0b7d79e...HEAD -- server/importRoute.ts server/extensionImport.ts api/ extension/ scripts/ src/ \
  evals/judge.ts evals/import/ evals/import-sites/ vitest.config.ts vitest.eval.config.ts package.json \
  Dockerfile .github/ vercel.json                                                    # must be empty
git diff -M --summary 0b7d79e...HEAD -- evals/import-handwritten | rg -c "rename .*\(100%\)"   # 30
git diff -M --diff-filter=M --stat 0b7d79e...HEAD -- evals/import-handwritten      # empty: no content change
ls evals/import-handwritten                                                        # dev  holdout
ls evals/import-handwritten/dev evals/import-handwritten/holdout                   # the Decisions assignment
rg --files evals | rg "\.test\.ts$"                                                # empty (P10)
rg -n "\b(vision|Vision|tesseract|documentai)\b|images:annotate" server src api scripts   # empty (P2)
rg -n "console\." server/recipeImport.ts                                           # empty (P3)
git diff 0b7d79e...HEAD -- server/recipeImport.ts                                 # review: no hunk inside imageImportPrompt (P5)
```

**Harness discovery** (local, no key). Delete every probe afterwards and
confirm with `git status --short evals/`, which must be clean.

```bash
node --input-type=module -e "import { listHandwrittenFixtures as l } from './evals/handwrittenFixtures.ts'; for (const s of ['dev','holdout']) console.log(s, l(s).map(f => f.name).join(' ')); console.log(JSON.stringify(l('dev', '/tmp/no-such-root')))"
# dev blueberry-muffins choc-pie-tea-towel hundred-good-cookies lemon-tea-bread sweet-sour-pork
# holdout broccoli-salad peanut-butter-cookies potatoe-pancakes-platter split-pea-soup taffy-apple-salad
# []

mkdir evals/import-handwritten/stray-probe
GEMINI_API_KEY=dummy node evals/ocrCompare.ts; echo "exit $?"
# evals/import-handwritten/stray-probe: not in dev/ or holdout/. Move it with git mv; new fixtures go in holdout/ (see evals/AGENTS.md).
# exit 1
GEMINI_API_KEY=dummy npx vitest run --config vitest.eval.config.ts 2>&1 | rg "stray-probe"   # the same message; the file fails to load
rmdir evals/import-handwritten/stray-probe

cp -r evals/import-handwritten/dev/sweet-sour-pork evals/import-handwritten/holdout/sweet-sour-pork
GEMINI_API_KEY=dummy node evals/ocrCompare.ts --split=holdout; echo "exit $?"
# evals/import-handwritten: sweet-sour-pork is in both dev/ and holdout/
# exit 1
rm -r evals/import-handwritten/holdout/sweet-sour-pork

mkdir evals/import-handwritten/holdout/zz-probe
GEMINI_API_KEY=dummy node evals/ocrCompare.ts --split=holdout; echo "exit $?"
# evals/import-handwritten/holdout/zz-probe: missing source.txt
# exit 1
rmdir evals/import-handwritten/holdout/zz-probe

node evals/ocrCompare.ts --split=nope; echo "exit $?"        # --split must be dev, holdout, or all.  exit 1
node evals/ocrCompare.ts --thinking=max; echo "exit $?"      # --thinking must be minimal, low, medium, or high.  exit 1
```

**Dry runs against a fake Gemini** (local, no key). The SDK honours
`GOOGLE_GEMINI_BASE_URL`, which was checked on this VM. Save this script as
`/tmp/fakegem/server.mjs`. It is a verification tool; do not commit it.

```js
import { createServer } from 'node:http';
// REPLIES: JSON array of import replies, used in order; the last one repeats.
// JUDGE=fail makes the judge fail with a marker reason.
const replies = JSON.parse(process.env.REPLIES ?? '["x"]');
let n = 0;
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const judge = body.includes('You compare a recipe');
    const text = judge
      ? JSON.stringify(process.env.JUDGE === 'fail'
          ? { pass: false, failures: [{ field: 'title', reason: 'SECRET-JUDGE-REASON' }] }
          : { pass: true, failures: [] })
      : replies[Math.min(n++, replies.length - 1)];
    const cfg = JSON.parse(body).generationConfig?.thinkingConfig ?? null;
    console.error(judge ? 'judge' : 'import', 'thinkingConfig=' + JSON.stringify(cfg));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1100, candidatesTokenCount: 50, thoughtsTokenCount: 10 },
    }));
  });
}).listen(8787, '127.0.0.1');
```

Start it in a tmux session (for example `fake-gemini`), with `R` set to a
one-ingredient recipe:
`R='{"title":"SECRET-TITLE-XYZ","servings":1,"ingredientSections":[{"items":[{"item":"flour"}]}],"steps":[{"text":"Mix."}],"tags":[]}'`.
Restart it (by its PID) with new `REPLIES`/`JUDGE` for each case below. Use
`E='GEMINI_API_KEY=dummy GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8787'`.
Approach B skips itself without ADC.

1. **Thinking injection, A only.** Start with `REPLIES="[\"$R\"]"`, then run
   `env $E node evals/ocrCompare.ts sweet-sour-pork --thinking=HIGH`. The
   header contains `split dev, thinking HIGH (A only)`. The fake's log shows
   `import thinkingConfig={"thinkingLevel":"HIGH"}` and
   `judge thinkingConfig=null`. Without `--thinking`, the header says
   `thinking model default` and the import line is `thinkingConfig=null`.
2. **Retry visible as `calls`.** Start with `REPLIES="[\"not json\",\"$R\"]"`,
   then run the same command without `--thinking`. The row for
   `dev/sweet-sour-pork` shows outcome `ok` and `calls 2`. With
   `REPLIES='["not json"]'`, it shows `parse_error` and `calls 2`. With
   `REPLIES="[\"$R\"]"`, it shows `calls 1`.
3. **Holdout suppression in `ocrCompare`.** Start with `REPLIES="[\"$R\"]"`
   and `JUDGE=fail`. Run
   `env $E node evals/ocrCompare.ts --split=holdout 2>&1 | tee /tmp/holdout.txt`:
   `rg -c "SECRET-JUDGE-REASON" /tmp/holdout.txt` prints nothing (0 matches),
   and the output has `judge failed with 1 reason(s) (hidden: holdout)` lines
   and a `holdout` summary row. `--split=dev` shows `SECRET-JUDGE-REASON`.
   `--split=all` has both `dev` and `holdout` summary rows, with reasons only
   on dev rows.
4. **Holdout redaction in vitest.** Use the same fake (`JUDGE=fail`). Make a
   temporary probe whose golden equals the fake reply, so the count checks
   pass and the judge path runs:

   ```bash
   P=evals/import-handwritten/holdout/zz-redaction-probe
   mkdir "$P" && cp evals/import-handwritten/dev/sweet-sour-pork/{page-1.jpg,source.txt} "$P/" && printf '%s' "$R" > "$P/golden.json"
   env $E npx vitest run --config vitest.eval.config.ts -t "zz-redaction-probe" 2>&1 | tee /tmp/vh.txt
   rg -c "SECRET-JUDGE-REASON|SECRET-TITLE-XYZ" /tmp/vh.txt            # no matches
   rg "judge failed with 1 reason\(s\) \(holdout: reasons hidden\)" /tmp/vh.txt   # matches
   mv "$P" evals/import-handwritten/dev/
   env $E npx vitest run --config vitest.eval.config.ts -t "zz-redaction-probe" 2>&1 | rg -c "SECRET-JUDGE-REASON"   # >= 1
   rm -r evals/import-handwritten/dev/zz-redaction-probe
   ```

   Then restart the fake with `REPLIES='["not json"]'` and run
   `-t "holdout split"`. Every holdout fixture fails on `import outcome` with
   `parse_error`, and the output never contains `not json` in a failure
   message. Restart with `REPLIES="[\"$R\"]"` and run `-t "holdout split"`:
   each fixture fails on `servings` or on `ingredient count 1 vs golden <n>`
   (whichever check comes first for that golden), with no JSON, and
   `rg -c SECRET-TITLE-XYZ` finds nothing. `git status --short evals/`
   must be clean afterwards.

Stop the fake server by its PID when done. Leave nothing listening on 8787.

**Live, by the owner** (this VM has no `GEMINI_API_KEY`; never print it):

```bash
# Before: the step 3 commit (harness and rules, no server change)
git checkout <step-3-sha>
npm run eval:ocr-compare -- --split=all --runs=3 | tee /tmp/before.txt
# After: the branch head
git checkout <branch>
npm run eval:ocr-compare -- --split=all --runs=3 | tee /tmp/after.txt
npm run test:import            # text, page, dev, and holdout suites; holdout failures show no content
```

Copy the A-approach `passes` for dev and holdout from both summaries into the
pending `evals/EXPERIMENTS.md` entry, together with notable finishes
(`MAX_TOKENS` count) and runs with `calls` 2. Apply the acceptance rule: keep
the change if holdout and dev are not lower than before; otherwise revert
step 4, including the P1 amendment, and record "reverted". `/tmp/*.txt` holds
dev transcription detail, so do not commit it. The thinking-level experiment
is separate and optional:
`npm run eval:ocr-compare -- --split=all --runs=3 --thinking=<level>` against
the no-flag run at the same commit, logged as its own entry. Adopting a level
in production is a later change under `evals/AGENTS.md`.

There is no browser check. No UI, route, or client code changes, and the
route's statuses and copy are unchanged (the route tests lock them). The
chat streaming oracle does not apply, because `/api/chat` is untouched.

**Constitution checklist.** Reject the change if any of these fails:

- **P1 (amended):** `importFromImages` builds one `request`, calls
  `generateContent(request)` at most twice, and retries only when the first
  `photoOutcome` is `parse_error` or `unusable`. Both attempts go through
  `outcomeFromModelText`, and so through `normalizeImportedRecipe`; there is
  no second normalizer. `MAX_PHOTO_UNIT_CHARS === 32` in code, in the test,
  and in P1's text. The Amendments section has the 2026-09-27 principle 1
  entry, and the PR description says that P1 was amended.
  `docs/plans/image-import.md` carries the superseded note.
- **P2:** no OCR in `server/`, `src/`, `api/`, or `scripts/`. Vision is still
  only in `evals/ocrCompare.ts`, and `--thinking` never touches B.
- **P3:** `server/importRoute.ts` has no diff. The new route tests prove one
  `import images count=` line per request with a retry, and one
  `import images failed` line with nothing read from the error.
- **P4:** no diff in `src/` or `extension/`.
- **P5:** `imageImportPrompt` has no diff, and the pinned-substring test is
  unchanged and green. `evals/AGENTS.md` names P5 as a precondition for
  prompt additions.
- **P6:** no numbers changed. The unit threshold is not in P6.
- **P7:** no diff to `ImportOutcome`, `RecipeImportDeps`, `Recipe`,
  `RecipeDraft`, `src/lib/recipeStore.test.ts`, or the API. `unusable` is
  the existing kind.
- **P8, P9, P11:** no diff in `scripts/server.ts`, `api/import.ts`,
  `public/`, or `README.md`'s key and privacy text.
- **P10:** the unit tests are pure (fake `deps`). There are no `*.test.ts`
  files under `evals/`. `npm test`, CI, `vitest.eval.config.ts`, and the
  Dockerfile are unchanged. The fixtures are renamed with no content change.
  The P10 copy mentions the split and `evals/AGENTS.md`.
- **Hill-climbing rules:** `evals/AGENTS.md` exists with the split,
  holdout, three-part rule, golden, prompt, logging, and worked-example
  sections. `evals/EXPERIMENTS.md` has the seed entries and the pending
  step 4 entry. `AGENTS.md` and `evals/README.md` point to `evals/AGENTS.md`.

## Follow-ups (not this slice)

- The owner fills in the pending `EXPERIMENTS.md` entry before merge (see
  Verification).
- If the tiny-but-clean `STOP` runs persist on `sweet-sour-pork`, the next
  candidates are model settings (the thinking level via `--thinking`, or
  `maxOutputTokens`), each run as an experiment under `evals/AGENTS.md`, not
  as prompt text about that card.
- When the owner's own cards arrive, add them to `holdout/` and log the
  addition.
- After verification, switch this plan's `AGENTS.md` row from "Implementing"
  to "Built … not deployed", as the other import plans do.

## Open questions

None blocking. Two things are recorded as decided, so implementation is not
blocked:

- The fixture descriptions in `evals/README.md` stay for all 10 fixtures,
  including holdout, because they are provenance and were written before any
  tuning. `evals/AGENTS.md` says not to use them as a to-do list. If the owner
  wants holdout descriptions hidden, removing those table cells is a copy
  change.
- Step 4's measurement is done by the owner, because there is no key on the
  VM. The entry is marked "pending owner run — do not merge until filled
  in", which follows the acceptance rule this plan introduces.
