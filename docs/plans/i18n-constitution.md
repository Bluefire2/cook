# i18n constitution

This file sets the rules for UI language, recipe language labels,
translation, and dictation language in Sous. It records what the design
promises and why, so later changes keep that intent or knowingly change it.

> **Draft location.** This was written before implementation, alongside
> `docs/plans/i18n.md`. Step 1 of that plan moves it to `src/i18n/AGENTS.md`
> and adds a pointer to it in the root `AGENTS.md`. After the move, that copy
> is the only one.

## Scope

It covers any change that touches:

- UI copy, the language setting, or locale formatting (`src/i18n/`,
  `src/lib/settings.ts`, `index.html` boot script)
- `Recipe.lang`, or language detection at import
- translation of recipe text, at import or on the recipe screen
  (`server/translate.ts`, `server/recipeTranslation.ts`, `/api/translate`,
  the translate options on `/api/import`, `src/lib/translationStore.ts`)
- the language passed to dictation (`/api/stt`)
- anywhere recipe text is sent to a translation provider
- the in-context translation review (`.cursor/skills/i18n-visual-review/`,
  and later `scripts/i18n-review/`), and any UI change that adds or changes
  user-facing text (principle 16)

## How to change this file

These principles hold by default. If a change needs to break one, the same
change must:

1. name the principle it breaks,
2. explain why breaking it is worth it, with the concrete user or cost
   problem it solves,
