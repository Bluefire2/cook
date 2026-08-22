# WS-1 — Cook state: crash fix + persistence

**Branch** `ws-1-cook-state` · **Wave** 1 · **Depends on** nothing · **Size** M

Read `CONTEXT.md` first.

## Why this exists

Cook mode is the feature the app was built for, and its state is currently three
plain `useState` calls in `RecipeView`. That causes one crash and one bad
omission, and they are the same fix.

### Problem 1 — applying an AI change can white-screen you mid-cook

Checked ingredients are keyed by position, `` `${sectionIndex}-${itemIndex}` ``,
and the keys are dereferenced with no guard when building chat context:

```202:205:src/screens/RecipeView.tsx
            checkedIngredients: [...checked].map((key) => {
              const [si, ii] = key.split('-').map(Number);
              return recipe.ingredientSections[si].items[ii].item;
            }),
```

Reproduction: open a recipe, tick ingredient 8, open the chat, ask the assistant
to simplify the recipe, tap **Apply**. `recipeStore.save` writes a shorter
recipe, the `useRecipe` live query pushes it, `RecipeView` re-renders with the
chat still open, `items[8]` is `undefined`, and reading `.item` throws. There is
no error boundary anywhere in the app, so the user gets a blank screen with
flour on their hands.

Nothing resets `checked` or `currentStep` when the recipe changes shape, and
nothing resets them when you navigate between recipes either — `saveAsVariant`
navigates to `/recipe/:newId`, which is the same route pattern, so `RecipeView`
does not remount. You land on a new recipe with the previous one's ingredients
ticked, its step highlighted, and `servings` scaled against the wrong baseline.

### Problem 2 — cook progress does not survive anything

```24:27:src/screens/RecipeView.tsx
  const [servings, setServings] = useState<number | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [currentStep, setCurrentStep] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
```

Tap back to the library and return, reload, or get backgrounded long enough for
iOS to discard the tab, and you lose your place. Worse, `vite.config.ts` sets
`registerType: 'autoUpdate'`, so shipping a deploy while someone is cooking
reloads the page under them.

## What to build

Extract cook state into `src/lib/useCookState.ts` and persist it in Dexie, keyed
by recipe.

Implement the `useCookState` contract exactly as specified in the **Shared
interface contracts** section of `CONTEXT.md`. WS-7 will consume it later.

### Storage

Add a `cookState` table in a new Dexie version. Dexie carries unchanged tables
forward, so declare only the addition:

```ts
this.version(2).stores({
  cookState: 'recipeId',
});
```

Store one row per recipe: `recipeId`, `servings`, `currentStep`,
`checkedKeys: string[]`, and `recipeUpdatedAt`. Use a `string[]` on disk and
convert to a `Set` in the hook — do not put a `Set` in IndexedDB.

Follow the architecture rule in `CONTEXT.md`: the UI must not touch `db`. Put the
table access in a `cookStateStore` object. It can live inside
`src/lib/useCookState.ts` rather than getting its own file; this is small enough
that a fourth store file would be noise.

### Staleness

`recipeUpdatedAt` is how you detect that the recipe changed underneath the saved
progress. When the stored `recipeUpdatedAt` does not match `recipe.updatedAt`,
discard the saved `checkedKeys` and `currentStep` and start fresh. That is the
honest behaviour: if the assistant rewrote the ingredient list, the old ticks are
meaningless, and silently remapping them would be worse than clearing them.

Keep `servings` across a recipe edit — it is the user's explicit choice about how
much food they want, not a position into a list.

Independently of that, `checkedItemNames(recipe)` must **never** throw. Skip any
key that no longer resolves to an ingredient, using optional chaining and a
filter. Belt and braces: the `recipeUpdatedAt` check should make stale keys
impossible, but this is the line that currently crashes and it should be
impossible to crash by construction.

### Wiring `RecipeView`

Replace the three `useState` calls with the hook. Keep `chatOpen` as local
`useState` — it is ephemeral UI, not cook progress, and it should not persist.

Two details in the existing render to preserve:

- `effectiveServings` currently falls back to `recipe.servings` when `servings`
  is `null`. The hook should own that default, so `RecipeView` just reads
  `servings` directly.
- The `scale` passed to `ingredientLabel` is `effectiveServings / recipe.servings`
  (`src/screens/RecipeView.tsx:42`). Keep that; the baseline is always the
  recipe's own `servings`.

Replace the crashing block at lines 202-205 with `checkedItemNames(recipe)`.

### Loading

The hook reads from IndexedDB asynchronously. Do not flash un-checked ingredients
and step 1 before the saved state arrives, and do not block the whole screen on
it either — the recipe text should render immediately since that is what someone
reaching for their phone mid-cook wants. Returning the defaults until the row
loads and then swapping is acceptable if the swap is fast enough to be invisible;
if it flickers in practice, gate only the checkmarks and the step highlight.

Use `useLiveQuery` for the read, consistent with every other store in the app.

## Files you own

- `src/screens/RecipeView.tsx`
- `src/lib/db.ts`
- `src/lib/useCookState.ts` *(new)*

Nothing else. In particular `src/lib/types.ts` is frozen — put `CookState` and
the stored-row type in your own new file. `src/components/ChatPanel.tsx` belongs
to WS-2; you pass it a `cookingState` prop exactly as `RecipeView` does today and
its `CookingState` shape in `src/lib/chatApi.ts` does not change.

## Acceptance criteria

1. Tick several ingredients, advance a few steps, change servings, navigate to
   the library, come back — all three are restored.
2. Same three survive a full page reload.
3. Tick ingredient 8 of a long recipe, ask the assistant to shorten it, tap
   **Apply** — no crash, and the now-meaningless ticks are cleared.
4. Use **Save as variant** — the new recipe opens with its own clean state, not
   the previous recipe's.
5. Two recipes hold independent progress at the same time.
6. An existing install with data still opens (the v1 → v2 migration is additive,
   so nothing should need converting — verify against a library that has recipes
   in it, not just a fresh profile).
7. `npm run build` exits 0.

## Out of scope

No error boundary — worth having, but it belongs with a broader resilience pass
and would collide with `src/App.tsx`, which WS-4 owns. No "reset progress"
button. No changes to how the assistant receives cooking state beyond the field
that currently crashes.
