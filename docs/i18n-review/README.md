# In-context translation review

Catalog parity tests prove every key exists in every language. They cannot
show whether the strings work together on a screen. This review looks at the
rendered page.

The procedure is tool-neutral. Any agent or person follows this file.
`screens.json` in this directory is the manifest. Tool wrappers only add
what that tool needs. Cursor agents use
`.cursor/skills/i18n-visual-review/SKILL.md` for capture, judging, and where
to write the report. That skill does not restate this procedure.

## What the review does

For each screen state in the manifest and each language in scope:

1. Render the screen at phone width (390×844) and capture it, together with
   the English version of the same state as reference.
2. Give both screenshots, the language, and the rubric to a vision-capable
   LLM reviewer.
3. Get back pass/fail and a list of issues. Each issue names the visible
   text, the problem, a suggested fix, and severity (`blocker` or `nit`).
4. Fix blockers in the catalogs, then re-review the affected screens.
   Record nits in the report or fix them.

Recipe content (titles, ingredients, steps, notes) is excluded. A recipe in
another language is expected. The reviewer judges only the app's own text.

## Rubric

- **Sense in context.** Labels read as one coherent menu, form, or dialog.
  Each word is the right sense for its control, for example a verb on an
  action button, not a noun.
- **Consistent terms.** The same concept uses the same word everywhere on
  the page, and matches the glossary in the constitution's Current decisions.
- **Grammar across strings.** Case and gender agreement between neighbouring
  strings and with numbers (`uk`, `ru`), and correct plural forms.
- **Register.** Formal or informal address matches the decision recorded in
  the constitution.
- **Nothing left in English.** No untranslated or mixed-language app text.
- **Layout.** No truncation, overflow, clipped buttons, or bad line breaks.
  Russian runs long, and Chinese breaks lines differently.

## When it runs

The review is heavy (a live app, screenshots, and an LLM judge). It runs
once per task, at the end, before the PR, when the implementation is
complete and the PR may be ready to merge. It is a pre-PR check, alongside
the other verification. It does not run after each change or each step, and
it is not part of the iteration loop. There is no lighter variant, including
for rewording-only changes.

If it finds blockers, fix them and re-review the affected screens before
opening the PR. During iteration the only per-change requirement is the
cheap one: every new or changed string is in every catalog.

Two scopes:

- **Task run.** Every screen that shows keys the task added or changed, in
  all three non-English languages (`uk`, `ru`, `zh-Hans`). Required before
  the PR of any task that changed UI text. Capture English as the reference
  image for each of those states. Do not judge English as a translation target.
- **Full run.** Every manifest state in every supported language (`en`,
  `uk`, `ru`, `zh-Hans`). Required before the PR for the i18n plan and for
  any task that adds a supported language. English screenshots are the
  reference for the other three languages. On the English column, judge
  sense in context and layout. The other rubric items apply to `uk`, `ru`,
  and `zh-Hans`.

## App and how to switch language

Both processes must be running, and the browser must be signed in:

- Vite at `http://localhost:5173`
- `dev:api` on port 3001 (Vite proxies `/api`)

On this machine Vite binds IPv6 `[::1]` only. Use `localhost`, not
`127.0.0.1`.

Switch language either way:

- Settings (`/settings`), the language picker under Appearance.
- Set `localStorage` key `cook.locale` to `en`, `uk`, `ru`, or `zh-Hans`,
  then reload.

Capture each manifest state in a real browser session, at 390×844, with
whatever browser tooling you have. Review each screenshot pair against the
rubric, either yourself or with a vision-capable model given the images.

## Screen manifest

`screens.json` is a JSON array. Each object has:

| Field | Meaning |
| --- | --- |
| `id` | Stable name used in the report. |
| `route` | Path from `src/App.tsx`. A query such as `?c=` is included when the state is a named collection. |
| `setup` | Plain language: how to reach the state without writing. |
| `needsData` | `true` when the state depends on library or share data the review must not create. If that data is not already there, mark the state `skipped: needs data`. |

