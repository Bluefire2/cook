# Shared context for all workstreams

Read this once, then read your own `WS-*.md` brief. Together they should be
everything you need. You do not need to read the other workstream briefs.

## What the app is

`cook` is a personal, single-user recipe book that runs as an installed PWA on
the owner's iPhone. It exists because cooking from a generic LLM chat UI is
clunky: the owner wants a readable recipe view with a cooking assistant attached
to it, plus one-tap import of recipes from the web.

It is deployed at <https://cook-seven-mu.vercel.app> and is live and working.
Repo: <https://github.com/Bluefire2/cook>.

The whole app is ~1,800 lines. It was built in one session and is deliberately
small. **Do not add abstraction it doesn't need.**

## Stack

- Vite 6 + React 19 + TypeScript 5.8, React Router 7
- Tailwind CSS v4 (via `@tailwindcss/vite`, no `tailwind.config.js`)
- Dexie 4 (IndexedDB) for all persistence, with `dexie-react-hooks`
- Two Vercel serverless functions in `api/` calling the Anthropic SDK
- `vite-plugin-pwa` for the service worker and manifest

## Layout

```
api/chat.ts            streaming Claude proxy + the update_recipe tool
api/import.ts          URL fetch, JSON-LD extraction, Claude fallback
scripts/dev-api-server.ts  local stand-in for Vercel functions (port 3001)
src/App.tsx            four flat routes, no layout wrapper
src/screens/           Library, RecipeView, ImportScreen, Settings
src/components/        ChatPanel.tsx (also holds ProposalCard, MessageBubble)
src/lib/               types, db, the three stores, and small helpers
```

## Architecture rules (non-negotiable)

1. **UI code never touches `db` directly.** Everything goes through
   `recipeStore` / `chatStore` / `photoStore` in `src/lib/`. `src/lib/db.ts`
   says so in a comment, and the rule is currently unbroken. It exists so a
   future move to server storage stays contained to the stores. Keep it.
2. **Server state comes from `useLiveQuery`.** Screens call hooks like
   `useRecipes()`, `useRecipe(id)`, `useChatMessages(recipeId)`. Writes go
   through store methods and the live queries re-fire on their own. There is no
   cache invalidation logic and there should not be. Do not add a global store,
   Context, or reducer.
3. **The Anthropic API key never reaches the client.** It is read implicitly by
   `new Anthropic()` inside `api/`. There is no `VITE_`-prefixed env var and
   there must never be one.

## Commands

```bash
npm install
npm run dev       # Vite on :5173 — this alone does NOT give you working AI features
npm run dev:api   # the api/ handlers on :3001, proxied at /api — needs .env.local
npm run build     # tsc -b && vite build
```

Local dev needs **both** servers. `npm run dev:api` requires Node ≥ 22.18 (it
relies on native TypeScript type stripping) and a `.env.local` file. A
`.env.local` already exists on the owner's machine; if you are in a fresh
checkout and don't have one, AI features will 401 or 500 and that is expected —
it does not block any workstream except where a brief says otherwise.

Env vars, all server-side only: `ANTHROPIC_API_KEY`, `APP_PASSWORD`, and
optional `CHAT_MODEL` (defaults to `claude-sonnet-4-5`).

## Verification bar

`npm run build` must exit 0 when you are done. It currently does — confirmed
with a forced clean `tsc -b --force`. If you break it, you own the fix.

There is **no test runner and no linter** in the repo right now. WS-3 adds
Vitest. If your brief says WS-3 is already merged, also run `npm test`.

There is no CI until WS-3 lands, so nothing catches you but yourself.

## Code conventions

Match the surrounding code; it is internally consistent.

- 2-space indent, single quotes, trailing commas, ~80 columns
- Named exports for helpers, `export default` for screens and components
- `import type { ... }` for type-only imports (`verbatimModuleSyntax` is on)
- All three tsconfigs run `strict`, `noUnusedLocals`, `noUnusedParameters`
- Comments explain **why**, never what. The existing ones are good models —
  see `src/lib/db.ts:20-24` and `src/lib/photoStore.ts:21-25`. Do not add
  comments narrating your change or justifying it to a reviewer.
