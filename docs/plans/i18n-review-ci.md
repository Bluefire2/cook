# In-context translation review as a suite and a scheduled workflow

Status: steps 1 (spike) and 2 (capture) done on `claude/i18n-review-ci`;
results below. Steps 3–7 not built.

Constitutions applied: `docs/constitutions/i18n.md`. This plan builds the
"standalone i18n review suite" milestone from `docs/plans/i18n.md` and
**amends principle 16** and the "In-context review delivery" current decision
(see Constitution amendment). The PR flags the amendment. `client-state.md`,
`cook-log.md`, and `image-import.md` were checked against their descriptions:
the suite reads the app and changes no app code, so none applies.

## Goal

Two things, one implementation:

1. **`npm run test:i18n`**: the in-context review from
   `docs/i18n-review/README.md` as a script. It captures each manifest state
   in test mode, in English and the target languages, has a Gemini vision
   judge apply the README's rubric, and writes the report the README
   describes. Agents run it as the pre-PR task review instead of driving a
   browser by hand.
2. **A daily workflow on `main`** that runs the full review and keeps one
   GitHub issue up to date with the open findings, so problems that slip past
   a task review, or come from changes that no task review covered, surface
   on their own.

Test mode (`docs/plans/test-mode.md`) removes the blocker the milestone
named: the review no longer needs a real session or production data, so the
`needsData` states that a read-only run skipped (69 of 90 today) become
reachable from personas.

## Out of scope

- **Opening fix PRs.** The first version files and updates an issue. Fix PRs
  are a later phase with their own conditions (see Later).
- **Running on pull requests.** Fork PRs get no secrets, and a judge call per
  state per language is too slow and costly for every push. Agents run the
  task scope locally before a PR, as principle 16 already requires.
- **Changing the rubric or the manifest's meaning.** The README's rubric is
  used as written. The manifest gains no new kinds of states.
- **States that need stored photos.** Test mode has no photo storage, so
  states that show a saved photo are skipped with a reason (see States).
- **Judging recipe content.** As today, the judge ignores recipe text, which
  is expected in any language.

## Decisions

- **The suite lives in `testing/i18n-review/`, not `scripts/i18n-review/`.**
  The constitution's scope line anticipated `scripts/`, but the Dockerfile
  copies `scripts/` into the production image, and the suite imports
  Playwright, a dev dependency. `testing/` is already excluded from the image
  and may import the test-mode fixtures directly. The constitution's `scope`
  frontmatter is updated with the amendment.
- **Playwright, as a dev dependency.** This is the exception to "no DOM
  testing library" that the milestone anticipated. The suite is a live
  review tool like the import evals, not a unit test, and `npm test` never
  runs it. `AGENTS.md` records the exception. Only Chromium is installed.
- **Captures run against test mode, signed in as personas.** Each state names
  a persona (or signed out). The review signs in through `/__test/sign-in`.
  Writes go to the emulator, so a state may be reached by doing what a
  person would do (pressing Create link, sending a suggestion), and nothing
  reaches production.
- **The app's model calls are replayed, not live.** States behind a
  model-backed route (import, translate, the assistant, Ask, dictation) get
  their responses from recorded fixtures through Playwright `page.route`.
  Captures are then deterministic, cheap, and independent of model drift,
  and the test server needs no Gemini key. `npm run test:i18n -- --record`
  refreshes the recordings with a real key; recordings are committed under
  `testing/i18n-review/responses/` and hold only app output for the fixture
  recipes. Failure states (`import-error-model-failed`, invite 409s, a
  failed disconnect, a failed translation) are mocked responses too, which
  makes states reachable that today depend on luck.
- **Only the judge calls Gemini.** The workflow passes `GEMINI_API_KEY` to
  the judge step, not to the test server.
- **Judge model: `gemini-3.7-flash`.** The spike confirmed it: Flash-Lite
  reported 11 false blockers on 9 clean pairs (collection names and tags as
  "left in English", language names in the picker, a spacing artifact of the
  page text), and its pass/fail is not usable. Structured output,
  temperature 0, default thinking. Calls that answer 429 or 5xx are retried
  three times with backoff (the spike hit one 503).
