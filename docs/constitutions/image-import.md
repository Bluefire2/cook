# Image import constitution

Scope: importing a recipe from photos, typically of handwritten notes. The
feature spans `server/recipeImport.ts` (`importFromImages`),
`server/importRoute.ts` (the `images` field on `POST /api/import`),
`src/lib/image.ts` (`encodeImageForImport`), `src/lib/importApi.ts`,
`src/screens/ImportScreen.tsx` (the photo picker), `evals/import-handwritten/`,
`evals/ocrCompare.ts`, and the photo sentences in `public/privacy.html` and
`public/terms.html`.

This document records what the feature promises and why. It is binding on
future changes, including feature requests that seem unrelated but touch these
files.

## How to change this document

1. Read every principle before changing anything in scope.
2. If a change would break a principle, you may still make it, but in the
   **same change**:
   - edit the principle, or mark it superseded, so the document matches the
     code again;
   - add an entry to the Amendments section: which principle, what it is now,
     why the change is worth the cost the principle was protecting against, and
     what evidence supports it (eval numbers, a user request, an incident);
   - say in the PR description that a principle was amended.
3. A change that breaks a principle without amending it is a bug, even if its
   tests pass. Reviewers and verifiers should reject it.
4. The numbers here (photo count, byte caps, pixel size) must match the code.
   If you tune one, update it here too; that alone is not an amendment.

## Principles

### 1. Photos are one more source in the single import pipeline

Photos go through `server/recipeImport.ts` like URLs and pasted text do.
`importFromImages` makes **one** Gemini call with the photos as `inlineData`
parts and the shared `RECIPE_SCHEMA`. Its response goes through the same
helper as `importFromSource`: JSON parse, the `NOT_A_RECIPE` check, then
`normalizeImportedRecipe`. It returns the existing `ImportOutcome` kinds.

**Why:** the pipeline's rule (see `docs/plans/recipe-import-module.md`) is one
entry module, one cleanup step, and routes that only map outcomes to HTTP.
A separate photo route or a separate normalizer would drift from the other
sources, and the evals would stop covering the code production runs.

### 2. Gemini reads the photos; there is no OCR service in the request path

There is no Cloud Vision, Document AI, Tesseract, or other text-recognition
step before Gemini.

**Why:**
- Cost is a wash. For a personal app, Cloud Vision stays in its free 1,000
  photos per month, and Gemini's image input is about $0.0017 per photo at
  high resolution. Most of the cost is the structured recipe output, which is
  the same either way.
- Latency: an OCR step adds a full network round trip (about 0.5–2 seconds)
  before Gemini can start.
- Accuracy: OCR returns flat text and loses the layout. Recipe cards depend on
  layout: two columns, margin notes, arrows, crossed-out quantities, and `T`
  (tablespoon) against `t` (teaspoon). Gemini sees the photo and can use
  cooking context to read an ambiguous word.
- Operations: no new API to enable, no service-account permissions, no new
  dependency, no second vendor receiving the photos.

**When to revisit:** only on numbers from `evals/ocrCompare.ts` that show
Gemini misreading characters that a dedicated OCR model reads correctly. Even
then, try the hybrid first: send the OCR text **and** the photos to Gemini, so
it keeps the layout. Do not replace the photos with OCR text alone.

### 3. Photos are used for extraction and never stored

The photos exist only for the length of the request. The client does not pass
them to `photoStore`; the server writes nothing to GCS or Firestore; neither
side logs image bytes or base64. Log counts and byte sizes only, as
`server/stt.ts` does.

**Why:** the owner decided this. Handwritten notes are personal, and the
privacy page promises that photos sent for import are not kept. Saving a scan
as the recipe's cover photo is a separate feature. It would change that
privacy promise and would need an amendment here and a copy change.

### 4. A person always reviews a photo import before it is saved

Photo import only happens in single-recipe mode and always ends in the
editable preview (`CreateRecipeForm`). It is not available in bulk import, and
the Chrome extension does not accept photos.

**Why:** handwriting is the least reliable source this app reads, and a
language model tends to fill in plausible text where writing is illegible. The
preview is the safety net. Bulk import and the extension save without review,
so photos must not reach those paths.

### 5. Transcribe faithfully rather than fill in plausible text

The photo prompt tells the model to read pages in the order given, skip
crossed-out text, mark uncertain readings with `(?)`, put tablespoon/teaspoon
doubts in `notes`, and never invent quantities or steps that are not written.