Static pages in `public/*.html` are out of the manifest. Do not add them.

New screens or states are added to `screens.json` in the same change that
introduces them. Entries that are not in the file yet are not part of this
review. Translated-recipe and translate-chip states, and the import
preview's guessed-language line and translate checkbox, are added when
those steps land.

`needsData: true` is not permission to create the missing data. See
Read-only.

## Read-only

Local dev talks to production Firestore, so the review never creates,
edits, or deletes library data: no recipes, collections, chat messages,
cook state, or photos.

- Allowed: navigating, opening sheets and menus, switching language, and
  running an import up to its preview without saving. Extraction calls
  Gemini but writes nothing.
- Not allowed: toggling cook-mode checkmarks, steps, or servings. Cook
  state syncs to Firestore. Cook-mode screenshots use whatever state a
  recipe already has.
- **No writes by default, including the translation cache.** Tapping the
  translate chip writes a cache doc to production, so the translated and
  chip-loading states are captured only when the person who starts the run
  opts in for that run (for example "include translated states"). Even then
  the chip is tapped only on one named recipe, and the report lists the
  cache docs written. Without the opt-in, those states are marked
  "skipped: needs opt-in". The chip's idle and unlabelled states need no
  tap and are always captured.
- A state that can't be reached without writing (for example the empty
  Library, when the account has recipes) is marked "skipped: needs data"
  in the report. It is not faked by creating data.
- Opening `ShareCollectionSheet` is fine. Adding or removing a person is
  not. Both write grants to production.
- **Other members' data.** Screenshots go only to the agent's own model.
  But if the account has incoming shares, or collections shared with
  grantees, some states show another member's data: a shared recipe's
  content, the owner's email in the shared-with-you banner and folder
  label, or grantee emails in `ShareCollectionSheet`. `/admin` signed in as
  an owner shows other people's names and emails in every list. Such a
  state is captured only if the reviewer redacts that data (for example by
  cropping or blurring, or by removing names and emails from extracted page
  text) before it goes to the judging model. Otherwise it is
  marked "skipped: shows another member's data". Prefer a collection with
  no grantees for the sheet ("Nobody else can see this yet."). The report
  lists every state that was skipped or redacted for this reason.

The review never creates a share to reach the viewer states.

## Glossary and register

Catalog text follows the register and glossary in
[Current decisions](../constitutions/i18n.md#current-decisions) of
`docs/constitutions/i18n.md`. Address the person as `uk` "ви", `ru` "вы",
and `zh-Hans` "你". Do not copy the glossary table into this file or into
a report; link that section.

## Report

Write Markdown to `.i18n-review/<date>.md`, where `<date>` is `YYYY-MM-DD`.
That directory is gitignored.

Cursor agents write `/opt/cursor/artifacts/i18n-review/<date>.md` instead,
so the report is uploaded. The Cursor skill covers that path. Do not also
write `.i18n-review/` from a Cursor agent unless you were asked to.

The report contains:

- Scope (`task` or `full`), whether translated states were opted in, and
  the languages judged.
- A pass/fail table, one row per manifest `id` and one column per language
  in scope. Each cell is `pass`, `fail`, or a skip reason (`skipped: needs
  data`, `skipped: needs opt-in`, `skipped: shows another member's data`).
  A redacted capture that was judged is `pass` or `fail`, and the redaction
  is listed in the skipped-or-redacted section.
- Issues, each with the screen id, language, severity (`blocker` or
  `nit`), the visible text, the problem, a suggested fix, and the
  screenshot path.
- What was fixed in the catalogs, and which screens were re-reviewed.
- Every skipped or redacted state, with the reason. Redacted rows name
  what was cropped or blurred.
- Translation cache docs written during the run. `None` when there was no
  opt-in. With opt-in, list every cache doc and the one recipe the chip
  was tapped on.

Attach the report to the PR.
