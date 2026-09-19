# Recipe gallery photos (main + secondary)

Parent constraints: `docs/workstreams/WS-7-recipe-photos.md` (single
`Recipe.photoId`; gallery was out of scope), `AGENTS.md` schema lock on
`compactRecipe` / `recipeStore.test.ts`. This plan is the approved exception
that adds one optional Recipe field.

Branch: `cursor/recipe-gallery-267b`, cut from `main`.

## Goal

A recipe still has **one main photo** (`photoId`) used on the library card and
at the top of the recipe. It can also have **secondary photos** shown as a
gallery at the **end** of the recipe (after notes, before the source line).
Edit / new / import use the same form to add or remove gallery photos. Existing
recipes with only `photoId` keep working with no migration.

## Why this is a schema change

`compactRecipe` and `compactRecipeFields` drop unknown keys. A gallery field
added only to TypeScript would vanish on save, push, and pull. Chat already
has `photoIds[]` (max 8); recipe photos stay a **cover FK + gallery FK list**,
not a rename of `photoId`.

## Decisions

- **Keep `photoId` as the cover.** Do not migrate it into `galleryPhotoIds[0]`.
  Library cards and the recipe header keep using `photoId` only.
- **New field `galleryPhotoIds?: string[]`.** Ordered, unique, UUID FKs into
  the existing photos store. Omit the key when empty. Drop any id that equals
  `photoId` (the cover is not also a gallery tile).
- **Cap 8** — same as chat `photoIds`. Gallery photos are not sent to Gemini.
- **Do not add `galleryPhotoIds` (or `photoId`) to `RECIPE_SCHEMA`.** Import
  and `update_recipe` still cannot invent photo FKs. `normalizeRecipeDraft`
  omits both. `applyDraft` preserves `galleryPhotoIds` the same way it
  preserves `photoId` / `sourceUrl`.
- **Photo entity unchanged.** Bytes, GCS path, `POST /api/photos/:id`, and
  `usePhotoUrl` stay per-id. The recipe row only gains more FKs.
- **Cascade already queries `photos` by `recipeId`.** Still collect
  `galleryPhotoIds` from the recipe document (and drop them from in-memory
  maps) so a referenced id is never left behind if metadata `recipeId` is
  missing. Backup attribution walks cover + gallery + chat.
- **No lightbox, no reorder UI, no step-level photos, no auto-import of
  page images.** Add / remove only. Order is append order.

## Starting state

- `Recipe.photoId?: string` is the only recipe photo FK.
- `photoStore.add` is local-only until `recipeStore` POSTs bytes, then
  `recipe.put`.
- `recipeStore.save` / `create` / `applyDraft` upload and replace **one** id.
- `cascadeRecipeDelete` tombstones `photoId`, chat `photoIds`, and every live
  photo with that `recipeId`.
- `RecipeForm` has a single Photo field; `RecipeView` shows one header image.

## Files to change

| File | Change |
| --- | --- |
| `src/lib/types.ts` | `galleryPhotoIds?: string[]` on `Recipe`. |
| `src/lib/recipePhotos.ts` | **New.** Cap, compact, `recipePhotoIds()`. |
| `src/lib/compactRecipe.ts` | Keep compacted gallery when non-empty. |
| `src/lib/recipeStore.ts` | Upload/delete every referenced photo id. |
| `src/lib/recipeStore.test.ts` | Schema lock + gallery compact cases. |
| `src/lib/recipeShape.ts` + test | Validate gallery; omit from AI drafts. |
| `src/lib/libraryMemory.ts` | Drop gallery ids on local recipe remove. |
| `src/lib/backup.ts` | Attribute gallery ids to the recipe. |
| `server/store.ts` + test | Compact, validate ≤8 UUIDs, cascade collect. |
| `src/components/RecipeForm.tsx` | Main photo + gallery field after notes. |
| `src/screens/RecipeView.tsx` | Gallery grid at the end of the body. |
| `docs/workstreams/CONTEXT.md` | Domain model. |
| `AGENTS.md` | Plans table. |

## Steps

### 1. [core] Recipe field, compact, lock tests

- Add `galleryPhotoIds?: string[]` on `Recipe`.
- `src/lib/recipePhotos.ts`: `MAX_GALLERY_PHOTOS = 8`,
  `compactGalleryPhotoIds(ids, coverId)`, `recipePhotoIds(recipe)`.
  Compact: unique, preserve order, drop `''` / cover id, cap 8, return
  `undefined` when empty.
- `compactRecipe` copies `galleryPhotoIds` only via that helper.
- Lock tests: undefined/empty omitted from key set; present array kept;
  cover id and duplicates stripped; cap 8.

### 2. [core] Client write path and guards

- `recipeStore.save` / `create` / `applyDraft`: upload every pending id in
  `recipePhotoIds(next)`; after a successful `recipe.put`, `photo.delete`
  ids that were in `recipePhotoIds(previous)` but not in next.
- `applyDraft` sets `galleryPhotoIds: draft.galleryPhotoIds ?? existing.galleryPhotoIds`.
- `normalizeRecipeDraft` never copies `galleryPhotoIds`. Test it.
- `isUsableRecipe`: if the key is present, value is `string[]`.
- `removeRecipeLocal` drops cover + gallery from pending/remote maps.
- `attributePhotos` maps each gallery id to the recipe id (cover first).

### 3. [core] Server compact, validate, cascade

- `compactRecipeFields` keeps compacted `galleryPhotoIds` (same rules as
  client; empty omitted).
- `validateRecipePut`: if `galleryPhotoIds` is present, array of UUIDs,
  length ≤ 8 (empty allowed; compact drops it).
- `cascadeRecipeDelete`: add live recipe `galleryPhotoIds` into the photo
  id set (in addition to `photoId` and `photos` where `recipeId`).

### 4. [ui] Form: main photo + gallery after notes

- Keep the existing Photo field as the **main** photo (label "Main photo").
- After Notes, a Gallery block: thumbs for stored + newly picked files,
  Remove on each, `+ Photo` while under the cap. File input may be
  `multiple`; extra files past the cap are ignored.
- Encode picked gallery files on submit (same `encodeImageForStorage` +
  `photoStore.add` as the cover). On failed `onSubmit`, `photoStore.remove`
  only the ids created in that submit.

### 5. [ui] Recipe view gallery

- After notes (before the source line), if `galleryPhotoIds` is non-empty,
  render a 2-column grid of images via `usePhotoUrl`. No heading required
  beyond the images; use `alt=""` like the cover.
- Library cards unchanged (cover only).

## Verify

- `npm test` — lock, shape, `validatePushOp` / `compactRecipeFields`.
- `npm run build` — server type gate.
- Browser (Vite + `dev:api`, signed in): add a main photo and two gallery
  photos on a recipe; confirm header vs end-of-recipe; remove one gallery
  photo and save; library card still shows only the cover; AI Apply does
  not wipe gallery.

## Out of scope

Lightbox, drag-reorder, promoting a gallery tile to cover, step-level
photos, scraping a hero image from import URLs, raising the chat photo cap,
backup version bump (`app: 'cook'` / `cook-backup-` unchanged).