**Why:** a recipe that looks right but has the wrong amount of salt is worse
than one with a visible `(?)`, because the person reviewing it cannot see what
the model guessed. A prompt change that makes output cleaner by removing these
markers breaks this principle.

### 6. Input is capped on both sides

- Client: at most 4 photos. Each is downscaled to 2048 px on the long edge and
  re-encoded as JPEG at quality 0.85, with EXIF orientation applied
  (`imageOrientation: 'from-image'`).
- Server: 1–4 images; `image/jpeg`, `image/png`, or `image/webp`; at most 3 MB
  each once decoded; the request body is read with a cap of about 12 MB and
  rejected with 413 above it, never parsed with an unbounded `req.json()`.
- Gemini: `mediaResolution: MEDIA_RESOLUTION_HIGH`.

**Why:** Gemini charges the same number of tokens per photo at high resolution
(about 1,120) whatever its pixel size, so sending camera originals only costs
upload time and server memory. 2048 px keeps enough detail for handwriting.
EXIF orientation matters because iPhone photos store rotation as metadata, and
a sideways page reads badly. The server caps apply even though the client
already downscales, because members can call the API directly and Cloud Run
instances have limited memory.

### 7. The API change is additive

`POST /api/import` gains an optional `images: { mediaType, base64 }[]` field,
the same shape chat uses. If `url` is present it wins, as before. `text` may
accompany `images` as extra context. There are no new fields on `Recipe` or
`RecipeDraft` (the schema lock test in `src/lib/recipeStore.test.ts` stays
as it is), no new `ImportOutcome` kinds, and no change to `RecipeImportDeps`.

**Why:** existing callers (web import, bulk import, the extension, evals) must
keep working unchanged, and unit tests rely on fake `deps` that implement only
`models.generateContent`.

### 8. Authentication and hosting stay as they are

Photo import uses the same cookie session and `withMembership` gate as the
rest of `/api/import`. It does not use `X-Sous-Session` header auth, and the
Vercel stub `api/import.ts` keeps returning 401.

**Why:** the rules in `AGENTS.md` limit header auth to
`/api/extension/import` and keep Vercel from serving import. A new input type
is not a reason to widen either.

### 9. Data governance is part of the feature

The Gemini API key must belong to a **paid-tier** AI Studio project. Google's
pricing page says free-tier content is used to improve its products; paid-tier
content is not. The Gemini Developer API does not pin processing to
`europe-west1`. If data residency becomes a requirement, the answer is to move
import to Vertex AI in the EU, which is an amendment here, not a quiet change
of endpoint.

**Why:** people photograph notes that may include names, family details, or
handwriting they consider private. They are told where it goes.

### 10. Tests match the rest of the repo

Unit tests cover pure logic with fake `deps`: validation, caps, the order of
parts sent to Gemini, and the mapping from outcomes to HTTP. Live evals
(`evals/import-handwritten/`, `evals/ocrCompare.ts`) stay out of `npm test`,
CI, and the runtime image. Handwritten fixtures are the owner's own notes or
material with recorded permission. Do not add photos of other people's
private notes.

**Why:** `AGENTS.md` keeps CI to `tsc -b` plus `npm test`, with no network
access. Handwritten fixtures are personal data, so they need the same care as
the cached web pages described in `evals/README.md`.

### 11. The privacy copy ships with the feature

`public/privacy.html` and `public/terms.html` say that photos uploaded for
import are sent to Google's Gemini API to extract the recipe and are not
stored. Any change to where photos go, or whether they are kept, updates this
copy in the same change.

**Why:** the privacy page is a promise to users, not documentation, and it
must be true on the day the code ships.

## Deliberately not built

Each of these is a reasonable request. Building one means amending the
principle named.
- Keeping the scan as the recipe's cover photo or in its gallery (principle 3).
- Photo import in bulk mode or through the extension (principle 4).
- A dedicated OCR service in front of Gemini (principle 2).
- Uploading PDFs (principles 6 and 7: new MIME types and new size limits).
- Recognising text in the browser, for example with Tesseract.js (principle 2:
  poor on handwriting, and a large addition to the client bundle).

## Amendments

None yet. Add entries newest first, in this form: date, principle number,
what changed, why the change was worth it, evidence, PR link.