- Tailwind utility classes inline; the palette is stone for text and neutrals,
  amber for accents, on a `#faf7f2` cream background

## Domain model

`src/lib/types.ts` is the source of truth. A `Recipe` has `id`, `title`,
optional `description` / `sourceUrl` / `notes` / `photoId`, `servings`,
optional `prepMinutes` / `cookMinutes`, `ingredientSections` (each an optional
`name` plus `items`), `steps`, `tags`, `createdAt`, `updatedAt`.
`RecipeDraft` is `Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>` and is what
extraction and AI modification produce.

Photos are normalised into their own table and referenced by id: `Recipe.photoId`
and `ChatMessage.photoIds`.

**A trap worth knowing:** the `update_recipe` / `save_recipe` JSON schema in
`api/chat.ts:6-55` and `api/import.ts:6-55` is a byte-identical duplicate, and
neither copy has any compile-time relationship to `RecipeDraft`. It deliberately
omits `id`, `createdAt`, `updatedAt` — but it also omits `sourceUrl` and
`photoId`, which is the root of a live data-loss bug (see WS-2). If you add a
field to `Recipe`, there are **three** places to update.

## Shared interface contracts

These are agreed up front so parallel workstreams can code against each other
without renegotiating. If you own one, implement it exactly. If you consume one,
assume it exists and do not redesign it.

### `useCookState` — owned by WS-1, consumed by WS-7

```ts
// src/lib/useCookState.ts
export interface CookState {
  servings: number;
  currentStep: number;
  checkedKeys: ReadonlySet<string>;
}

export interface CookStateApi extends CookState {
  setServings: (n: number) => void;
  setCurrentStep: (i: number) => void;
  toggleChecked: (key: string) => void;
  /** Ingredient item names for the checked keys, skipping stale ones. */
  checkedItemNames: (recipe: Recipe) => string[];
}

/** Persisted per recipe. Resets when the recipe's shape changes. */
export function useCookState(recipe: Recipe | null | undefined): CookStateApi;
```

`checkedKeys` entries stay in the existing `` `${sectionIndex}-${itemIndex}` ``
format so `RecipeView`'s render logic does not have to change shape.

### `RecipeForm` — owned by WS-4, consumed by WS-6 and WS-7

```ts
// src/components/RecipeForm.tsx
export default function RecipeForm(props: {
  /** Starting values. Use a blank draft for create-from-scratch. */
  initial: RecipeDraft;
  /** Label for the primary button, e.g. 'Save' or 'Save to library'. */
  submitLabel: string;
  onSubmit: (draft: RecipeDraft) => void | Promise<void>;
  onCancel: () => void;
}): React.ReactElement;
```

It is a controlled-internally, uncontrolled-externally form: it holds its own
draft state seeded from `initial`, and hands the finished draft to `onSubmit`.
It must round-trip every `RecipeDraft` field the app uses, including
multi-section ingredients and tags. It must **not** call any store itself —
persistence is the caller's job.

### `blankDraft` — owned by WS-4, consumed by WS-6

```ts
// src/lib/recipeDraft.ts
export function blankDraft(): RecipeDraft;
```

One empty ingredient section with one empty item, one empty step, `servings: 2`,
empty tags. Used for create-from-scratch and as a fallback.

## Out of scope for every workstream

Do not do these unless your brief explicitly assigns them:

- Server storage, sync, or multi-device. It was considered and deliberately
  deferred; the owner's words were *"I want to be able to prototype fast,
  without blocking on setting up neon postgres."*
- Auth, route guards, or rate limiting. The `APP_PASSWORD` is a shared secret
  that stops strangers burning Anthropic credits, nothing more. A separate
  security pass is planned and is not yours.
- Deduplicating the `RECIPE_SCHEMA` between the two `api/` files.
- Reworking the visual design, the colour palette, or the bottom-sheet chat
  layout.
- Renaming or moving existing files.
- Touching any file your brief does not list as yours. This is what keeps the
  parallel workstreams mergeable.