3. rewrite the principle here so it describes the new rule, and
4. add a row to [Amendments](#amendments).

Breaking a principle without doing this is a bug, even if the tests pass.
If a principle below seems wrong, amend it; don't route around it.

## Principles

### 1. The saved recipe text is the source of truth; runtime translation is a view

Translating on the recipe screen never writes recipe text. It produces a
display-only recipe, kept separate from the stored recipe (the screen holds
both, and only the rendered body uses the translation). The client may keep
display translations in memory for the session, so going back or into cook
mode doesn't retranslate. They are gone on reload and never written to the
recipe, sync, or the device (principle 8). Chat, edit, share, and backup
always receive the stored recipe.

**Why.** Sync is last-write-wins on `updatedAt`. If a translation were
written back, it would overwrite the original on every device, lose the
author's wording for good, and retranslating a translation compounds errors.
Keeping the original also makes "Show original" free and exact.

**Import is the one place translation becomes the recipe** (principle 12).
There the person chooses, before saving, which text becomes the recipe. That
is authoring, not a view.

### 2. Translation happens only when a person asks

Nothing translates the library in the background, ahead of time, or on a
schedule. Translation runs only when the recipe screen's toggle is tapped, or
when an import runs with its translate option on (checked by default when the
recipe's language differs from the UI language, and visible before anything
is saved). The backfill script (principle 6) only detects language; it never
translates.

**Why.** Most recipes are never opened in a second language, so translating
ahead of time wastes calls. It also goes stale on every edit and would add a
background job, which this app deliberately avoids (no polling, no workers).

### 3. One translation control per recipe, never per line

The recipe screen has a single toggle (translate / original) on the recipe's
meta line. Ingredient and step rows get no translation controls.

**Why.** Each row is already a full-width tap target: it checks off an
ingredient or advances cook mode. A control inside it would be invalid HTML
(a button inside a button), take width on a phone, and get tapped by mistake
with messy hands. Translating line by line would also cost one round trip per
line and lose the context from nearby lines.

### 4. Translation never changes structure

Only text is translated: title, description, notes, section names,
ingredient `item` and `note`, custom unit strings, and step text. Quantities,
known unit tokens, the order and number of sections, ingredients and steps,
and ids pass through untouched. Translated text maps back to its segment by
id, one to one. A response with missing, extra, or reordered ids is an error.
It is never partly applied.

**Why.** Servings scaling reads `quantity`, and cook-mode checkmarks and the
current step are keyed by position. If structure could change, a translated
view would scale wrong or check the wrong row. Rejecting the whole response
keeps a translated view from silently mixing languages or dropping lines.

### 5. Language tags are standard BCP 47, stored in canonical form

- **Format.** Every stored or transmitted language is a BCP 47 tag. Its
  primary subtag is an ISO 639-1 language code (`uk` Ukrainian, `ru` Russian,
  `zh` Chinese, `it` Italian). It gets an ISO 15924 script subtag only when
  the script changes the meaning (`zh-Hans`, `zh-Hant`).
- **No country codes.** Country codes (ISO 3166) are never used as language
  codes: not `ua`, `cn`, `jp`, `gr`, or `cz`.
- **Normalizing.** Tags are normalized at every boundary:
  - model output, request bodies, backups, and the form
  - canonical case via `Intl.getCanonicalLocales`
  - a small alias map for common country-code mistakes (`ua` becomes `uk`,
    `cn` becomes `zh`)
  - Chinese script taken from the region before the region is stripped:
    `zh-CN` and `zh-SG` become `zh-Hans`; `zh-TW`, `zh-HK` and `zh-MO`
    become `zh-Hant`. An explicit script always wins.
- **Provider codes.** Codes a provider needs (for example `zh-CN`) exist only
  inside that provider's adapter. They are never stored or returned.

**Why.** Mixing `ua`/`uk` or `zh`/`zh-CN`/`zh-Hans` makes the question "does
this recipe need translating?" answer wrong, which shows the toggle when it
shouldn't or hides it when it should.

### 6. `Recipe.lang` is best-effort metadata

Code must behave sensibly when `lang` is missing or wrong:

- **Missing.** Show a neutral translate toggle, and use the language the
  provider detects.
- **Wrong.** The person can correct it in the recipe form.

Nothing may crash or block without it, and no feature may treat it as
guaranteed.

**Why.** Recipes saved before this feature have no label. An installed PWA
still running old code drops the field when it edits a recipe, because its
`compactRecipe` strips unknown keys. Old backups have no label, and detection
can be wrong. The fallback for a missing label is permanent, not a migration
shim.

**Filling in a missing label.** A detected language fills a missing `lang`
only as part of a save the person started. Nothing makes a separate
background write, because a save bumps `updatedAt` and would move the recipe
to the top of the Library, which is sorted by `updatedAt`. The one-off
backfill script is the exception. It writes only `lang`, keeps `updatedAt`,
and bumps only `serverUpdatedAt`.

### 7. `lang` is the only language data on a recipe; translations are derived and outside sync

`Recipe` gains exactly one field for this feature, the optional `lang`.
Translations are never stored on a recipe, a chat message, or cook state, and
never go through `/api/sync/*`. The server caches translations at
`users/{uid}/translations/{recipeId}.{target}`, keyed by a hash of the source
text. A hash mismatch is a miss. It can be deleted at any time without losing
data, and it is deleted when its recipe is deleted (principle 14).

**Why.** `Recipe` is schema-locked (`src/lib/recipeStore.test.ts`) because
every field has to be threaded through the compacting on both client and
server, backups, and validation. A cache can be rebuilt, so it doesn't need
tombstones, pull cursors, or last-write-wins.

### 8. No recipe text or translation is stored on the device

The only language data on the device is the UI language preference
(`cook.locale` in localStorage, next to `cook.theme`). The client keeps
translations in memory only.

**Why.** `/privacy` and `/terms` promise that there is no on-device recipe
database. This app dropped IndexedDB on purpose.

### 9. UI copy lives only in the catalogs

- **One place.** Every piece of user-facing text in the app (the React SPA)
  is a key in `src/i18n/`. `en` defines the key set, and TypeScript fails the
  build if any locale is missing a key.
- **Deliberate exceptions.** These stay English and outside the catalogs
  and the review manifest:
  - the static pages `/about`, `/privacy`, and `/terms` (`public/*.html`),
    because legal text is not machine-translated
  - the owner notification email
  - server-rendered access and invite HTML
  - the Chrome extension, until its own milestone

  The app's links to these pages are translated.
- **Sentences.** Sentences are never built by joining translated fragments.
  Interpolation uses named parameters.
- **Formatting.** Plurals go through `Intl.PluralRules`, with
  `one`/`few`/`many`/`other` for `uk` and `ru`. Numbers, relative times,
  and language names come from `Intl`: `Intl.NumberFormat`,
  `Intl.RelativeTimeFormat`, and `Intl.DisplayNames`.

**Why.** Word order and plural forms differ across the supported languages.
Text that isn't in a catalog is text that silently stays English.

### 10. The server sends codes; the client owns the words

Server JSON errors carry a stable machine-readable `code`. The English
`error` string stays only as a fallback for older clients. New user-facing
server text is added as a code plus catalog entries, not as a new English
string.

**Why.** The server doesn't know the UI language, and it shouldn't need to.

### 11. The provider sits behind one interface, and the choice is recorded here

- **The interface.** All translation and detection goes through
  `translateSegments` / `detectLanguage` in `server/translate.ts`.
- **Configuration.** The provider and model come from env
  (`TRANSLATE_PROVIDER`, `TRANSLATE_MODEL`).
- **Changing the default.** Changing it means updating
  [Current decisions](#current-decisions) with the new reasons.

**Why.** How latency, quality, and cost trade off changes with every model
release and price change. Keeping the provider behind one interface makes
switching a config change instead of a rewrite, and the written reasons let
the next person see what the decision was optimizing for.

### 12. Import translation is opt-out, visible, and never blocks import

- **When it's offered.** When an imported recipe's language differs from
  the UI language, the preview shows a "translate into the UI language"
  checkbox, checked by default.
- **Guessed language.** The preview always shows the guessed language and
  lets the person change it before saving.
- **Both versions kept.** The original and the translation are both in
  memory until save, so toggling is instant.
- **Failure.** If translation fails, the original is still importable; the
  failure shows as a notice, not an error.
- **Bulk import.** The same choice applies to the whole batch.

**Why.** Someone who imports a foreign recipe usually wants to cook from it in
their own language. But the choice must be visible and reversible before
anything is saved, because the saved text becomes the source of truth
(principle 1).

### 13. Chat stays out of i18n

No locale is added to the `/api/chat` request, and its system prompt is not
changed for language. The assistant answers in the language the person
writes in.

**Why.** The chat request shape is on the root `AGENTS.md` do-not-touch list,
and Gemini already follows the user's language.

### 14. Every place recipe text goes is disclosed

Before any new provider or cache receives recipe text, `/privacy` and
`/terms` must say so.

**Why.** Recipes can be private (pasted from paid sites or family notes), and
the legal pages are the promise made to users.

### 15. The supported UI languages are a closed list

- **The list.** `en`, `uk`, `ru`, `zh-Hans`.
- **Adding one.** Add a catalog, parity tests, plural rules, a register and
  glossary entry, and a full in-context translation review of every
  manifest screen.
- **Recipe languages.** A recipe may be in any language. Translation targets
  only UI languages.

**Why.** A UI language that is only partly translated is worse than English.

### 16. New UI text ships translated and reviewed in context

- **Translated.** Any change that adds or changes user-facing text in the
  app adds it to every catalog in the same change. The exceptions in
  principle 9 are the only ones. English-only strings "to translate
  later" are not allowed.
- **Reviewed in context.** The same change runs the in-context translation
  review (`.cursor/skills/i18n-visual-review/SKILL.md`, later `npm run
  test:i18n`) for every screen that shows the new text, in every
  non-English language. Blockers are fixed before the change is done.
- **Manifest.** New screens or states are added to the review manifest
  (`screens.json`) in the same change.
- **Register and glossary.** Catalog text follows the register and glossary
  in [Current decisions](#current-decisions).

**Why.** Parity tests only prove a key exists. A string that is correct on
its own can be wrong next to its neighbours: a noun on a verb button,
Russian or Ukrainian case or gender that doesn't agree with the number
beside it, two words for the same concept, or Chinese text wrapping inside
a button. Only a rendered page shows that. Checking each change keeps the
work small; waiting for a periodic audit lets problems pile up in languages
the author can't read.

## Current decisions

These are reversible under principle 11. Each lists what it optimizes for.

- **Default translation provider: Gemini, `gemini-3.5-flash-lite`, thinking
  level `minimal`, default temperature.** Selected by
  `TRANSLATE_PROVIDER=gemini` (the default; `nmt` selects the fallback) and
  `TRANSLATE_MODEL`.
  - **Measured.** Not yet. Step 14 of the plan records translate-eval
    quality and local p50/p95 latency here. Cloud Run `europe-west1` p95 is
    measured by the owner after the reviewed deploy and added here; there is
    no staging to measure on earlier.
  - **Setup cost is not a factor.** NMT's API enablement and IAM role are
    one-time owner steps, so the choice rests on context, latency, and cost.
  - **Context.** One call sees the whole recipe. That matters most for `uk`
    and `ru`: pronouns and past-tense verbs agree in grammatical gender with
    something named in an earlier step, which is exactly where sentence-level
    translation breaks.
  - **Latency is often hidden.** Translate-on-import is on by default, so
    most foreign recipes arrive already translated, and the runtime toggle
    mostly serves older recipes and UI-language switches. Latency matters
    less than quality there.
  - **Cost.** Beyond Cloud Translation's free tier it is about 25 times
    cheaper: about $0.002 against about $0.05 per 2,500-character recipe.
  - **Why Flash-Lite 3.5.** It is Google's current GA low-latency tier and
    lists translation as a target use. Flash-Lite 3.1 may shut down from May
    2027. Flash-Lite 2.5 is limited to accounts that used it before. The chat
    model (`gemini-3.7-flash`) costs 2.5 times as much, and its lowest
    thinking level is `low`.
  - **Why `minimal`.** Translation doesn't gain from step-by-step reasoning.
    Thinking tokens are billed as output and delay the first output token.
- **Fallback provider: Cloud Translation v3 NMT.**
  - **Strengths.** About 0.2 to 0.4 s latency, returns exactly one output per
    input, and free up to 500k characters a month.
  - **Why not the default.** It translates sentence by sentence without
    recipe context.
  - **When to switch.**
    - **Latency.** If deployed Cloud Run p95 for the toggle is above about
      4 s, first split each recipe into two parallel Gemini requests. If p95
      is still above 4 s, switch to NMT.
    - **Quality.** If the translation eval shows Gemini quality problems
      that NMT doesn't have, switch to NMT.

    The one-time setup is listed in the plan.
- **Import labels.** The import's existing structured Gemini call returns
  `lang` for no extra call.
- **Dictation.** `/api/stt` names the UI language in its prompt. If testing
  shows poor transcription for a language, that language falls back to
  English and the mic shows an "EN" badge saying so. Step 4 of the plan
  records the result here.
- **Catalogs.** No i18n library: about 400 strings, four locales, typed
  catalogs, and `Intl`.
- **Chinese.** "Mandarin" means Simplified Chinese, `zh-Hans`.
- **Register and glossary.** Proposed: `uk` uses "ви", `ru` uses "вы", and
  `zh-Hans` uses "你". Step 1 of the plan confirms these and adds a glossary
  of core terms (recipe, collection, library, import, servings, step,
  ingredient) for each language. The in-context review checks catalog text
  against both.
- **In-context review delivery.** A Cursor project skill first (no new
  dependency; it reuses the browser tooling agents already have, and lets
  the rubric and manifest settle). A standalone `npm run test:i18n`
  (Playwright plus a Gemini vision judge) comes later, as its own
  milestone.

## Amendments

| Date | Principle | Change | Why |
| --- | --- | --- | --- |
| | | | |
