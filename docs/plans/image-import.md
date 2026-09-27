# Import a recipe from photos

Let a member import one recipe from 1–4 photos, typically of handwritten
notes. The photos go to Gemini through the existing import pipeline as
`inlineData` parts, the result lands in the editable preview, and the photos
are never stored.

**Binding:** `docs/constitutions/image-import.md`. Every step below cites the
principles it implements (P1–P11). Nothing here may contradict it. If an
implementer has to deviate, amend the constitution in the same change (its
"How to change this document" section), or stop and ask.

Checked against branch `cursor/image-import-38e9` at `617489c` ("Add image
import constitution"). Owner-approved design:
`/opt/cursor/artifacts/plans/handwritten_image_import_6f9746da.plan.md`.

## Decisions (settled — do not reopen while implementing)

- **Gemini alone reads the photos** (P2). There is no OCR step in the request
  path. Cloud Vision appears only in `evals/ocrCompare.ts`, which is an eval.
- **One pipeline** (P1). `importFromImages` in `server/recipeImport.ts` makes
  one `generateContent` call with the shared `RECIPE_SCHEMA`. Its response goes
  through a private helper that `importFromSource` also uses. There are no
  retries.
  - _Superseded 2026-09-27 by `docs/plans/image-import-evals-and-retry.md`: one identical retry on `parse_error` / `unusable`, and a runaway-unit check (constitution P1 amendment). The P1 checklist line below is superseded the same way._
- **Additive API** (P7). `POST /api/import` accepts
  `images?: { mediaType: string; base64: string }[]`, the same shape as
  `ChatRequestImage` in `api/chat.ts` and `EncodedImage` in `src/lib/image.ts`.
  A truthy `url` wins, as today, and `images` is then ignored without being
  validated. `text` may come with `images` as extra context. `images: []` is
  treated as if the field were absent. `ImportOutcome`, `RecipeImportDeps`,
  `Recipe`, `RecipeDraft`, and the schema lock test do not change.
- **Caps** (P6). These are the exact constants, and they must match the
  constitution:

  | Constant | Value | Where |
  | --- | --- | --- |
  | `MAX_IMPORT_IMAGES` | `4` | `server/importRoute.ts` |
  | `MAX_IMPORT_IMAGE_BYTES` | `3 * 1024 * 1024` (decoded bytes, per image) | `server/importRoute.ts` |
  | `MAX_IMPORT_BODY_BYTES` | `12 * 1024 * 1024` (raw request body) | `server/importRoute.ts` |
  | `IMPORT_IMAGE_TYPES` | `image/jpeg`, `image/png`, `image/webp` | `server/importRoute.ts` |
  | `MAX_IMPORT_PHOTOS` | `4` | `src/lib/importApi.ts` |
  | `MAX_IMPORT_PHOTO_BYTES` | `3 * 1024 * 1024` (client mirror, decoded) | `src/lib/importApi.ts` |
  | `MAX_IMPORT_PHOTOS_BASE64_CHARS` | `12 * 1024 * 1024 - 64 * 1024` (client mirror of the body cap, with headroom) | `src/lib/importApi.ts` |
  | `IMPORT_MAX_EDGE_PX` | `2048` | `src/lib/image.ts` |
  | `IMPORT_JPEG_QUALITY` | `0.85` | `src/lib/image.ts` |
  | `mediaResolution` | `MediaResolution.MEDIA_RESOLUTION_HIGH` | `server/recipeImport.ts` |

  MB means MiB here, the same convention as `MAX_STT_BYTES = 1_048_576`.
  The two server byte caps interact. Four images at the 3 MiB per-image cap
  come to about 16 MiB of base64, so the body cap rejects them. The per-image
  cap is the binding limit for 1–3 large images, and the body cap is binding
  for 4. The client's output (2048 px JPEG at 0.85) is typically 0.3–1.5 MB
  per page, but a noisy photo can be larger, so the client also enforces both
  caps before sending (step 3's `checkImportPhotoBytes`, applied at pick time
  in step 4). 12 MiB of base64 is also under Gemini's 20 MB inline request
  limit.
- **Where `mediaResolution` goes.** Set it in the config-level field
  `GenerateContentConfig.mediaResolution`, typed as the `MediaResolution` enum
  exported by `@google/genai` (1.52.0, `node_modules/@google/genai/dist/genai.d.ts`).
  Its value is the string `"MEDIA_RESOLUTION_HIGH"`. Do not use the per-part
  `Part.mediaResolution` / `PartMediaResolutionLevel` (a different enum that
  also has `ULTRA_HIGH`). Importing a library enum is fine under
  `erasableSyntaxOnly`, which only forbids *declaring* enums. The repo already
  uses `Type.OBJECT` the same way.
- **Body read** (P6). `importPost` stops calling `req.json()`. It calls the
  existing shared reader `readBoundedText(req, MAX_IMPORT_BODY_BYTES)` from
  `server/membership.ts` (already used by `server/access.ts` and
  `server/admin.ts`; importing it does not edit `membership.ts`). That reader
  rejects an oversized `Content-Length`, reads the stream with a cap and
  `reader.cancel()`, and decodes UTF-8. `null` maps to 413, and the text is
  parsed with `JSON.parse`. No local copy of a capped reader is added, and
  `server/stt.ts` is not edited. `withMembership` runs before `importPost`,
  so a non-member can never make the server buffer a body.
- **Text-path deltas from the new body read.** These are the only behaviour
  changes for non-photo requests, and they are intended; none affects the
  real client, which always sends small valid JSON objects:
  - a body over 12 MiB (text or URL) now gets 413 `That's too large to
    import — try fewer photos.` instead of being parsed;
  - invalid JSON now gets 400 `Bad request` instead of an uncaught throw and
    a 500 from the global handler in `scripts/server.ts`;
  - JSON that is not a plain object (for example `[]`) now gets 400
    `Bad request` instead of 400 `Provide a URL or recipe text.`
  Everything else on the URL and text paths, including every status and
  string, is unchanged.
- **Never stored, never logged** (P3). The client keeps encoded photos in
  React state only. `ImportScreen` does not import `photoStore`: thumbnails
  use `data:` URLs built once from the encoded JPEG at pick time. The server
  writes nothing and logs only counts and byte sizes, exactly as
  `server/stt.ts` does: `import images count=<n> bytes=<decoded total>` on
  every photo request, and `import images failed count=<n> bytes=<decoded
  total>` when Gemini throws. Nothing may log a request body, a Gemini
  request, an SDK error object, or any field read from one (no error name,
  message, or status). Catching the error keeps it out of the global
  `console.error` in `scripts/server.ts`.
- **Undecodable photos** (for example iPhone HEIC in desktop Chrome):
  `encodeImageForImport` wraps any decode or encode failure as
  `new Error('That image could not be encoded.')`, and the screen shows
  **`That photo couldn't be read — try a JPEG or PNG.`** This refines the
  owner plan's "existing 'could not be encoded' error" into copy that tells
  the person what to do. ChatPanel's `it may not be a real image` wording is
  not reused, because it misdescribes a genuine HEIC photo.
- **Review is mandatory** (P4). Photos exist only in single-recipe mode and
  always end in `CreateRecipeForm`. The bulk checkbox is disabled while photos
  are attached, and "Add photos" is disabled while bulk is on. `runBulk` keeps
  sending `{ url }` only. The extension and `server/extensionImport.ts` are
  untouched.
- **When photos are attached, the textarea holds notes.** The client sends
  `{ images, text? }` and never `url`, even if the notes contain a link. That
  way a pasted link cannot silently drop the photos.
- **Encode at pick time.** Each picked file is encoded right away with
  `encodeImageForImport`. That surfaces unreadable files (for example HEIC in
  Chrome) straight away, and it gives the thumbnails a JPEG to show.
- **Transparent PNGs get a white background** in `encodeImageForImport`
  (otherwise JPEG turns transparency black, which makes ink on a transparent
  scan unreadable). This goes through a new optional `background` argument to
  the private `downscale`. `encodeImageForChat` and `encodeImageForStorage` do
  not pass it, so their output is unchanged.
- **Vision auth for `evals/ocrCompare.ts`: Application Default Credentials
  through `google-auth-library`.** It is already a **direct** dependency
  (`package.json` `^11.0.2`, used by `server/auth.ts`), so there is no new
  package and no new secret. ADC is already the documented local setup
  (`gcloud auth application-default login` plus `set-quota-project
  cooking-assistant-508423`, per `AGENTS.md`), and it keeps a long-lived API
  key out of `.env.local`. There is no `VISION_API_KEY`. If ADC is missing,
  or Vision answers 401/403, approach B is skipped with a message, and A
  still runs.
- **Node ≥ 22.18, `erasableSyntaxOnly`.** No enums, no constructor parameter
  properties, `import type` for types, `.ts` extensions on relative imports in
  `server/` and `evals/`. On this VM `/exec-daemon/node` (22.14) is first on
  `PATH`. Put `~/.nvm/versions/node/v22.22.2/bin` first before running
  `dev:api` or `evals/ocrCompare.ts`.

## Goal

On a phone or desktop, a member opens **Import recipe**, taps **Add photos**,
and picks up to 4 pages. They see numbered thumbnails and can optionally type
notes, then tap **Extract recipe**. After review in the usual preview, they
save the recipe. The photos are not attached to the recipe, uploaded to GCS,
or written anywhere. Text, URL, and bulk import behave as before, apart from
the three malformed-request deltas listed under Decisions.

## Non-goals

These are the constitution's "Deliberately not built" list, plus the items
from the owner's plan that are out of scope:

- Keeping a scan as the cover photo or in the gallery (P3).
- Photos in bulk import or in the Chrome extension (P4).
- Any OCR service, Document AI, or in-browser text recognition in the request
  path (P2).
- PDFs, HEIC on the server, or any MIME type beyond JPEG/PNG/WebP (P6, P7).
- A Vercel copy. `api/import.ts` stays a 401 stub (P8).
- Vertex AI or EU pinning for Gemini (P9 says that would be an amendment).
- Committing handwritten fixtures. The owner has not supplied any yet (see
  Open questions).

## Constitution map

| Principle | Implemented in steps |
| --- | --- |
| P1 One pipeline | 1, 2, 6 |
| P2 No OCR in the request path | 1, 6, Verification |
| P3 Extraction only, never stored | 2, 3, 4, 5, Verification |
| P4 Always reviewed; no bulk or extension | 4, Verification |
| P5 Faithful transcription prompt | 1 |
| P6 Caps on both sides | 1, 2, 3, 4, Verification |
| P7 Additive API | 1, 2, 3, Verification |
| P8 Auth and hosting unchanged | 2, Verification |
| P9 Data governance | 5, Verification |
| P10 Tests match the repo | 1, 2, 3, 6, Verification |
| P11 Privacy copy ships with the feature | 5, Verification |

## Files

Changed:

- `server/recipeImport.ts` — `ImportImage`, `importFromImages`, the private
  response helper, and the photo prompt.
- `server/recipeImport.test.ts` — `importFromImages` tests.
- `server/importRoute.ts` — capped body read, `checkImportImages`, the
  photo path, and photo copy.
- `server/importRoute.test.ts` — photo and body-cap tests.
- `src/lib/image.ts` — `encodeImageForImport`, `IMPORT_MAX_EDGE_PX`,
  `IMPORT_JPEG_QUALITY`, and the optional `downscale` background.
- `src/lib/importApi.ts` — `images` param, `MAX_IMPORT_PHOTOS`,
  `IMPORT_PHOTO_LIMIT_ERROR`, `fitImportPhotos`, `MAX_IMPORT_PHOTO_BYTES`,
  `MAX_IMPORT_PHOTOS_BASE64_CHARS`, `IMPORT_PHOTO_TOO_LARGE_ERROR`,
  `IMPORT_PHOTOS_TOTAL_TOO_LARGE_ERROR`, `checkImportPhotoBytes`.
- `src/lib/importApi.test.ts` — **new**.
- `src/screens/ImportScreen.tsx` — the photo picker.
- `public/privacy.html`, `public/terms.html` — photo copy.
- `README.md`, `AGENTS.md` — docs, plus the plans-table row.
- `evals/judge.ts` — **new**. The judge moves out of the eval file so the
  compare script can reuse it.
- `evals/handwrittenFixtures.ts` — **new**. Fixture discovery.
- `evals/recipeImport.eval.ts` — the handwritten suite.
- `evals/ocrCompare.ts` — **new**. Compares A (Gemini alone) with B (Cloud
  Vision, then Gemini).
- `evals/README.md` — a section on `evals/import-handwritten/`.
- `package.json` — the `eval:ocr-compare` script.

Must **not** change: `api/import.ts`, `api/chat.ts`,
`server/extensionImport.ts`, `extension/`, `scripts/server.ts`,
`server/membership.ts`, `server/stt.ts`, `test/fakeGemini.ts`,
`src/lib/types.ts`, `src/lib/recipeStore.test.ts`, `src/lib/photoStore.ts`,
`src/components/*`, `src/lib/importInput.ts`, `vitest.config.ts`,
`vitest.eval.config.ts`, `Dockerfile`, `.github/`, `vercel.json`.

Commit each step on its own, with a descriptive message, and push it before
starting the next. Run `npm test` (and `npm run build` for steps 1–4 and 6)
before each commit.

## Steps

### 1. [core] `importFromImages` and the shared response helper

Principles: P1, P2, P5, P6 (the `mediaResolution` part), P7, P10.

Files: `server/recipeImport.ts`, `server/recipeImport.test.ts`.

1. Import `MediaResolution` alongside `GoogleGenAI, Type, type Schema` from
   `@google/genai`.
2. Export `interface ImportImage { mediaType: string; base64: string }`, with
   a doc comment: raw base64 with no data-URL prefix, the same shape as
   `ChatRequestImage`. Callers validate it first
   (`checkImportImages` in `server/importRoute.ts`), because
   `importFromImages` trusts its input.
3. Add `const RECIPE_OUTPUT_CONFIG = { maxOutputTokens: 4096,
   responseMimeType: 'application/json', responseSchema: RECIPE_SCHEMA }`.
   `importFromSource` spreads it into its `config`, so its request stays
   byte-for-byte the same as today.
4. Move the body of `importFromSource` after `generateContent` (JSON parse,
   then the `parse_error` check for a non-object, then `NOT_A_RECIPE`, then
   `normalizeImportedRecipe`) verbatim into a **non-exported**
   `function outcomeFromModelText(text: string | undefined): ImportOutcome`.
   `importFromSource` returns `outcomeFromModelText(result.text)`.
5. Add the exported function:

   ```ts
   export async function importFromImages(
     images: readonly ImportImage[],
     extraText: string,
     deps: RecipeImportDeps,
   ): Promise<ImportOutcome>
   ```

   - If `images.length === 0`, return `{ kind: 'empty_source' }` without
     calling Gemini.
   - Otherwise make exactly one call:
     ```ts
     deps.ai.models.generateContent({
       model: deps.model,
       contents: [{
         role: 'user',
         parts: [
           ...images.map((image) => ({
             inlineData: { mimeType: image.mediaType, data: image.base64 },
           })),
           { text: imageImportPrompt(extraText) },
         ],
       }],
       config: {
         ...RECIPE_OUTPUT_CONFIG,
         mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
       },
     })
     ```
   - Return `outcomeFromModelText(result.text)`.
6. Add a private `imageImportPrompt(extraText: string): string`. Its lines are
   joined with `\n`. The wording below is the default; the substrings the tests
   pin must survive any rewording (P5: a change that drops them breaks the
   principle).

   ```
   The photos are the pages of one recipe, often handwritten. Extract the recipe and save it.
   Read the pages in the order given: the first photo is page 1.
   Transcribe what is written. Skip anything that is crossed out.
   If you are unsure how a word reads, write your best reading followed by (?). If you are unsure of an amount, keep your best reading as the quantity and add (?) to that ingredient's note.
   If you cannot tell whether an amount is a tablespoon or a teaspoon (for example a T that could be a t), use your best reading and say so in notes.
   Never invent quantities, ingredients, or steps that are not written. If an amount is missing or unreadable, leave the quantity out.
   Convert fractions to decimals for quantities.
   If no title is written, use a short plain name for the dish. Give a description or prep and cook times only if they are written. If servings are not written, use 1.
   If the photos contain no recipe, save a recipe with the title "NOT_A_RECIPE".
   ```

   If `extraText.trim()` is not empty, append
   `\n\nNotes from the person importing these photos (context only; the photos are the source):\n${extraText.trim().slice(0, MAX_SOURCE_CHARS)}`.
   If it is blank, append nothing.
7. Update the module docblock's first line to "page HTML, pasted text, or
   photos in, a saveable recipe draft out", and add `importFromImages` to the
   list of callers' entry points. Keep the constitution pointer line.
8. Do not add a Vision, Document AI, or other OCR import (P2). Do not touch
   `ImportOutcome`, `RecipeImportDeps`, `RECIPE_SCHEMA`, `normalizeImportedRecipe`,
   or `importFromHtml`.

**Tests** (in `server/recipeImport.test.ts`, a new `describe('importFromImages')`,
using `fakeImportDeps` from `test/fakeGemini.ts` unchanged; cast
`calls[0].contents` to `Content[]` imported as a type from `@google/genai`):

- `returns empty_source and does not call the model with no images`:
  `importFromImages([], 'notes', deps)` returns `{ kind: 'empty_source' }`,
  with `calls` length 0.
- `sends each photo as an inlineData part, in order, then one prompt part`:
  three images (`image/jpeg`/`AAAA`, `image/png`/`BBBB`, `image/webp`/`CCCC`).
  Expect exactly 1 call with `model: 'test-model'`, one content with
  `role: 'user'`, and `parts.length === 4`. `parts[0..2]` deep-equal
  `{ inlineData: { mimeType, data } }` in the input order, and `parts[3]` has
  a `text` string and no `inlineData`.
- `asks for high media resolution with the shared recipe schema`:
  `config.mediaResolution === MediaResolution.MEDIA_RESOLUTION_HIGH` and
  `=== 'MEDIA_RESOLUTION_HIGH'`, `maxOutputTokens === 4096`, and
  `responseMimeType === 'application/json'`. `config.responseSchema` is the
  **same object** (`toBe`) as the `responseSchema` that an `importFromSource`
  call receives.
- `keeps the text import request unchanged`: the `importFromSource` call's
  `config` has no `mediaResolution` key, and its `contents` is still a string.
- `tells the model to transcribe faithfully`: the prompt text contains each
  of `in the order given`, `crossed out`, `(?)`, `tablespoon`, `teaspoon`,
  `notes`, `Never invent`, and `NOT_A_RECIPE`.
- `adds the notes as context only when given`: with `'  Grandma's, 1970s  '`,
  the prompt contains `Notes from the person importing` and
  `Grandma's, 1970s`. With `'   '`, it does not contain `Notes from`, and
  the prompt ends with the `NOT_A_RECIPE` line.
- `maps the model reply like text import`: for replies `undefined`, `''`,
  `'Sure!'`, `'42'`, and `'null'`, the outcome is `parse_error`.
  `{...MINIMAL, title: 'NOT_A_RECIPE'}` gives `not_a_recipe`,
  `{...MINIMAL, title: ' '}` gives `unusable`, and
  `{...MINIMAL, servings: 0, photoId: 'x'}` gives `{ kind: 'ok', recipe: { ...MINIMAL, servings: 1 } }`.
- All existing `importFromSource` / `importFromHtml` tests pass unchanged.

**Acceptance:** `npm test` and `npm run build` pass. `git diff` shows no change
to the `ImportOutcome` or `RecipeImportDeps` declarations. `rg -n "mediaResolution" server`
matches only `server/recipeImport.ts` and its test.

### 2. [core] `/api/import` accepts `images`, with a capped body read

Principles: P1, P3, P6 (server caps), P7, P8, P10.

Files: `server/importRoute.ts`, `server/importRoute.test.ts`.

1. Export constants `MAX_IMPORT_IMAGES = 4`,
   `MAX_IMPORT_IMAGE_BYTES = 3 * 1024 * 1024`,
   `MAX_IMPORT_BODY_BYTES = 12 * 1024 * 1024`, and
   `IMPORT_IMAGE_TYPES: ReadonlySet<string>` (`image/jpeg`, `image/png`,
   `image/webp`).
2. Add `images?: unknown` to `ImportRequestBody`, with a doc comment:
   "Photos of one recipe, `{ mediaType, base64 }`, used only when `url` is
   absent. `text` becomes extra context."
3. Export a pure checker:

   ```ts
   export type ImportImagesCheck =
     | { kind: 'absent' }                                   // undefined, null, or []
     | { kind: 'ok'; images: ImportImage[]; bytes: number } // bytes = decoded total
     | { kind: 'too_many' }
     | { kind: 'bad_type' }
     | { kind: 'unreadable' }
     | { kind: 'too_large' };

   export function checkImportImages(raw: unknown): ImportImagesCheck
   ```

   It checks in this order, and the first failure wins:
   1. `undefined`, `null`, or `[]` gives `absent`. Anything else that is not an
      array gives `unreadable`.
   2. `length > MAX_IMPORT_IMAGES` gives `too_many`, before any element is
      inspected.
   3. For each element, in order:
      - it is not a plain object, or `mediaType` / `base64` is not a string:
        `unreadable`;
      - `mediaType.trim().toLowerCase()` is not in `IMPORT_IMAGE_TYPES`:
        `bad_type`;
      - `base64` is empty, or `length % 4 !== 0`, or it fails
        `/^[A-Za-z0-9+/]+={0,2}$/` (this rejects data-URL prefixes and
        base64url): `unreadable`;
      - decoded size is `base64.length / 4 * 3 - padding`, computed without
        decoding. If it is `> MAX_IMPORT_IMAGE_BYTES`: `too_large`;
      - it decodes only `base64.slice(0, 16)` and checks the magic bytes for the
        declared type: JPEG `FF D8 FF`; PNG `89 50 4E 47 0D 0A 1A 0A`; WebP
        `RIFF` at 0–3 and `WEBP` at 8–11. If they are missing or the input is
        too short: `unreadable`.
   4. Otherwise it returns `ok`, with each image's `mediaType` normalized to
      lower case, and `bytes` as the decoded total.
4. Import `readBoundedText` from `./membership.ts` (the module already imports
   `type MembershipHandlerContext` from there). Do not add a local capped
   reader or `Content-Length` parser.
5. `importPost` order:
   1. `const raw = await readBoundedText(req, MAX_IMPORT_BODY_BYTES)`. `null`
      (declared or streamed size over the cap) gives 413
      `That's too large to import — try fewer photos.`
   2. `JSON.parse(raw)` in `try`. A throw (including `raw === ''`) or a result
      that is not a plain object gives 400 `Bad request`.
   3. `body.url` truthy: the existing URL path, unchanged, with `images` ignored.
   4. `checkImportImages(body.images)`. `absent` falls through to the
      existing text path, unchanged. Failures map as in the table below. On
      `ok`:
      `console.log(\`import images count=${images.length} bytes=${bytes}\`)`,
      then
      `importFromImages(images, typeof body.text === 'string' ? body.text : '', deps ?? recipeImportDepsFromEnv())`
      inside `try`. On `catch` (bind nothing, or ignore the binding):
      `console.error(\`import images failed count=${images.length} bytes=${bytes}\`)`
      and return 502. Nothing read from the error is logged (P3). On an
      outcome, return `outcomeResponse(outcome, undefined, PHOTOS_NOT_A_RECIPE)`.
   5. Existing text path, unchanged.
6. `outcomeResponse` gains a third parameter,
   `notARecipe = "Couldn't find a recipe in that content."`. The photo path
   passes `"Couldn't find a recipe in those photos."`. Every other string and
   status stays as it is today.
7. Keep the `_ctx?: MembershipHandlerContext` parameter. Do **not** mention
   `authorizedSub` (`server/membership.test.ts` assertion 6 counts it). Do not
   touch `scripts/server.ts`: the route stays `withMembership(importPost)`
   (assertion 5). No header auth (P8).
8. Update the module docblock: "URL, pasted text, or up to 4 photos in".

**Status and copy** (exact strings; ASCII apostrophes, em dash as in the
existing copy):

| Case | Status | `error` |
| --- | --- | --- |
| `Content-Length` or streamed body `> MAX_IMPORT_BODY_BYTES` (any request) | 413 | `That's too large to import — try fewer photos.` |
| No body, invalid JSON, or non-object JSON | 400 | `Bad request` |
| `too_many` | 400 | `Up to 4 photos.` |
| `bad_type` | 400 | `Photos must be JPEG, PNG, or WebP.` |
| `unreadable` | 400 | `Those photos couldn't be read.` |
| `too_large` (one image) | 413 | `Those photos are too large.` |
| Gemini throws (photo path only) | 502 | `Couldn't read those photos — try again.` |
| photo `not_a_recipe` | 422 | `Couldn't find a recipe in those photos.` |
| photo `parse_error` | 502 | `Extraction failed — no structured result.` (unchanged copy) |
| photo `unusable` | 502 | `Extraction produced an unusable recipe.` (unchanged copy) |
| photo `ok` | 200 | `{ recipe }` with **no** `sourceUrl` key |
| `images: []` and blank text | 400 | `Provide a URL or recipe text.` (unchanged) |

**Tests** (in `server/importRoute.test.ts`; extend the `post()` helper so it
also accepts a raw string body and extra headers; build image payloads with
`Buffer`):

Fixtures: `jpeg(n)` is `FF D8 FF E0` followed by zero bytes up to `n` bytes,
base64 encoded. `png()` and `webp()` get valid magic the same way.

- `imports from photos without sourceUrl`: 2 images give 200. `body.recipe`
  equals the normalized recipe and `'sourceUrl' in body.recipe` is false. The
  Gemini call has `inlineData` parts equal to the two sent images, in order,
  followed by a text part.
- `passes text as notes alongside photos`: `{ images: [jpeg], text: 'Nan's pie' }`.
  The last part's text contains `Nan's pie`.
- `prefers the URL and ignores photos`: with a URL and 5 images (which would
  be invalid): 200. `calls[0].contents` is a string with the page text.
- `treats an empty images array as absent`: `{ images: [], text: 'soup' }`
  gives 200 with `contents` a string. `{ images: [] }` gives 400
  `Provide a URL or recipe text.`
- `rejects more than 4 photos`: 5 valid images give 400 `Up to 4 photos.`
  with 0 calls. 5 `image/gif` images also give `Up to 4 photos.`, which locks
  the check order.
- `rejects other image types`: `image/gif`, `image/heic`, and `application/pdf`
  each give 400 `Photos must be JPEG, PNG, or WebP.` with 0 calls. `IMAGE/JPEG`
  is accepted and forwarded as `image/jpeg`.
- `rejects photos it cannot read`: `images: 'x'`, `images: {}`, `[null]`,
  `[{ mediaType: 'image/jpeg' }]`, `[{ mediaType: 'image/jpeg', base64: 7 }]`,
  an empty base64 string, a `data:image/jpeg;base64,` prefix, base64url
  characters, PNG bytes labelled `image/jpeg`, and a 4-character string
  (`/9j/`) labelled `image/webp`. Each gives 400 `Those photos couldn't be read.`
  with 0 calls.
- `caps each photo at 3 MB decoded`: a JPEG of exactly `MAX_IMPORT_IMAGE_BYTES`
  gives 200. One byte more gives 413 `Those photos are too large.` with 0 calls.
- `accepts four typical photos`: 4 JPEGs of 2 MiB each give 200 with 4
  `inlineData` parts.
- `rejects four photos at the per-photo cap by body size`: 4 JPEGs of
  `MAX_IMPORT_IMAGE_BYTES` each give 413 `That's too large to import — try fewer photos.`
- `caps the request body at 12 MB`: a `Content-Length` of
  `String(MAX_IMPORT_BODY_BYTES + 1)` with body `'{}'` gives 413
  `That's too large to import — try fewer photos.` A streamed body of
  `MAX_IMPORT_BODY_BYTES + 1` bytes with no `Content-Length`
  (`JSON.stringify({ text: 'x'.repeat(MAX_IMPORT_BODY_BYTES) })`) gives the
  same 413, with 0 calls in both cases.
- `rejects a body that is not JSON`: `'not json'`, `''`, `'[]'`, and `'"x"'`
  each give 400 `Bad request`.
- `maps photo outcomes to photo copy`: `NOT_A_RECIPE` gives 422
  `Couldn't find a recipe in those photos.`, a non-JSON reply gives 502
  `Extraction failed — no structured result.`, and `{ servings: 2 }` gives 502
  `Extraction produced an unusable recipe.`
- `reports a Gemini failure on photos as 502`: an inline `RecipeImportDeps`
  whose `generateContent` rejects gives 502
  `Couldn't read those photos — try again.`
- `never logs photo data`: spy on `console.log` and `console.error`
  (`mockImplementation(() => {})`). Run one `ok` photo import and one where
  Gemini throws, using a distinctive 4 KiB JPEG payload. No logged argument
  contains the base64 string, or any 16-character slice of it. Exactly one
  `console.log` call matches `/^import images count=1 bytes=\d+$/` per
  request, and the failing request's only `console.error` call matches
  `/^import images failed count=1 bytes=\d+$/`. Make the rejected error's
  `message` a distinctive string (for example `SECRET-UPSTREAM-DETAIL`) and
  assert it appears in no logged argument.
- All existing tests in the file pass unchanged, including every existing copy
  string.

**Acceptance:** `npm test` (including `server/membership.test.ts`) and
`npm run build` pass. `rg -n "req\.json\(" server/importRoute.ts` has no
matches. `rg -n "authorizedSub" server/importRoute.ts` has no matches.
`git diff` is empty for `scripts/server.ts`, `api/import.ts`, and
`server/extensionImport.ts`.

### 3. [core] `encodeImageForImport` and `importRecipe({ images })`

Principles: P3, P6 (client caps), P7, P10.

Files: `src/lib/image.ts`, `src/lib/importApi.ts`, `src/lib/importApi.test.ts` (new).

`src/lib/image.ts`:

1. Export `IMPORT_MAX_EDGE_PX = 2048` and `IMPORT_JPEG_QUALITY = 0.85`. Leave
   `JPEG_QUALITY = 0.8` and the chat/storage defaults (1280) unchanged.
2. `downscale(blob, maxDim, background?: string)`. When `background` is set,
   `fillStyle = background; fillRect(0, 0, width, height)` runs before
   `drawImage`. `imageOrientation: 'from-image'` stays exactly as it is.
3. Add:

   ```ts
   /**
    * Photos for recipe import: long edge 2048 px, which is enough for handwriting.
    * Gemini's HIGH media resolution bills a photo the same at any size, so larger
    * only costs upload and server memory. White behind transparent PNGs, because
    * JPEG turns transparency black.
    */
   export async function encodeImageForImport(blob: Blob): Promise<EncodedImage>
   ```

   The body is `downscale(blob, IMPORT_MAX_EDGE_PX, '#fff')`, then
   `canvas.toDataURL('image/jpeg', IMPORT_JPEG_QUALITY)`, all inside one
   `try`. Any throw from decoding (for example `createImageBitmap` rejecting a
   HEIC file in desktop Chrome) or encoding, or a data URL that does not start
   with `data:image/jpeg;base64,`, becomes
   `new Error('That image could not be encoded.')`. Return
   `{ mediaType: 'image/jpeg', base64 }` with the prefix removed.

`src/lib/importApi.ts`:

4. `importRecipe(params: { url?: string; text?: string; images?: EncodedImage[] })`
   (type import from `./image`). The body is still `JSON.stringify(params)`.
   The 401 handling and error mapping are unchanged. Callers pass `images`
   only when it is non-empty.
5. Export `MAX_IMPORT_PHOTOS = 4`, `IMPORT_PHOTO_LIMIT_ERROR = 'Up to 4 photos.'`,
   and a pure
   `fitImportPhotos<T>(currentCount: number, picked: readonly T[]): { accepted: T[]; overflow: boolean }`.
   `accepted` is the leading `max(0, MAX_IMPORT_PHOTOS - currentCount)` items
   of `picked`, in order. `overflow` is true when any picked item was dropped.
6. Export client mirrors of the server byte caps,
   `MAX_IMPORT_PHOTO_BYTES = 3 * 1024 * 1024` and
   `MAX_IMPORT_PHOTOS_BASE64_CHARS = 12 * 1024 * 1024 - 64 * 1024` (the body
   cap minus headroom for the JSON wrapper and notes; step 4 caps photo-mode
   notes at 2,000 characters, and the server's body-level 413 remains the
   fallback), plus two messages,
   `IMPORT_PHOTO_TOO_LARGE_ERROR = 'That photo is too large — try a smaller one.'`
   and `IMPORT_PHOTOS_TOTAL_TOO_LARGE_ERROR = 'Those photos are too large together — remove one and try again.'`,
   and a pure
   `checkImportPhotoBytes(current: readonly EncodedImage[], next: EncodedImage): 'ok' | 'photo_too_large' | 'total_too_large'`.
   It returns `photo_too_large` when `next`'s decoded size
   (`base64.length / 4 * 3` minus padding) is over `MAX_IMPORT_PHOTO_BYTES`,
   otherwise `total_too_large` when the sum of `base64.length` over `current`
   plus `next` is over `MAX_IMPORT_PHOTOS_BASE64_CHARS`. The server caps stay
   authoritative; this only turns an after-upload 413 into an at-pick-time
   message.

**Tests** (`src/lib/importApi.test.ts`, node environment, following
`src/lib/sttApi.test.ts`: `vi.stubGlobal('fetch', …)`, `vi.spyOn(session, 'invalidateSession')`):

- `posts photos and notes as JSON`: `importRecipe({ images: [{ mediaType: 'image/jpeg', base64: 'AAAA' }], text: 'notes' })`
  calls `fetch('/api/import', …)` with `method: 'POST'`,
  `credentials: 'same-origin'`, and a JSON body deep-equal to
  `{ images: [{ mediaType: 'image/jpeg', base64: 'AAAA' }], text: 'notes' }`.
  It resolves to the recipe with `tags`, `ingredientSections`, and `steps`
  defaulted to `[]`.
- `sends no images key for text import`: `importRecipe({ text: 'soup' })`
  gives a parsed body without an `images` key.
- `checkImportPhotoBytes`: a photo of exactly `MAX_IMPORT_PHOTO_BYTES`
  decoded is `ok`, and one byte more is `photo_too_large`. With `current`
  totalling `MAX_IMPORT_PHOTOS_BASE64_CHARS - 4` base64 characters, a
  4-character `next` is `ok` and an 8-character `next` is `total_too_large`.
  An oversized `next` with an empty `current` is `photo_too_large`, not
  `total_too_large`. Also assert
  `MAX_IMPORT_PHOTO_BYTES === 3 * 1024 * 1024` and that
  `MAX_IMPORT_PHOTOS_BASE64_CHARS < 12 * 1024 * 1024`.
- `surfaces the server's photo error`: a 413 `{ error: 'Those photos are too large.' }`
  rejects with that message, and `invalidateSession` is not called.
- `invalidates the session on 401`: rejects with
  `Please sign in again — your session expired.`
- `fitImportPhotos`: `(0, [a, b])` gives `accepted [a, b]` with overflow
  false. `(3, [d, e])` gives `[d]` with overflow true. `(4, [e])` gives `[]`
  with overflow true. `(0, [a, b, c, d, e])` gives `[a, b, c, d]` with overflow
  true. `(1, [])` gives `[]` with overflow false.
- `locks the constitution numbers`: `MAX_IMPORT_PHOTOS === 4`,
  `IMPORT_MAX_EDGE_PX === 2048`, `IMPORT_JPEG_QUALITY === 0.85`, and
  `IMPORT_PHOTO_LIMIT_ERROR === 'Up to 4 photos.'`.

`encodeImageForImport` itself is not unit-tested: the node environment has
no canvas, and AGENTS.md rules out DOM libraries. It is covered in the browser
under Verification.

**Acceptance:** `npm test` and `npm run build` pass. In `git diff src/lib/image.ts`,
the bodies of `encodeImageForChat` and `encodeImageForStorage` are unchanged
(they do not pass `background`).

### 4. [ui] Photo picker on the Import screen

Principles: P3, P4, P6 (the 4-photo UI cap).

File: `src/screens/ImportScreen.tsx`. Mirror the attach pattern in
`src/components/ChatPanel.tsx`: a hidden file input, a ref, a `pendingRef` so
async encodes don't read stale state, and the ✕ remove button styling.

State and refs: `photos: { key: string; image: EncodedImage; src: string }[]`
(with a `photosRef` mirror), `encoding: boolean`, and `fileInputRef`. `src`
is the `data:image/jpeg;base64,…` URL, built **once** when the photo is
added, so typing notes does not rebuild multi-megabyte strings on every
render. No object URLs are created, so there is nothing to revoke.

Markup, in the input view (`summary === null && preview === null`), between
the textarea and the bulk checkbox:

- `<input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange=…>`.
  The handler copies `Array.from(e.target.files ?? [])`, then resets
  `e.target.value = ''`.
- A button, styled `${secondaryBtn} mt-3 inline-flex items-center gap-2 px-4 py-2`
  with `CameraIcon` (`h-5 w-5`) and the label **`Add photos`**. It is
  `disabled` when `busy || encoding || bulk || pendingUrls !== null || photos.length >= MAX_IMPORT_PHOTOS`
  (add `disabled:opacity-40`). It is **not** gated on `collections`.
- Hint under the button, `text-sm text-ink-subtle`:
  **`Up to 4 photos, such as handwritten recipe notes. They're only used to read the recipe and aren't saved.`**
- When `photos.length > 0`, show a thumbnail strip in page order,
  `ul.mt-3.flex.flex-wrap.gap-2`. Each item is `li.relative` holding a
  `div.h-20.w-20.overflow-hidden.rounded-lg.bg-surface-muted` with
  `<img src={photo.src} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />`,
  plus the ChatPanel ✕ button with `aria-label={`Remove photo ${i + 1}`}`,
  disabled while `busy`.

Behaviour:

- **Pick:**
  `const { accepted, overflow } = fitImportPhotos(photosRef.current.length, files)`.
  Show `IMPORT_PHOTO_LIMIT_ERROR` if `overflow`, otherwise clear the error.
  Encode `accepted` **sequentially** in pick order with
  `encodeImageForImport`. After each encode, run
  `checkImportPhotoBytes(photosRef.current.map((p) => p.image), encoded)`.
  On `ok`, append it (building `src` then). On `photo_too_large`, skip that
  file and show `IMPORT_PHOTO_TOO_LARGE_ERROR`; on `total_too_large`, skip it
  and show `IMPORT_PHOTOS_TOTAL_TOO_LARGE_ERROR`. On an encode failure, skip that
  file and show **`That photo couldn't be read — try a JPEG or PNG.`**
  (see Decisions, "Undecodable photos"). Later files in the same pick are
  still tried; the last error shown wins. `encoding` is true for the
  duration. `setRetrying(false)`.
- **Remove:** filter by `key`, and clear the error.
- **Bulk checkbox:** add `|| encoding || photos.length > 0` to its
  `disabled`, so bulk cannot be ticked while the first pick is still
  encoding.
- **Textarea placeholder** when `photos.length > 0`:
  **`Optional notes to help read the photos, like the dish name…`**.
  The bulk and default placeholders are unchanged.
- **Textarea length** when `photos.length > 0`: `maxLength={2000}`, so notes
  fit the body headroom; no limit otherwise, as today.
- **Extract button:** enabled when
  `!busy && !encoding && pendingUrls === null && collections !== undefined && (input.trim() !== '' || photos.length > 0)`.
  The label stays `Extract recipe`.
- **`extract()`:** after the existing guard line
  (`inFlight.current || pendingUrls || collections === undefined`) and
  **before** `parseImportInput`, add:
  if `photosRef.current.length > 0`, then `setError(null)`, set `inFlight`,
  `setBusy(true)`,
  `setPreview(await importRecipe({ images: photosRef.current.map((p) => p.image), text: input.trim() || undefined }))`,
  and use the same `catch`/`finally` as the single path, then `return`.
  URL and bulk parsing never run while photos are attached.
- **Busy copy** in photo mode: **`Reading the photos — this takes a few seconds.`**
  Text and URL keep `Reading the recipe — this takes a few seconds.`
- **Preview:** unchanged (`CreateRecipeForm initial={preview}`). Photos stay
  in state if the user cancels the preview, so they can retry, and they are
  dropped on unmount or navigation after save.
- **Never** import `photoStore`, `useObjectUrl`, `encodeImageForStorage`, or
  `remote` in this file. Never pass photos to `recipeStore.create` or
  `CreateRecipeForm` (P3). `runBulk` is unchanged and still calls
  `importRecipe({ url })` only (P4). Screens don't `fetch`; `importApi` does.

**Acceptance:** `npm run build` passes, and `npm test` still passes.
`rg -n "photoStore|useObjectUrl|encodeImageForStorage|fetch\(" src/screens/ImportScreen.tsx`
has no matches. The `importRecipe` call inside `runBulk` still passes
`{ url }` only. The browser checks are under Verification.

### 5. [core] Privacy, terms, README, AGENTS.md

Principles: P3, P9, P11.

Files: `public/privacy.html`, `public/terms.html`, `README.md`, `AGENTS.md`.

- `public/privacy.html`:
  - In **Third parties**, after the Dictate sentence, add: **"Photos you add
    on the Import screen are uploaded to Sous, which sends them to Google's
    Gemini API to extract the recipe. They are not stored and are not
    attached to the saved recipe."** Then add: **"Gemini processes these
    requests on Google's infrastructure, which is not limited to the
    europe-west1 region."** (P9: people are told where it goes.)
  - In **What is stored**, after the sentence ending "There is no on-device
    recipe database.", add: **"Photos used only to import a recipe are not
    kept."**
  - Bump **Last updated** to the implementation date.
- `public/terms.html`, in **Accuracy**, append: **"Recipes read from photos,
  especially handwriting, can have wrong or missing amounts; check them in the
  preview before saving. Those photos are sent to Google's Gemini API to
  extract the recipe and are not stored."** Bump **Last updated**.
- `README.md`:
  - Intro: "one-tap import of recipes from a URL, pasted text, or photos of
    handwritten notes".
  - "How it's put together": `server/importRoute.ts     POST /api/import: URL, pasted text, or up to 4 photos in, recipe draft out`.
  - Add a short paragraph near the extension and import docs: `POST /api/import`
    also accepts `images: { mediaType, base64 }[]` (1–4; `image/jpeg`,
    `image/png`, `image/webp`; ≤ 3 MB decoded each; body ≤ 12 MB, else 413).
    `url` wins, and `text` becomes notes. The browser sends 2048 px JPEGs. The
    photos go to Gemini and are not stored. It is bound by
    `docs/constitutions/image-import.md`.
  - `GEMINI_API_KEY` row: append "Use a key from a **paid-tier** AI Studio
    project: free-tier content may be used to improve Google's products, and
    import sends photos of personal notes."
  - "Your data" paragraph: add that photos added for import are sent to Gemini
    and not stored.
- `AGENTS.md`:
  - Pipeline paragraph: "`importFromHtml` / `importFromSource` /
    `importFromImages` take the Gemini client and model…".
  - Plans table, a new row after `import-blocked-fetch.md`:
    `| \`docs/plans/image-import.md\` | Implementing. Import one recipe from 1–4 photos (handwritten notes) via \`images\` on \`POST /api/import\`; Gemini reads them; never stored. Bound by \`docs/constitutions/image-import.md\`. |`
  - Product copy paragraph: add "Photos sent for import go to Gemini and are
    not stored; `/privacy` and `/terms` say so."

**Acceptance:** `rg -n "Import screen" public/privacy.html` and
`rg -n "not stored" public/terms.html` each match. There is no mention of
IndexedDB or offline, and no claim that Gemini stays in europe-west1. The
existing Resend, Dictate, and invite sentences are intact. `npm test` passes.

### 6. [core] Handwritten eval harness and `evals/ocrCompare.ts`

Principles: P1, P2, P10.

Files: `evals/judge.ts` (new), `evals/handwrittenFixtures.ts` (new),
`evals/recipeImport.eval.ts`, `evals/ocrCompare.ts` (new), `evals/README.md`,
`package.json`.

Nothing here is in `npm test` (default include is `*.test.ts` / `*.spec.ts`),
CI, or the runtime image (`Dockerfile` copies only `api`, `server`, `scripts`,
`dist`). Do not add a `*.test.ts` under `evals/`.

**`evals/judge.ts`** (no vitest import, so plain Node can load it): move
`JUDGE_SCHEMA`, `parseJudgeVerdict`, `judgeOnce`, `judgeRecipe`,
`ingredientCount`, and `isPlainObject` out of `recipeImport.eval.ts`
verbatim. Export `judgeRecipe` and `ingredientCount`. The judge prompt and the
single retry do not change.

**`evals/handwrittenFixtures.ts`:**

```ts
export const HANDWRITTEN_ROOT: string; // <repo>/evals/import-handwritten
export interface HandwrittenFixture { name: string; pages: ImportImage[]; golden: ImportedRecipe }
export function listHandwrittenFixtures(root?: string): HandwrittenFixture[]
```

- A missing root gives `[]`. Only directories count (files such as a README
  are ignored), and names starting with `.` are skipped. Results are sorted by
  name.
- Each fixture directory **must** contain the following. On any violation it
  throws `Error('evals/import-handwritten/<name>: <problem>')`, so a broken
  fixture never skips silently:
  - `page-1.<ext>` … `page-N.<ext>`, with `ext` one of `jpg`, `jpeg`, `png`,
    `webp`, contiguous from 1, and 1 ≤ N ≤ 4. The media type is taken from
    the extension.
  - `golden.json` that `normalizeImportedRecipe` accepts.
  - `source.txt` with a line starting `provenance:` and a line starting
    `permission:` (P10).
- Every JPEG page is rejected if its first 64 KiB contain an `Exif\0\0` APP1
  marker ("strip metadata first": phone EXIF includes GPS, the repo is
  public, and production's canvas re-encode strips it anyway).
- The pages are validated with `checkImportImages` from
  `../server/importRoute.ts`. Anything but `ok` throws with the check's `kind`.
  It also throws `evals/import-handwritten/<name>: pages exceed the request body cap`
  when the sum of the pages' `base64.length` is over
  `MAX_IMPORT_BODY_BYTES - 64 * 1024`. Together these make a fixture what the
  server would accept.

**`evals/recipeImport.eval.ts`:**

- Import the judge from `./judge.ts`. Change `expectCloseToGolden(name)` into
  `expectCloseToGolden(label: string, golden: ImportedRecipe, result: ImportOutcome)`,
  keeping the same servings, ±2-count, and judge assertions. The existing
  suites call it with `readGolden(name)` / `importFixture(name)`, and their
  fixtures, thresholds, and names are unchanged.
- Add, at module scope, `const HANDWRITTEN = listHandwrittenFixtures();`, then:
  - if `HANDWRITTEN.length === 0`:
    `describe('import from handwritten photos (live Gemini)', () => { it.skip('no fixtures in evals/import-handwritten/ — see evals/README.md', () => {}); })`.
    This was checked against vitest 4.1.11: an `it.each([])` inside a
    `describe` fails with "No test found in suite", while this form reports
    `1 skipped`.
  - otherwise: the same `beforeAll` key check as the other suites, then
    `it.each(HANDWRITTEN.map((f) => f.name))('extracts %s from photos close to the golden recipe', …)`,
    calling `importFromImages(fixture.pages, '', recipeImportDepsFromEnv())`
    and `expectCloseToGolden`.

**`evals/ocrCompare.ts`** (a script, run with
`node --env-file=.env.local evals/ocrCompare.ts [fixture…] [--runs=N]`):

- Start with the usual docblock: purpose, how to run it, that it needs
  `GEMINI_API_KEY` for A and ADC for B, that it never runs in CI, and that it
  informs principle 2's "When to revisit" without blocking shipping.
- With `GEMINI_API_KEY` blank: print
  `GEMINI_API_KEY is required. Put it in .env.local (same as dev:api).` and
  exit 1. With no fixtures (after filtering): print
  `No handwritten fixtures in evals/import-handwritten/. See evals/README.md to add some.`
  and exit 0. `--runs` defaults to 1 and is clamped to 1–5.
- **Token capture without changing `RecipeImportDeps` (P7):**
  `recordingDeps(base)` returns `{ deps, usage }`. Its
  `ai.models.generateContent` awaits `base.ai.models.generateContent(params)`,
  pushes `response.usageMetadata` (`promptTokenCount`, `candidatesTokenCount`,
  `thoughtsTokenCount`), and returns the response unchanged.
- **A (production path):** time
  `importFromImages(fixture.pages, '', deps)` with `performance.now()`.
- **B (Vision, then Gemini):**
  - Credentials: once, before the loop,
    `new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })`
    and `await auth.getRequestHeaders(VISION_URL)` (it returns `Headers` in
    google-auth-library 11). If that throws, set the skip reason:
    `no Application Default Credentials. Run gcloud auth application-default login, then gcloud auth application-default set-quota-project cooking-assistant-508423.`
  - `VISION_URL = 'https://eu-vision.googleapis.com/v1/images:annotate'`.
    Make one `POST` per fixture with
    `{ requests: pages.map((p) => ({ image: { content: p.base64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] })) }`,
    using the ADC headers plus `Content-Type: application/json`.
  - On HTTP 401 or 403: set the skip reason to
    `Cloud Vision returned <status> <error.status>. Enable vision.googleapis.com on cooking-assistant-508423 and check the ADC quota project.`
    and skip B for the remaining fixtures. Any other non-OK response, or a
    per-page `responses[i].error`, marks that fixture's B as `vision_error`.
  - Join the pages as
    `responses.map((r, i) => \`Page ${i + 1}:\n${r.fullTextAnnotation?.text ?? ''}\`).join('\n\n')`,
    then time `importFromSource(joined, deps)` separately.
  - Print `Skipping B (Cloud Vision → Gemini): <reason>` exactly once, when
    the reason is first set.
- **Per fixture and run**, record and print (`console.table`):
  - approach;
  - outcome kind;
  - latency in ms (for B: Vision, Gemini, and total);
  - prompt, output, and thinking tokens;
  - Vision units (= pages; 0 for A);
  - estimated USD;
  - judge pass/fail;
  - ingredient and step count deltas against the golden.

  The judge failures (`field: reason`) are printed below the table. Judge
  calls are not counted in cost.
- **Cost constants** (top of the file, commented as estimates carried over
  from the owner-approved plan; `gemini-3.7-flash` is not on the public
  pricing page):
  - `GEMINI_INPUT_USD_PER_MTOK = 1.5`;
  - `GEMINI_OUTPUT_USD_PER_MTOK = 9`, which applies to candidates plus
    thoughts;
  - `VISION_USD_PER_UNIT = 1.5 / 1000`, the list price after the free 1,000
    units a month. The summary prints B's cost both with and without the
    free tier.
- **Summary:** for A and B, the pass count out of runs, median total latency,
  mean cost, and mean prompt tokens per page.
- **Never** print base64, OCR text, or request bodies. Never write result
  files: the output is stdout only, because transcriptions are personal data.
  Exit 0 whatever the judge says. Exit non-zero only for a harness error
  (bad fixture, missing key).
- **`package.json`:** add
  `"eval:ocr-compare": "node --env-file=.env.local evals/ocrCompare.ts"`. It
  mirrors `dev:api`'s `node --env-file=.env.local <file>.ts` form. It is not
  named `test:*`, because it has no pass/fail gate.

**`evals/README.md`**: add an `## evals/import-handwritten/` section covering:

- **Layout:** `<name>/page-1.jpg … page-4.jpg` (or `.jpeg`, `.png`, `.webp`),
  plus `golden.json` (an `ImportedRecipe` of what is actually written, with
  servings `1` if none is written) and `source.txt`.
- **`source.txt` format:** the first lines are `provenance: <whose notes,
  when written, how photographed>` and `permission: <owner's own notes |
  written permission from …, date>`, then `#` notes.
- **Preparation:** pages must look like what the app sends, meaning upright,
  ≤ 2048 px on the long edge, JPEG ~85, and metadata stripped. For example:
  `magick in.heic -auto-orient -resize '2048x2048>' -quality 85 -strip page-1.jpg`.
  The harness rejects EXIF, more than 4 pages, gaps in the numbering, and any
  page `checkImportImages` would refuse.
- **Warning:** this repository is **public**. Committing a fixture publishes
  the photo. Only commit the owner's own notes, or notes with recorded
  permission to publish, and never other people's private notes (P10).
- **Running:** `npm run test:import` runs the handwritten suite, and shows
  `1 skipped` with no fixtures. `npm run eval:ocr-compare` runs the A/B
  comparison. B needs ADC and `vision.googleapis.com` enabled on
  `cooking-assistant-508423`, and is skipped with a message otherwise.

**Acceptance:** `npm run build` type-checks `evals/` (`tsconfig.node.json`
includes it). `npm test` is unchanged in file count. With no fixtures, the
following holds:

- `npm run test:import` reports the handwritten suite as skipped. The other
  suites need `GEMINI_API_KEY`, as before.
- `node --env-file=.env.local evals/ocrCompare.ts` prints the key message if
  the key is blank, or the no-fixtures message and exits 0.

A temporary fixture directory without `source.txt` makes both fail with
`evals/import-handwritten/<name>: missing source.txt`. Delete it afterwards.

## Verification (verifier, after steps 1–6)

This is not an implementation step. The verifier runs it against the whole
branch after steps 1–6.

**Environment**

```
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"   # node >= 22.18; /exec-daemon/node is 22.14
node -v
npm ci            # only if node_modules is stale
npm test
npm run build
```

Both must pass. Then check the following:

```
git diff --stat main...HEAD -- api/ server/extensionImport.ts extension/ scripts/server.ts \
  server/membership.ts server/stt.ts test/fakeGemini.ts src/lib/types.ts \
  src/lib/recipeStore.test.ts src/lib/photoStore.ts src/components/ Dockerfile .github/ vercel.json \
  vitest.config.ts vitest.eval.config.ts                      # must be empty
rg -n "\b(vision|Vision|tesseract|Tesseract|documentai)\b|images:annotate" server src api scripts   # empty (P2)
rg -n "photoStore|useObjectUrl|encodeImageForStorage|fetch\(" src/screens/ImportScreen.tsx         # empty (P3)
rg -n "req\.json\(" server/importRoute.ts                                                         # empty (P6)
rg -n "console\.(log|error)" server/importRoute.ts server/recipeImport.ts                          # only the two count/bytes lines (P3)
git ls-files docs/constitutions/image-import.md                                                  # listed
```

**Live evals** (only if `GEMINI_API_KEY` is set; never print it):
`npm run test:import`. The existing suites keep their pass set (re-run a
single failure once before diagnosing it), and the handwritten suite shows
as skipped. Then run `npm run eval:ocr-compare` and expect the no-fixtures
message with exit 0.

**Browser** (Vite and `dev:api` both running, `dev:api` restarted after the
`server/` changes, signed in at `http://localhost:5173`, not `127.0.0.1`).
Make test images with headless Chrome. Render an HTML recipe card in a
script-style font to a PNG over 2048 px, for example
`google-chrome --headless=new --window-size=1500,2600 --force-device-scale-factor=2 --screenshot=/tmp/page-1.png file:///tmp/card-1.html`,
and make a second page the same way. Use a phone photo with EXIF rotation if
one is available. Go through each of these:

1. **Import, then Add photos, picking 2 pages.** Two thumbnails appear, with
   alt `Photo 1` / `Photo 2` in pick order. The hint text is visible and the
   placeholder switches to the notes copy. In the console, for each
   `img[alt^="Photo "]`, `src` starts with `data:image/jpeg;base64,`,
   `Math.max(naturalWidth, naturalHeight) <= 2048` (and equals 2048 for the
   oversized card), and the base64 length × 3/4 is under 3 MiB. A rotated
   phone photo shows upright.
2. **Bulk is locked out.** The bulk checkbox is disabled while photos are
   attached. Remove both photos and it is enabled again. Tick bulk and
   **Add photos** is disabled.
3. **The 4-photo cap.** Pick 5 files at once: 4 thumbnails, and the error
   `Up to 4 photos.` appears. **Add photos** is disabled at 4. Remove one and
   it is enabled.
4. **Unreadable file.** Pick a `.txt` renamed to `.jpg`, or a HEIC file in
   desktop Chrome. The error
   `That photo couldn't be read — try a JPEG or PNG.` appears and no
   thumbnail is added.
5. **Extract with 2 photos and a note.** Network shows exactly one
   `POST /api/import` with `images` (length 2, `mediaType: "image/jpeg"`),
   `text` set to the note, no `url`, and a request size under 12 MB. Busy copy
   reads `Reading the photos — this takes a few seconds.` The preview shows the
   recipe with no main photo and no gallery photos. Edit a field, then
   **Save**. The recipe opens, and it has no photo. No `POST /api/photos/*`
   occurred at any point. The `dev:api` log shows
   `import images count=2 bytes=…` and no base64.
6. **Photos plus a URL in the notes.** The request still carries `images` and
   `text`, not `url`.
7. **Text import** (paste a recipe) and **URL import** (one link from
   `evals/import-sites/*/sourceUrl.txt`) work as before, with the old
   placeholder and copy.
8. **Bulk import** of 2–3 links works as before and saves without a preview.
9. **Direct API caps** (DevTools console `fetch` while signed in; this is a
   verification probe, not app code):
   - 5 images give 400 `Up to 4 photos.`;
   - `image/gif` gives 400 `Photos must be JPEG, PNG, or WebP.`;
   - a 13 MB body gives 413 `That's too large to import — try fewer photos.`;
   - with no cookie (curl to `:3001`), the response is 401 `{ "error": "Unauthorized" }`.
10. **Pages that share this state:** Library and a recipe's Ask (chat photo
    attach still works), and `/privacy` and `/terms` show the new sentences.

If a precondition is missing (`GEMINI_API_KEY`, Google OAuth credentials,
`ALLOWED_EMAILS`, or ADC for Firestore sync), still run items 1–4. They must
not depend on `collections` or the network. Report each item that could not
be run and the credential it needs, and point the owner to Cursor Dashboard →
Cloud Agents → Secrets. Do not add test hooks or stubs to the app to get
around a missing credential.

**Constitution checklist.** Reject the change if any of these fails, unless
the constitution was amended in the same PR with an Amendments entry (the
numbers can be retuned under its rule 4 without an entry, but they must still
match):

- **P1:** exactly one `generateContent` in `importFromImages`, which uses
  `RECIPE_SCHEMA` (via `RECIPE_OUTPUT_CONFIG`) and the private helper shared
  with `importFromSource`. There is no second normalizer and no new route
  file.
- **P2:** no OCR in `server/`, `src/`, `api/`, or `scripts/` (the `rg`
  check). Vision appears only in `evals/ocrCompare.ts`.
- **P3:** no `photoStore` / GCS / Firestore writes on the photo path. Logs are
  counts and byte sizes only (nothing read from an error), and the logging unit test exists
  and passes.
- **P4:** photos appear in single mode only. Bulk is disabled with photos,
  and Add photos is disabled in bulk. `runBulk` sends `{ url }`. The
  extension files have no diff.
- **P5:** the prompt contains all the pinned substrings, and the prompt test
  exists.
- **P6:** the numbers are 4 (server `MAX_IMPORT_IMAGES` and client
  `MAX_IMPORT_PHOTOS`); 3 MB = `3 * 1024 * 1024` decoded per image;
  ~12 MB = `12 * 1024 * 1024` body with a 413 and no `req.json()`; 2048
  (`IMPORT_MAX_EDGE_PX`); 0.85 (`IMPORT_JPEG_QUALITY`); `imageOrientation: 'from-image'`
  still in `downscale`; `MediaResolution.MEDIA_RESOLUTION_HIGH` in the
  `config`; and types exactly `image/jpeg`, `image/png`, `image/webp`. Each
  appears in code, and each number, the media resolution, and the type list
  are also locked by a unit test (steps 1–3).
- **P7:** the `images` field is optional, `url` wins, and `text` works as
  notes. There is no diff to `ImportOutcome`, `RecipeImportDeps`, `Recipe`,
  `RecipeDraft`, or `src/lib/recipeStore.test.ts`, and the existing route
  tests are unchanged and green.
- **P8:** `withMembership(importPost)` is unchanged, there is no
  `X-Sous-Session` on this route, and `api/import.ts` has no diff.
- **P9:** the README paid-tier note is present, and the privacy page does not
  claim EU-only processing. The owner has confirmed the paid tier, or this is
  recorded as an open owner action in the PR.
- **P10:** the unit tests are pure (fake `deps`, stubbed `fetch`). There is no
  `*.test.ts` under `evals/`, CI is unchanged, and the Dockerfile copies no
  `evals/`.
- **P11:** the privacy and terms sentences are present, and dated the same
  day as the code.

## Follow-ups (not this slice)

- When the owner adds fixtures, run `npm run eval:ocr-compare` and replace
  the estimates in constitution principle 2's **Why** with the measured
  latency and cost (this is a copy change, not an amendment, unless the
  decision changes). `@google/genai`'s doc comment on
  `MEDIA_RESOLUTION_HIGH` says "zoomed reframing with 256 tokens", while the
  constitution estimates about 1,120 tokens per photo. The recorded
  `promptTokenCount` settles it.
- After the verifier passes the branch, switch the AGENTS.md row from
  "Implementing" to "Built … Not deployed", as the other import plans do.

## Open questions

None blocking. The owner needs to act on these; they don't block
implementation:

- **Fixture publication.** The repo (`Bluefire2/cook`) is public, so
  committing `evals/import-handwritten/` photos publishes them. The harness
  and README are built for committed fixtures with a `permission:` line. If
  the owner would rather keep them private, the change is a `.gitignore`
  entry for `evals/import-handwritten/*/`, so the photos stay local and are
  never committed.
- **Paid tier.** The owner needs to confirm that the `GEMINI_API_KEY`
  project is on the paid tier (P9). Code cannot check this.
- **Vision for B.** Approach B needs `vision.googleapis.com` enabled on
  `cooking-assistant-508423` and local ADC with that quota project. Without
  them, B is skipped.
