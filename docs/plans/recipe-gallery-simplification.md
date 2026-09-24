# Simplify gallery photo saving

Keep the existing cover/gallery model, eight-photo cap, validation, backup
support, and deletion cascade. No schema, API, dependency, or deployment changes.

## Steps

1. [core] Keep applyDraft's explicit field mapping and source/photo fallback,
   then delegate to recipeStore.save. Delete its duplicate persistence and
   rollback pipeline; save owns compaction and the update timestamp.
2. [ui] Sequentially encode the selected cover and gallery into temporary blobs
   before registering any photo IDs. A decoding failure shows the existing
   error without requiring photo deletion requests.
3. [ui] Register decoded blobs in order and submit the draft. Preserve cleanup
   of newly registered IDs if registration or submission rejects.

## Verification

- Run photo compaction, recipe schema, draft normalization, and server tests,
  then the full unit suite and production build.
- Browser: create/edit/import with cover and gallery; verify ordering, removal,
  cover display, and AI Apply preservation.
- Browser: valid image followed by unreadable file must show the photo error
  without photo upload/deletion requests. Check rejected submission and retry.
- Use a disposable recipe for signed-in checks because local development uses
  the real backend. Report any unavailable checks explicitly.

## Boundaries

Preserve newer collections work. No upload manager, retry system, migration,
or parallel image processing. No new test infrastructure.

## Implementation results

- All three steps implemented on `codex/simplify-gallery-saving`.
- Full Vitest suite after rebasing onto main: 26 files, 326 tests passed.
- TypeScript project build and Vite production build passed.
- Local app opened in the browser, but the available session was signed out.
  Signed-in create/edit/import, AI Apply, and photo failure/retry checks remain
  unverified. No production deployment performed.
