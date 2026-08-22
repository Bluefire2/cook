# WS-4 — Recipe editor, create-from-scratch, delete

**Branch** `ws-4-recipe-editor` · **Wave** 1 · **Depends on** nothing · **Size** L

Read `CONTEXT.md` first.

## Why this exists

There is no way to edit a recipe by hand. None. The only route to changing a
saved recipe is to ask the AI and apply its proposal, which means a typo in an
extracted ingredient requires a conversation. There is also no way to write a
recipe from scratch — every recipe must come from a URL, pasted text, or a chat
variant — and no way to delete one.

`recipeStore.remove` has existed since the first commit and has never been called
from anywhere.

This was in the original plan and quietly didn't ship. The plan promised the
import screen would show "an editable preview" and would let you "start blank";
neither happened.

You are the foundation for two later workstreams: WS-6 makes the import preview
editable and WS-7 adds photo attachment, both by reusing the form you build. Get
the component contract right and they are small.

## What to build

### `RecipeForm`

A new `src/components/RecipeForm.tsx` implementing the contract in the **Shared
interface contracts** section of `CONTEXT.md`. Read that contract now; it is
fixed, because two other workstreams are written against it.

It must round-trip every `RecipeDraft` field the app actually uses:

- `title`, `description`, `notes` — text
- `servings` — number, minimum 1
- `prepMinutes`, `cookMinutes` — optional numbers; empty means `undefined`, not 0
- `tags` — a list of short lowercase strings
- `ingredientSections` — add and remove sections, each with an optional `name`
  and a list of items; add and remove items within a section
- `steps` — add and remove

Each ingredient item has `quantity` (optional number), `unit` (optional),
`item` (required), `note` (optional). Be careful with the quantity field: an
empty input must produce `undefined`, not `0` or `NaN`. A `NaN` quantity
propagates into `formatQuantity` and renders as `NaN` in cook mode.

Multi-section ingredients are supported by the data model and the extraction
schema but have only ever been exercised with single-section recipes. Your form is
the first thing that will really test them. A recipe with one unnamed section
must not show section-management chrome that implies the user should name it.

Reordering steps and ingredients is genuinely useful but not required. If you add
it, move-up/move-down buttons are the right call — drag-and-drop on iOS Safari
inside a scrolling page is a tar pit. Skip it entirely rather than doing it badly.

`RecipeForm` must not import any store. It takes values in and hands a draft out.
That is what lets WS-6 use it for an unsaved import preview.

### `blankDraft`

A new `src/lib/recipeDraft.ts` exporting `blankDraft()`, per the contract in
`CONTEXT.md`. WS-6 consumes it too.

### The edit screen

A new `src/screens/RecipeEdit.tsx` at route `/recipe/:id/edit`, registered in
`src/App.tsx`. It loads the recipe with the existing `useRecipe(id)` hook, renders
`RecipeForm` seeded from it, and on submit writes through `recipeStore`.

Handle the three states `useRecipe` returns — `undefined` while loading, `null`
for not found, and the recipe — the same way `src/screens/RecipeView.tsx:29-39`
does. Match that pattern; do not invent a new one.

**Preserve fields the form does not edit.** `RecipeDraft` has no `sourceUrl` or
`photoId`, and `recipeStore.save` does a full `put`. If you spread a draft over
the old recipe carelessly you will reintroduce exactly the data-loss bug WS-2 is
fixing on the chat path. Merge explicitly and keep `id`, `createdAt`, `sourceUrl`,
and `photoId`.

Note that `recipeStore.save` overwrites `updatedAt` with `Date.now()` itself, so
do not pass one.

WS-2 owns `src/lib/recipeStore.ts` and may add a narrower merge method. Do not
wait for it and do not edit that file — use `save` and `create` as they exist
today.

### Create from scratch

The Library's `+` button currently goes straight to `/import`. There are now two
ways to add a recipe, so it needs to offer both — importing from a link or text,
and writing one yourself.

A small bottom action sheet is the right pattern here and matches the chat panel's
existing idiom. Reuse route `/recipe/new` or have the edit screen handle a
"create" mode, whichever comes out simpler; just keep `RecipeForm` unaware of the
difference.

On save, navigate to the new recipe.

### Delete

Give each Library card an overflow affordance ("⋯" or similar) revealing **Edit**
and **Delete**. This is also the only entry point to the edit screen in wave 1 —
WS-7 adds the more natural one from inside `RecipeView`.

Deletion must be confirmed. A native `confirm()` is acceptable for a personal
app; an inline two-tap confirm is nicer. Either way, an accidental tap must not
destroy a recipe, because there is no undo and the only backup is a manual JSON
export.

Call the existing `recipeStore.remove(id)`. It deletes the recipe and its chat
messages in one transaction. It does **not** delete the recipe's photos — that
cascade is WS-7's, since photos are its domain. Leave it alone.

Make sure the overflow control does not swallow taps meant for the card's `Link`,
and that it is reachable with a thumb on a phone.

## Files you own

- `src/components/RecipeForm.tsx` *(new)*
- `src/screens/RecipeEdit.tsx` *(new)*
- `src/lib/recipeDraft.ts` *(new)*
- `src/App.tsx`
- `src/screens/Library.tsx`

Nothing else. Specifically: `src/lib/types.ts` is frozen (you need no new types
outside your own files), `src/lib/recipeStore.ts` belongs to WS-2,
`src/screens/RecipeView.tsx` belongs to WS-1, and
`src/screens/ImportScreen.tsx` belongs to WS-6.

## Acceptance criteria

1. Edit an imported recipe's title, an ingredient quantity, and a step; save;
   confirm the changes show in `RecipeView` and survive a reload.
2. Add a second ingredient section with a name, and an item inside it; confirm
   `RecipeView` renders the section heading.
3. Clear a `prepMinutes` field and save — the field is absent afterwards, and
   `RecipeView` renders no stray separator. (`RecipeView.tsx:63-67` handles the
   `·` between prep and cook conditionally; make sure your output doesn't break
   that logic.)
4. Clear an ingredient's quantity and save; cook mode shows the item with no
   quantity, not `NaN` and not `0`.
5. Edit a recipe that was imported from a URL, then inspect the record in
   DevTools → Application → IndexedDB: `sourceUrl` is still present.
6. Write a recipe from scratch and cook from it — the serving scaler and step
   tracking work on it.
7. Delete a recipe: it leaves the library, and its chat messages are gone from
   IndexedDB too.
8. Dismissing the delete confirmation leaves the recipe intact.
9. `npm run build` exits 0.

Test on a narrow viewport (390px) — this is a phone app, and a form with this many
fields is where that stops being automatic.

## Out of scope

No editing from within `RecipeView` (WS-7). No photo attachment (WS-7). No
changes to the import screen (WS-6). No tag autocomplete or a tag picker
sourced from existing recipes. No undo, no trash, no archive. No drag-and-drop
reordering. No autosave or draft recovery — an explicit Save is correct here.