- **The judge reads the rubric and glossary from their sources.** The rubric
  bullets come from the README's "Rubric" section and the register and
  glossary from the constitution's "Register and glossary" decision, read at
  run time. Nothing is copied, so a change to either reaches the judge on
  the next run.
- **What the judge sees.** For each state and target language: the English
  screenshot as reference, the target screenshot, the target page's visible
  text (`innerText`, so quotes in findings are exact rather than read off
  pixels), the language, the rubric, the register and glossary, and the
  state's `setup` text from the manifest. The prompt also says, because the
  spike showed each was needed:
  - what is user data and never judged: recipe text and tags, collection
    names, people's names and emails, connected app names;
  - that language names in the language picker are in their own language on
    purpose;
  - that layout is judged from the image only, because extracted page text
    loses the spacing between elements;
  - that text using the glossary's term is correct even when the English
    word looks ambiguous.

  The `setup` text matters most: without it the judge read the "Cooks"
  header link as people and flagged the glossary's "Приготування" as wrong;
  with it, 27 judgings of 9 clean pairs reported nothing. It
  returns `{ pass, issues: [{ text, problem, suggestion, severity,
  rubricItem }] }`, `severity` `blocker` or `nit`, `rubricItem` one of the
  six rubric headings. For the English column of a full run it judges only
  sense in context and layout, as the README says.
- **A finding counts only if a second judging agrees.** A pair whose first
  judging reports any issue is judged once more. A text reported both times
  (matched by language and normalized `text`) and called a blocker at least
  once is a confirmed blocker; a text reported only once is listed in the
  report as unconfirmed and never filed. The spike showed the judge often
  agrees on a problem but not its severity (the same noun-for-verb button
  was a blocker in one judging and a nit in the next), so agreement on the
  text, not the severity, is what confirms it. Clean pairs cost one call.
- **Findings are fingerprinted.** `sha256(screenId, lang,
  normalize(text))`, where `normalize` lowercases, trims, and collapses
  whitespace. The fingerprint carries a finding across runs (first seen,
  last seen) and across the accepted list.
- **Accepted findings live in the repo.** `docs/i18n-review/accepted.json`
  lists fingerprints the owner decided not to fix, each with a reason and a
  date. Accepting a finding is a reviewed change. The workflow drops accepted
  findings before filing.
- **Candidate catalog keys.** For each finding the reporter searches the
  target catalog (`src/i18n/<lang>.ts`) for the quoted text and lists the
  keys whose value contains it. It is a hint for the person fixing it, and
  the precondition for any later fix PR.
- **One rolling issue.** Label `i18n-review`, title "In-context translation
  review: open findings". Each run rewrites the body: confirmed blockers in a
  table (screen, language, text, problem, suggestion, candidate keys, first
  seen), nits in a collapsed section, skipped states with reasons, the run's
  commit and a link to its artifacts. It adds a comment only when findings
  appeared or were resolved since the last run. With no open findings the
  issue is closed; a new finding reopens it. Run state (last commit, finding
  first-seen dates) is kept in a hidden JSON comment in the body, so the
  workflow needs no other storage.
- **Daily, skipping unchanged `main`.** `schedule` at 06:00 UTC and
  `workflow_dispatch`. A scheduled run whose `main` commit equals the last
  reviewed commit in the issue state exits early. A dispatch always runs and
  takes optional inputs: state ids and languages, for a partial run.
- **A hard cap on judge calls.** A code constant, `MAX_JUDGE_CALLS` (start
  at 500: a full run judges 90 states × 4 columns, English included, plus a
  re-judging per failing pair, with headroom; set from the spike's numbers). The run stops judging at the cap and the report and
  issue say so. A runaway manifest cannot spend without bound.
- **Reports.** The Markdown report keeps the README's format (scope,
  pass/fail table, issues, skips; "translation cache docs written" becomes
  "none: test mode" since nothing reaches production). Screenshots and the
  report are a workflow artifact kept 30 days; locally they go to
  `.i18n-review/<date>/`, which is gitignored. The repo is public, so the
  issue and the artifacts are public; they show only fixture data.
