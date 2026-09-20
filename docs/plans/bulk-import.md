# Bulk recipe import

Opt-in bulk URL import on `/import`. Single-URL and paste-text import stay as
they are today: extract → editable preview → Save to library. Bulk is
URL-list only and skips that preview.

No `POST /api/import` contract change. Each URL still uses the existing
one-shot `{ url }` call via `src/lib/importApi.ts`. Gemini request shape and
`maxDuration` stay untouched.

## Goal

1. A **Bulk import** checkbox on the Import screen gates multi-link paste.
2. Without it, a field that is only recipe links (two or more) fails
   validation instead of going down the paste/`{ text }` path.
3. With it, each link is extracted and saved sequentially, then a per-URL
   summary is shown.

## Decisions (locked)

- **Client loop, not a bulk POST.** Sequential `importRecipe({ url })` then
  `recipeStore.create(draft)`. No parallel Gemini calls.
- **Checkbox default off**, not persisted.
- **Whitespace split** (`/\s+/`) after trim. A token is a URL iff it matches
  `^https?:\/\/\S+$` (same regex as today's single-URL path).
- **Kinds:** empty; `singleUrl` (one URL token); `urlList` (two or more URL
  tokens, order preserved, exact-string dedupe); `text` (anything else,
  including mixed prose + links).
- **One URL still previews**, even when the checkbox is on.
- **Cap** `MAX_BULK_IMPORT_URLS = 20` unique URLs.
- **401 stops the loop.** Remaining URLs fail with
  `Please sign in again — your session expired.` Other per-URL errors
  continue.
- **Summary stays on `/import`.** Do not auto-navigate, or the per-URL errors
  disappear. **Back to library** goes home; **Try again** restores only the
  failed URLs.
- **No Recipe schema change.** No `api/import.ts` / Gemini / Vercel edits.

## Steps

### 1. [core] `parseImportInput` / `validateImportInput`

`src/lib/importInput.ts` + `src/lib/importInput.test.ts`. Pure logic only.

`validateImportInput(parsed, bulkChecked)`:

- checkbox **off** + `urlList` → `This looks like several recipe links. Turn on bulk import to extract them all, or paste a single link.`
- checkbox **on** + `text` → `Bulk import only accepts recipe links, one per line.`
- checkbox **on** + `urlList` longer than 20 → `Bulk import is limited to 20 links.`
- checkbox **on** + `singleUrl` / checkbox **off** + `singleUrl` or `text` → ok

### 2. [ui] Checkbox, copy, reject unless checked

`src/screens/ImportScreen.tsx`. Native `<input type="checkbox">` in a
`<label>`. Label **Bulk import**. Hint: `Paste several recipe links. Each is saved to your library without a preview.` Placeholder when checked: `Paste one recipe link per line…`. Button: `Extract recipes` when checked, else `Extract recipe`. Disabled while extracting. On Extract, validate and do not call the API on failure.

### 3. [ui] Sequential extract+save, progress, summary

`urlList` (checkbox on): determinate progress bar filled `current / total`, with copy `Reading recipe 3 of 7 — this takes a few seconds.` After the loop, heading `Imported 4 of 6` or `Couldn't import these recipes` if zero succeeded. Success row: title links to `/recipe/:id`. Failure row: URL + message. Primary **Back to library**. Secondary **Try again** when any failed.

## Out of scope

- Multi-recipe **text** paste
- Changing `api/import.ts` / Gemini / Vercel copies
- Parallel extracts, rate-limit UI, or a bulk POST
- Persisting the checkbox
- Mid-loop cancel
- Editing `docs/workstreams/WS-6-import-preview.md`

## Tests and verification

- Unit: classification + validate matrix in `importInput.test.ts`
- `npm test` and `npm run build`
- Browser (Vite + `dev:api`, signed in at `http://localhost:5173/import`):
  checkbox off + two URLs fails immediately; checkbox on + two real URLs
  saves both and lists them; one URL still previews; recipe text paste still
  previews; mixed prose+links stays paste when unchecked
