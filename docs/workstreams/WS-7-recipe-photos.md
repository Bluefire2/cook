# WS-7 — Recipe photos + `RecipeView` integration

**Branch** `ws-7-recipe-photos` · **Wave** 2 · **Depends on** WS-1, WS-2, WS-4 · **Size** M

Read `CONTEXT.md` first. Do not start until WS-1, WS-2 and WS-4 are all merged
into `main`, and rebase on `main` before opening your PR.

You are last in, so you own every remaining integration point and you absorb any
merge conflict. If something here contradicts what is actually on `main` by the
time you start, `main` wins.

## Why this exists

`Recipe.photoId` has been in the type since the first commit
(`src/lib/types.ts:31`) and is never written and never read. `photoStore` is fully
implemented and only ever used for chat attachments. So a recipe cannot have a
photo, in a recipe app, and the Library is a wall of text.

Two smaller things have no better home and are grouped here:

- **The editor is hard to reach.** WS-4 built `/recipe/:id/edit` but could only
  link it from the Library, because `RecipeView.tsx` belonged to WS-1 at the time.
  The natural entry point — editing the recipe you are looking at — is missing.
- **`sourceUrl` is invisible.** It is written on import (`api/import.ts:183`) and
  displayed nowhere, which is why two separate code paths could silently destroy
  it without anyone noticing. WS-2 and WS-4 stopped the destruction; make the
  field visible so a future regression is obvious.

There is also a photo leak to close. `attachPhoto` writes the blob to IndexedDB
before the message is sent (`src/components/ChatPanel.tsx:198-201`). Attach a
photo and then close the sheet, or fail to send, and the blob is stranded forever
with nothing referencing it. `photoStore.remove` exists and has never been called.
Nothing in the app ever deletes a photo, and photos are the only thing here that
can realistically exhaust a device's storage quota.

## What to build

### Attaching a photo to a recipe

Add a photo field to `RecipeForm` (WS-4's component, now yours): pick an image,
show a preview, replace it, remove it.

`RecipeDraft` already carries `photoId`, so the form's existing contract does not
change shape — `initial` brings a `photoId` in and `onSubmit` hands one back.
Callers (`RecipeEdit`, and `ImportScreen` if WS-6 has landed) should not need
changes. Verify that; if a caller does need a change, keep it minimal.

**Downscale before storing.** Camera originals are several megabytes and iOS
IndexedDB quota is finite. `src/lib/image.ts` already downscales for chat via
`encodeImageForChat`, but that returns base64 for the wire, not a `Blob` for
storage. Add a sibling that returns a `Blob`, and share the canvas logic between
them rather than duplicating it. `image.ts` is yours for this.

Storing at around 1280px on the long edge as JPEG matches what chat already does
and is more than enough for a card thumbnail and a header image.

**Replace means delete.** If a recipe's photo is changed or cleared, remove the
old blob via `photoStore.remove`. Otherwise every edit accumulates another
orphan. Be careful about ordering: do not delete the old photo until the new
`photoId` is successfully saved, or a failed save loses both.

### Displaying photos

`RecipeView` gets the photo as a header image above the title. `Library` cards get
a thumbnail. Both use the existing `usePhotoUrl` hook.

One caution on `usePhotoUrl`: it creates an object URL per call and deliberately
never revokes it — see the comment at `src/lib/photoStore.ts:21-25`, which judges
that acceptable "at this app's scale". A Library list creates one per card on every
live-query re-fire, which is a different scale than the two-or-three chat
attachments the comment was written for. Check whether this actually leaks in
practice with a few dozen recipes. If it does, fix it and update that comment,
since it is currently the documented rationale. If it does not, leave both alone.

Recipes without a photo must look deliberate, not broken. Most of the library will
have no photo for a long time, so a text-only card has to remain the clean default
rather than showing an empty grey box.

### `RecipeView` integration

- An **Edit** link to `/recipe/:id/edit`, in or near the header
  (`src/screens/RecipeView.tsx:55-68`). It should not compete with the amber
  "Ask" button, which is the primary action.
- **`sourceUrl`**, when present, as a link to the original page. It belongs near
  the bottom with the notes rather than in the header — it is provenance, not
  something you need mid-cook. Open it in a new tab and treat it as untrusted
  input: it came from whatever the user pasted.

Both of these are small additions to a file WS-1 has restructured around
`useCookState`. Read what is actually there before editing.

### Cascade deletion

`recipeStore.remove` deletes a recipe and its chat messages in one transaction
(`src/lib/recipeStore.ts:32-37`) but not their photos, so deleting a recipe with a
photo and a chat thread full of photos strands all of them. Extend the cascade to
cover the recipe's own `photoId` and the `photoIds` of every chat message being
deleted, in the same transaction.

WS-4 wired the delete button to this method, so fixing it here fixes the whole
path.

### The chat orphan leak

Clean up pending photos in `ChatPanel` that never made it into a message —
sheet closed, send failed, or the user removed the thumbnail before sending.
Removing a pending thumbnail should also remove the blob.

Do not delete photos that belong to a persisted message. Only the pending set.

## Files you own

- `src/screens/RecipeView.tsx`
- `src/screens/Library.tsx`
- `src/components/RecipeForm.tsx`
- `src/components/ChatPanel.tsx`
- `src/lib/photoStore.ts`
- `src/lib/recipeStore.ts`
- `src/lib/image.ts`
- `src/lib/types.ts` — available if you need it, but you probably do not, since
  `photoId` and `photoIds` already exist

## Acceptance criteria

1. Add a photo to a recipe via the editor; it shows in `RecipeView` and as a
   thumbnail on the Library card, and survives a reload.
2. Replace that photo: the new one shows, and the old blob is gone from the
   `photos` table in DevTools → Application → IndexedDB.
3. Remove the photo entirely: the recipe renders cleanly with no gap or broken
   image, and the blob is gone.
4. Attach a multi-megabyte camera original and confirm what lands in IndexedDB is
   a few hundred kilobytes, not megabytes.
5. Recipes with no photo look intentional on both screens, at 390px wide.
6. Delete a recipe that has a photo and a chat thread containing photos; the
   `photos` table has no leftovers from it.
7. Attach a photo in chat, close the sheet without sending, reopen: no orphan in
   the `photos` table.
8. Edit reachable in one tap from `RecipeView`, and it round-trips back.
9. A recipe imported from a URL shows a working source link; a hand-written one
   shows none.
10. Photo survives an AI **Apply** — this is the regression WS-2 fixed on the
    chat path, and now it is finally visible. Confirm it holds.
11. `npm run build` exits 0 and `npm test` passes.

## Out of scope

No multiple photos per recipe, no step-level photos, no gallery. No image cropping
or rotation UI (note that iOS EXIF orientation may need handling for the image to
appear upright — handle it if it is broken, but do not build an editor). No
pulling a hero image from the imported page automatically, tempting as it is —
that means fetching arbitrary remote images server-side, which belongs with the
separate security pass. No storage-quota UI or `QuotaExceededError` handling. No
migration of `Photo.blob` to `ArrayBuffer`, despite WebKit's history with blobs in
IndexedDB; that is a schema change and needs its own decision.