- **`docs/i18n-review/README.md` becomes a guide to the suite.** The rubric,
  the manifest description, and the report format stay there (the suite
  reads the rubric from it). The manual browser procedure and the read-only
  rules for production move to a short "without the suite" note: a person
  can still review by hand, in test mode. The Cursor skill points at
  `npm run test:i18n`.

## States

`docs/i18n-review/screens.json` stays the source of truth for ids, routes,
and the plain-language `setup`. A new file, `testing/i18n-review/states.ts`,
gives each id a machine-readable entry:

```ts
type StateEntry =
  | {
      persona: PersonaName | 'signedOut';
      path: string | ((ids: typeof FIXTURE_IDS) => string);
      /** Playwright steps after load: open a sheet, type, wait for text. */
      reach?: (page: Page) => Promise<void>;
      /** Route mocks, by name, from testing/i18n-review/mocks.ts. */
      mocks?: MockName[];
    }
  | { skip: SkipReason };

type SkipReason = 'needs stored photos' | 'needs a real Google sign-in';
```

A unit test, `testing/i18n-review/states.test.ts`, fails when a manifest id
has no entry or an entry has no manifest id, so a new state cannot be added
to the manifest without a way to capture it (or a named reason not to).

`needsData` keeps its meaning for a hand review against a real account. In
the suite every state is either captured or skipped with one of the reasons
above. From the current manifest, by first reading:

