# WS-6 — Editable import preview

**Branch** `ws-6-import-preview` · **Wave** 2 · **Depends on** WS-4 · **Size** S

Read `CONTEXT.md` first. Do not start until WS-4 is merged into `main`, and
rebase on `main` before opening your PR.

## Why this exists

The import screen tells the user to check the extraction, then gives them no way
to act on what they find:

```87:89:src/screens/ImportScreen.tsx
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Check the extraction, then save it to your library.
          </div>
```

The preview renders as static text with two buttons, Discard and Save to library.
So a single wrong quantity means discarding the whole extraction and starting
over, or saving it wrong and fixing it later.

The original plan said twice that this preview would be editable. It shipped
read-only, and nobody noticed.

Extraction is also lossy in a way the preview hides: `tags` are extracted and
saved but never shown, and `notes` is in the schema but not rendered. The user is
asked to verify an extraction while being shown a subset of it.

## What to build

Replace the static preview with `RecipeForm` from WS-4 — see the contract in the
**Shared interface contracts** section of `CONTEXT.md`. It exists precisely so an
unsaved draft can be edited before it is persisted; it holds its own state and
calls no store.

Wiring:

- `initial` is the `ExtractedRecipe` returned by `importRecipe`. `ExtractedRecipe`
  is an alias for `RecipeDraft` (`src/lib/importApi.ts:4`), so it drops straight
  in with no conversion.
- `submitLabel` is `'Save to library'`, preserving the current wording.
- `onSubmit` does what `save` does today: `recipeStore.create(draft)` then
  `navigate('/recipe/' + id, { replace: true })`. Keep `replace: true` — the
  import screen should not sit in the back stack behind the new recipe.
- `onCancel` replaces Discard: clear the preview and return to the input state so
  the user can try a different URL. Keep their original input text so they can
  edit rather than retype it.

Delete the now-dead `ingredientLabel` helper at `src/screens/ImportScreen.tsx:8-16`
and its `formatQuantity` / `Ingredient` imports once the form owns rendering.

Keep the amber banner but reword it — "Check the extraction" made sense when
nothing could be changed. Say something that tells the user they can fix it here.

Two extraction gaps to close, now that a form is doing the rendering: `tags` and
`notes` become visible and editable for free if you pass the whole draft through.
Make sure you are not filtering fields on the way in.

Preserve `sourceUrl`. `api/import.ts:183` attaches it to the extracted recipe, and
it is the only provenance the recipe will ever have. `RecipeForm` does not edit it
and `RecipeDraft` carries it, so it should survive — but verify rather than assume,
because this exact field is silently dropped on two other code paths in the app.

## Files you own

- `src/screens/ImportScreen.tsx`

That is all. `src/components/RecipeForm.tsx` and `src/lib/recipeDraft.ts` are
WS-4's — consume them, do not modify them. If the form is genuinely missing
something you need, say so in your PR rather than patching it locally; WS-7 also
depends on that file and a surprise change there would land on them.

`src/lib/importApi.ts` is frozen. It already backfills `tags`,
`ingredientSections`, and `steps` when the model omits them
(`src/lib/importApi.ts:29-34`), which is enough to hand a safe draft to the form.

## Acceptance criteria

1. Import a real recipe URL, correct a wrong ingredient quantity in the preview,
   save, and confirm the correction is what landed in the library.
2. Add a missing ingredient and an extra step in the preview before saving.
3. Edit the tags in the preview and confirm they show on the Library card.
4. Cancel out of a preview: you are back at the input with your URL still there,
   and nothing was written to IndexedDB.
5. Paste raw recipe text instead of a URL — the same editable preview appears.
6. After saving an imported recipe, check the record in DevTools → Application →
   IndexedDB: `sourceUrl` is set.
7. Import a page that is not a recipe; the existing error path still works and
   still shows the server's message.
8. `npm run build` exits 0, and `npm test` passes.

## Out of scope

No changes to `api/import.ts` — WS-3 owns it and has already adjusted it. No
re-extraction or "try again with the AI" button. No import from photos or from a
share-sheet target. No batch import. No "start blank" entry point from this
screen; WS-4 put that on the Library.
