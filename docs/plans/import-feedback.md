# Import feedback

Status: built on claude/recipe-import-feedback-0eb055, not deployed. TTL policy not applied.

## Goal

When a recipe import goes wrong, the person can send the owner a report with one tap,
without typing anything. "Goes wrong" means either:

- `POST /api/import` returned an error; or
- the import check from PR #103 flagged warnings.

The report bundles three things: the source (the link, or the pasted text), the error,
and what the import returned. A note is allowed, and the card says it is optional.

The preview of a clean import gets a small 👍/👎 row below the form. 👎 opens the same
report card.

Why: the import log line keeps only `origin + pathname` and codes, so the owner cannot
see which link failed or what came out. `docs/plans/import-reliability.md` phase 1 is
blocked on exactly this.

## Out of scope

- The RecipeView warning banner (`src/components/ImportWarningBanner.tsx`).
- The Chrome extension (`extension/`) and `POST /api/extension/import`.
- An `/admin` screen for reports. The owner reads them with a script.
- Emailing the owner about a report.
- Changing `Recipe`, `RecipeDraft`, `ImportRecipeResult`'s fields, the import prompt,
  or the import pipeline (`server/recipeImport.ts`).

## Decisions (final; do not revisit)

1. **Storage.** Reports go in Firestore, in the top-level collection
   `importFeedback/{id}`.
   - **Not under `users/{uid}`:** a report is for the owner, not library data. It must
     never sync, pull, or go into a backup.
   - **Not a log line:** logs are kept free of recipe text by rule, and a report needs
     that text.
2. **Report id.** The client generates the id with `crypto.randomUUID()`, and the
   server writes with `DocumentReference.create()`. A resend after a lost response
   then hits ALREADY_EXISTS. The Admin SDK `@google-cloud/firestore` reports that as
   gRPC `code === 6`, a number. The server treats it as success (204).
3. **Stored document:** `ImportFeedbackDoc`.
   - It holds the full link, as submitted, with `user:pass@` removed.
   - For a paste import it holds the pasted text, capped at 150,000 UTF-8 bytes.
   - For a photo import it holds the photo count only.
   - It holds the error's code, HTTP status, site status, and message.
   - It holds the original extraction as a JSON string (`recipeJson`), capped at
     200,000 UTF-8 bytes. The extraction is kept as a string because a broken one
     would fail draft validation, and broken ones are the reports that matter.
   - It also holds the warning codes, the translation state, an optional comment of
     up to 2,000 characters, and the UI locale.
   - It never holds an email address, photo bytes, or the notes typed with photos.
4. **Lenient validation.** The server rejects a request only when:
   - the body is not an object;
   - `trigger` or `via` is unknown; or
   - `id` is not a UUID.

   Any other malformed field is dropped or truncated, and the report is still
   stored.
5. **👍 stores no document.** It only writes the `import_feedback` log line. The
   import log lines already give the denominator.
6. **Retention.** Each document carries `expireAt`, a JS `Date` that the Admin SDK
   stores as a Timestamp, set to `createdAt + 180 days`.
   - A Firestore TTL policy on `expireAt` deletes expired reports. Setting it up is a
     one-time owner step (Owner steps below), not part of the implementation.
   - An account deletion request covers reports too.
7. **Rate limit.** 20 requests per hour per `sub`, per container instance. It reuses
   `admitTranslateCall` from `server/recipeTranslation.ts`, which is generic, with a
   separate bucket map.
8. **Who sees a card.** A card appears only for an error that `importRecipe` threw
   with a numeric HTTP `status` other than 401 (see `importFailureDetails`).
   That excludes:
   - client-side validation and photo-size messages;
   - an expired session;
   - network errors;
   - in bulk import, `recipeStore.create` and missing-collection failures, and the
     rows filled in after a session expired.
9. **Surfaces:**
   - **Single import fails:** a full card under the error.
   - **Preview with warnings:** a compact card placed right *after* the warning
     notice, as a sibling. It must not go inside the notice, because that notice is
     `role="status"`.
   - **Clean preview:** the 👍/👎 row after the form. 👍 replaces the row with
     "Thanks". 👎 replaces the row with a full card. Only one of the two can be sent.
   - **Bulk summary:** a "Report a problem" text button on failed rows that have
     failure details, and on needs-attention rows. It expands a card inside the row.
10. **Photos.** A report from a photo import never holds the photos or the notes.
    Photo imports run no import check, so only `failed` (count and error) and 👎
    (count and the extraction) apply. This adds a Firestore write that
    `docs/constitutions/image-import.md` principle 3 did not allow, so that principle is
    amended in the same change.
11. **Privacy.** `/privacy` and `/terms` change in the same change.
    - Reports are a new store of recipe text, which i18n principle 14 requires the
      pages to disclose.
    - `import_feedback` is a new log line, and AGENTS.md says those pages change with
      the log lines.

## Owner steps (not for the implementer; recorded so they are not lost)

1. **TTL policy.** Before the first deploy that contains this feature, run
   `gcloud firestore fields ttls update expireAt --collection-group=importFeedback --enable-ttl --project=cooking-assistant-508423`.
   - Confirm it with
     `gcloud firestore fields ttls list --collection-group=importFeedback --project=cooking-assistant-508423`.
   - `gcloud` is at
     `C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`.
     It is not on PATH, and the machine's default project is a different one, so
     always pass `--project`.
   - Until the policy exists, `/privacy`'s 180-day promise is false.
2. **Account deletion request:**
   1. Get the account's `sub` with `node --env-file=.env.local scripts/import-audit.ts <email>`.
   2. In the Firestore console, open `importFeedback`, filter `sub == <sub>`, and
      delete each document.

## Implementation

New:

- `server/importFeedbackShape.ts` and its test: the wire shape, `truncateUtf8`, `feedbackUrl`.
- `server/importFeedback.ts` and its test: `POST /api/import-feedback`.
- `src/lib/importFeedback.ts` and its test: the report builder.
- `src/lib/importFeedbackApi.ts` and its test: `sendImportFeedback`.
- `src/components/ImportFeedbackCard.tsx`, `src/components/ImportFeedbackRating.tsx`.
- `scripts/import-feedback.ts`: read-only owner script.

Edited:

- `src/lib/importApi.ts` (and test): a failed import carries `code`, `status`, `siteStatus`.
- `src/lib/icons.tsx`, `src/components/ImportPreview.tsx`, `src/screens/ImportScreen.tsx`.
- `scripts/server.ts`: the route.
- `server/membership.test.ts`: the `authorizedSub` architecture lock counts the new route's one use, and assertion 5 checks it is wrapped in `withMembership`.
- The four `src/i18n/*.ts` catalogs and `docs/i18n-review/screens.json`.
- `public/privacy.html`, `public/terms.html`, `docs/constitutions/image-import.md`, `AGENTS.md`.