- **Reachable from a persona with no writes:** library states (`member`,
  `empty`), collections, settings, admin, recipe view and edit, cook log,
  public collection pages (`member`'s Weeknights link), shared viewer and
  editor states (`viewer`).
- **Reachable with an emulator write:** invite copied (Create link), feature
  request sent, cook-log save, translated recipe (translate chip, with the
  translate response mocked).
- **Reachable with a mocked response:** every import preview and failure
  state, the assistant's cards, Ask, the invite quota refusal, a failed
  disconnect, a failed translation, clipboard failure (Playwright denies the
  clipboard permission).
- **Skipped, needs stored photos:** recipe gallery and photo-bearing chat or
  cook-log states; step 5 lists them by id. Photo *import* is not skipped:
  attaching a photo to an import is client-side until extraction, which is
  mocked.

The exact split is settled in step 5, and the report lists every skip.

## Files

| File | What |
| --- | --- |
| `testing/i18n-review/spike.ts` | Step 1's script. Its capture half is replaced by `capture.ts`; it is deleted when step 3's `judge.ts` replaces its judge half. |
| `testing/i18n-review/catalog.ts` | The four catalogs and `label(lang, key, params)`, for finding controls by their label. |
| `testing/i18n-review/run.ts` | Entry point for `npm run test:i18n`: options, test-mode readiness, capture, judge, report. |
| `testing/i18n-review/capture.ts` | Playwright: one browser, a context per persona, 390×844, `cook.locale` per language, screenshot plus `innerText`. |
| `testing/i18n-review/states.ts` | The per-id entries above. |
| `testing/i18n-review/states.test.ts` | Manifest ↔ entries parity; every mock name exists. |
| `testing/i18n-review/mocks.ts` | Named `page.route` handlers that serve recordings or failures. |
| `testing/i18n-review/responses/` | Recorded model responses (JSON / NDJSON). |
| `testing/i18n-review/judge.ts` | Builds the prompt from the README and constitution, calls Gemini with the schema, confirms blockers, enforces `MAX_JUDGE_CALLS`. |
| `testing/i18n-review/calibration.ts` | Live judge check: injected defects per rubric item, recall and false positives (step 3). |
| `testing/i18n-review/judge.test.ts` | Pure: prompt assembly reads the right sections, schema parsing, blocker confirmation, fingerprints. |
| `testing/i18n-review/report.ts` | Markdown report, `results.json`, candidate catalog keys. |
| `testing/i18n-review/issue.ts` | Builds the issue body and the change comment from `results.json`, the previous state, and `accepted.json`. Pure; the workflow posts with `gh`. |
| `testing/i18n-review/issue.test.ts` | New, still open, resolved, accepted, reopen, unchanged-run cases. |
| `docs/i18n-review/accepted.json` | `[]` to start. |
| `.github/workflows/i18n-review.yml` | The scheduled workflow. |
| `package.json` | `test:i18n` script; `playwright` dev dependency. |
| `docs/i18n-review/README.md`, `.cursor/skills/i18n-visual-review/SKILL.md`, `AGENTS.md`, `docs/constitutions/i18n.md` | Docs and the amendment (step 7). |

## Workflow

```yaml
on:
  schedule: [{ cron: '0 6 * * *' }]
  workflow_dispatch:
    inputs:
      states: { description: 'Comma-separated state ids (default: all)', required: false }
      langs: { description: 'Comma-separated languages (default: uk,ru,zh-Hans)', required: false }
permissions:
  contents: read
  issues: write
concurrency: { group: i18n-review, cancel-in-progress: false }
```

One job on `ubuntu-latest`, `timeout-minutes: 60`: checkout `main`; read the
issue state and exit early on an unchanged scheduled run; start the emulator
(the `test-mode` job's command); `npm ci`; `npm run build`; install Chromium
(`npx playwright install --with-deps chromium`); start
`testing/test-server.ts --static`; run `npm run test:i18n -- --full
--out review/` with `GEMINI_API_KEY` from secrets on that step only; upload
`review/` as an artifact; run `node testing/i18n-review/issue.ts` to build
the body and comment; apply them with `gh issue` (create the label and issue
on the first run). The workflow never pushes, never opens a PR, and runs
only on `main`.

## Constitution amendment

In `docs/constitutions/i18n.md`, principle 16:

- **"The review writes nothing"** becomes **"The review never touches
  production."** It runs in test mode, against the Firestore emulator,
  signed in as fake personas. Writes during a review go to the emulator only.
  A hand review against a real account, where test mode cannot be used,
  keeps today's read-only rules.
- **"Other members' data stays out of the judge"** becomes: the judge sees
  only fixture data. A hand review against a real account keeps today's
  redaction rule.
- **New bullet: scheduled full run.** A daily full review on `main` files
  open findings to one issue. It is a backstop and does not replace the task
  review before each PR.
- **Tool-neutral** stays: `npm run test:i18n` is the procedure; the README
  describes it.

The "In-context review delivery" decision is rewritten to say the suite
exists, where it lives, and why (`testing/`, out of the image). The `scope`
frontmatter replaces "later scripts/i18n-review/" with
`testing/i18n-review/` and `.github/workflows/i18n-review.yml`. An amendment
log entry gives the reason: test mode makes the review reachable without
production, which removes the reason for the read-only rule.

## Steps

1. **[core] Spike.** Add Playwright, sign in through `/__test/sign-in`,
   capture three states (`settings`, `library-populated`, `import-preview`
   with a mocked response) in all four languages, and judge each target
   language with Flash and Flash-Lite. Record here: capture time per state,
   tokens and time per judge call, which model, and whether the judge's
   quotes match the page text. Stop and revise the plan if capture of a
   state is not deterministic across two runs.
   **Results (2026-10-02, `testing/i18n-review/spike.ts`, Chromium 153 via
   Playwright 1.63, `gemini-3.7-flash` unless noted):**
   - **Captures are deterministic.** All 12 state × language captures were
     byte-identical across two runs (full-page PNG, 390×844 at device scale
     2, animations off, caret hidden, after `document.fonts.ready`). About
     1 s each with a fresh browser per capture; the first launch took 10 s.
   - **Selecting controls by catalog text works.** The script imports
     `src/i18n/<lang>.ts` and finds controls by their label in the current
     language (`getByRole('button', { name: <lang>['import.extractRecipe'] })`);
     the app has no test ids and needs none.
   - **Flash-Lite is not usable as the judge** (see Decisions). Flash, with
     the prompt as first written, reported one false blocker on 9 clean
     pairs ("Cooks" read as people).
   - **With the revised prompt** (user data named, picker languages, layout
     from the image only, glossary first, manifest `setup` text): 27
     judgings of 9 clean pairs reported no issue at all. An English "Save"
     injected into the `uk` import preview was a blocker in 3 of 3
     judgings. A noun on a verb button ("Выбор" for "Выбрать") was missed in
     3 of 3; without the `setup` text it had been reported 2 of 2, once as a
     blocker and once as a nit.
   - **Cost and time per judge call:** 2,800–4,000 input tokens (two images
     and the prompt), 16 output tokens for a clean screen and about 85 with
     one issue, 400–1,200 thinking tokens; 3–10 s, about 4.5 s typical. A
     full run is about 360 calls (90 states × 4 columns) plus re-judgings:
     roughly 1.3 M input and 0.3 M output and thinking tokens, and about
     27 minutes if calls run one at a time, so the judge runs 4 calls at a
     time. One 503 in about 100 calls; retries are needed.
   - **Local setup:** `npx playwright install chromium` timed out on the
     owner's machine although `curl` fetched the same files in seconds.
     Serving the files from a local mirror with `PLAYWRIGHT_DOWNLOAD_HOST`
     worked; `testing/README.md` gets that workaround in step 7. CI installs
     normally.
2. **[core] Capture.** `run.ts`, `capture.ts`, `mocks.ts`, the `--record`
   mode, and `states.ts` for the states that need no mocks (about 30). Check:
   two runs give byte-identical screenshots for each captured state, or the
   difference is understood and stabilized (fonts, animations, relative
   times, the caret).

   **Results (2026-10-03):** 48 of the 90 manifest states are scripted
   (every one that needs no new mock and no write, plus `import-preview` and
   `save-to-collection-sheet` on one clean-import mock); the other 42 are
   `{ skip: 'not scripted yet' }` until step 5, and `states.test.ts` already
   holds every manifest id. `npm run test:i18n -- --repeat 2` captured all
   48 × 4 languages twice: 192 of 192 byte-identical, 384 captures in 7 min
   20 s. What it took:
   - **A frozen browser clock.** `/__test/personas` now returns `seededAt`
     (the time the fixtures are relative to), and captures fix the browser
     clock at `seededAt` + 10 minutes, so `/admin`'s "requested 10 minutes
     ago" reads the same whenever the run happens. After `dev:test --keep`
     there is no `seededAt`, and the run says relative times are live.
   - **Network idle is best-effort, capped at 10 s.** The public page does
     not read a 404's body, so Chromium keeps that request open and network
     idle never comes (`public-link-missing` takes the full 10 s per
     capture). Each `reach` waits for the element it needs instead, and
     `--repeat 2` catches a capture taken too early.
   - **A forced click on the locked chat bubble.** It is `aria-disabled` on
     purpose and still opens the sign-in sheet; Playwright treats
     `aria-disabled` as not clickable.
   - **Labels with hints.** A checkbox whose label also holds its hint (bulk
     import) matches its catalog label as a prefix, not exactly.
   - Service workers are blocked and the time zone is UTC in every context.

   One capture varies between seeds, not within one: the public-link pane
   shows the link's random token. Findings are fingerprinted by text, so
   this does not churn the issue.

   **Deviation:** `--record` moves to step 5, the first step with a state
   whose response is worth recording from a real model call. Step 2 has the
   mock mechanism (`MOCKS`, `entry.mocks`) and one hand-written mock.
3. **[core] Judge.** `judge.ts` and its tests, and a **calibration set**:
   `testing/i18n-review/calibration.ts` injects one known defect per rubric
   item into captured pages (English left in place, a noun on a verb
   button, a wrong `uk`/`ru` plural, a non-glossary term, the wrong
   register, a truncated button) the way the spike did, and reports recall
   per rubric item and false positives on the clean pairs. It is a live
   check like `npm run test:import`, never in `npm test`, and any change to
   the judge prompt or model is measured with it and recorded here. Check:
   no confirmed blocker on the clean pairs; every "left in English" defect
   caught; recall on the other items recorded, not required;
   `MAX_JUDGE_CALLS` stops the run with a clear line.
4. **[core] Report.** `report.ts`: the README's report, `results.json`, and
   candidate keys. Check: the broken string from step 3 lists its key.
5. **[core] All states.** The remaining entries, the recordings, and
   `states.test.ts`. List the skipped ids and reasons in this plan. Check:
   a full local run completes and every manifest id is captured or skipped
   with a reason.
6. **[core] Workflow and issue.** `issue.ts` and its tests, `accepted.json`,
   and the workflow. `issue.ts --dry-run` prints the body and comment instead
   of posting. Check before merge: `issue.test.ts` covers first run, new,
   still open, resolved (closes), accepted (dropped), reopen, and unchanged
   commit (exits early); a dry run over two real `results.json` files, one
   with a deliberately broken string, prints a "new" comment and then a
   "resolved" one. `workflow_dispatch` only works once the file is on
   `main`, so the live check is after merge: one dispatched run creates the
   label and the issue, and the next scheduled run on an unchanged `main`
   exits early. Record both runs here.
7. **[core] Docs and amendment.** The constitution amendment; the README
   rewrite; the Cursor skill; `AGENTS.md` (the Playwright exception in Tests
   and verification, the UI text rule's "run the in-context translation
   review" pointing at `npm run test:i18n`, the plan table row); a short
   section in `testing/README.md` on reviewing a state by hand in test mode.

## Risks

- **Weak recall on subtle problems.** In the spike the judge caught an
  English word left on a button every time, but missed a noun on a verb
  button in all three judgings once it had the manifest context (it had
  caught it, as a blocker or a nit, without). The daily run is a backstop for
  clear errors, not a replacement for a person or agent reading the screen;
  the task review before a PR keeps its role. The calibration set (step 3)
  measures recall per rubric item so this stays known, not assumed.
- **Judge noise.** An LLM judge can disagree with itself. The confirmation
  run, the fingerprint, and the accepted list limit churn, and nits are
  never filed as blockers. If noise still dominates the issue after a week,
  raise the bar (blockers only in the issue body) before tuning prompts.
- **Wrong fixes from the issue.** The owner may not read `uk`, `ru`, or
  `zh-Hans`, and the judge can be wrong. The issue says that a suggestion is
  the model's, and a fix goes through the normal review, including a task
  review of the screen.
- **Recordings drift from the app.** If a route's response shape changes,
  a recording can show a state the real app no longer reaches. Mocks are
  typed against the route's response types where they exist, and a mocked
  state that renders an error instead of its expected text fails capture
  (each `reach` waits for a known element).
- **Cost.** Bounded by `MAX_JUDGE_CALLS` and by skipping unchanged `main`.
  The spike records the per-call cost so the cap means a known amount.
- **Scheduled workflows on a public repository stop after 60 days without
  repository activity.** Ordinary development keeps it alive; a dormant
  period needs one manual dispatch.

## Owner steps

1. Add the `GEMINI_API_KEY` Actions secret (Settings → Secrets and
   variables → Actions → New repository secret, or `gh secret set
   GEMINI_API_KEY --repo Bluefire2/sous`). Use a new key made for the review,
   not production's, so it can be revoked alone and its usage reads
   separately. A Cloud Billing budget on its project only alerts; it does not
   stop spending. The limits are `MAX_JUDGE_CALLS` and the unchanged-`main`
   skip, plus, if wanted, a lower request quota for the Gemini API on that
   project.
2. Approve the constitution amendment in the PR.
3. After the first scheduled run, read the issue and add any findings you
   reject to `docs/i18n-review/accepted.json` with a reason.

## Later

**Fix PRs.** A workflow job could open a draft PR for confirmed blockers
whose text maps to exactly one catalog key, with the judge's suggestion
applied, and re-review the affected screens in the same job before opening
it. Before building it: PRs opened with the workflow's `GITHUB_TOKEN` do not
trigger `ci.yml`, so it needs a GitHub App or a fine-grained token; and the
person merging must be able to judge the language, or the PR is the model
grading itself.

## Verification

- `npm run build` and `npm test` pass, including `states.test.ts`,
  `judge.test.ts`, and `issue.test.ts`. `npm test` does not run captures or
  call Gemini.
- Steps 1–6 checks recorded here with their numbers.
- A full local run and a dispatched workflow run both complete; the issue
  shows the findings, and the artifact holds the report and screenshots.
- The image is unchanged: `testing/` stays in `.dockerignore`, and the
  `image` job passes.
