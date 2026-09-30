---
name: Client state
description: How React reads client state: the one library snapshot and its copy-only-what-changes writes, useSyncExternalStore with stable getters and narrow selectors, subscriptions for everything a render reads, and reducer-driven screen dialogs. Read before changing a libraryMemory write, any store hook, a module-level store that React reads, a store read inside a component's render, or Library's dialogs.
status: ratified
scope:
  - src/lib/libraryMemory.ts (snapshot shape, writes, captureSnapshot/restoreSnapshot)
  - src/lib/useLibrary.ts
  - src/lib/recipeStore.ts (useRecipes, useRecipe, useRecipeAccess, useRecipeSharedBy)
  - src/lib/collectionStore.ts (useCollections, useFullPull)
  - src/lib/chatStore.ts (useChatMessages)
  - src/lib/cookLogStore.ts (useCookLogs, useCookLog)
  - src/lib/useCookState.ts (useCookState)
  - src/lib/photoStore.ts (usePhotoUrl)
  - src/lib/session.ts (subscribeSession, getSessionSnapshot, useSession)
  - src/lib/syncEngine.ts (subscribeSyncStatus, getSyncStatusSnapshot, useSyncStatus)
  - src/agent/store.ts (subscribe, getAgentSnapshot, dispatch)
  - src/lib/libraryFlow.ts
  - src/screens/Library.tsx (dialog state, in-flight delete/leave, missing-collection reset)
  - src/screens/RecipeView.tsx (access and shared-by reads)
  - src/screens/RecipeEdit.tsx (access read)
  - src/screens/CookLogEdit.tsx (access read)
  - scripts/invariants.test.ts (client state checks)
---

# Client state constitution

Status: ratified with the state-management overhaul
([PR #86](https://github.com/Bluefire2/cook/pull/86)).

This document states how client state reaches React and why each rule exists.
It binds any change to the files and concepts in the frontmatter `scope`. For
shared files, only the part named in parentheses is in scope. A change may
break a principle, but only by following **Amending this constitution** in the
same PR. Breaking a principle silently is a defect, even if the tests pass.

The `name` and `description` in the frontmatter are copied word for word into
the index in root `AGENTS.md`, and `scripts/constitutions.test.ts` checks that
they match. If the reach of these rules changes, update `description` and
`scope` and the index in the same PR.

## What this is for

The client keeps the library in memory (`libraryMemory`), plus a few small
module-level stores: the session, sync status, the UI locale and the assistant
thread. Screens read them through hooks. These rules keep three things true:

- A component re-renders when something it shows changes.
- It doesn't re-render when nothing it shows has changed.
- A workflow's state can't drift into a combination the UI never meant to
  allow.

The rules use React's own tools (`useSyncExternalStore`, `useMemo`,
`useReducer`) and no state library.

## Principles

### 1. The library is one snapshot, and `libraryMemory` is its only writer

Recipes, collections, chat, cook state, cook logs, photo state, origins and
the parent-origin sidecars live in one `LibrarySnapshot`. Only functions in
`libraryMemory.ts` replace it, and every replacement goes through `emit`.
Owned rows, shared rows and access are never split into separately published
stores.

**Why:** a shared refresh must publish owned and shared rows together, so an
open shared recipe never disappears mid-refresh (root `AGENTS.md`, Sharing).
Related data, such as a recipe and its origin, or a deleted recipe and its
chat, cook logs and photos, has to change in a single publish. Separate
stores would let a screen render one half of a change without the other.

### 2. Published maps are never mutated; a write copies only what it changes

A write builds new copies of just the maps and sets it changes and spreads
everything else from the current snapshot. It never calls `.set`, `.delete`,
`.add` or `.clear` on a map that is already published. A write that touches
several related maps, such as `removeRecipeLocal`, publishes all of them in
the same snapshot. A write that would change nothing, such as
`cachePhotoBlob` with the same blob, doesn't publish. `cloneMaps` is for
`captureSnapshot`/`restoreSnapshot` rollback only.

**Why:** hooks treat an unchanged reference as unchanged data, so copying an
untouched map makes every consumer re-render and re-derive for nothing. That
was the original problem: one cached photo re-sorted the recipe and
collection lists. Mutating a published map is worse. A consumer that
memoized on it sees stale data, and a rollback that captured it no longer
holds the old state. `scripts/invariants.test.ts` checks both halves in
`libraryMemory.ts`.

### 3. React reads a module-level store only through `useSyncExternalStore` and a stable getter

Every module-level store React reads exposes a `subscribe(listener)` that
returns an unsubscribe function, and a getter. Components read it through
`useSyncExternalStore`, directly or through a hook such as `useSession`,
`useSyncStatus`, `useLocale`, `useLibrarySlice` or `useLibrarySelect`.

The getter returns an object the store already holds, or a primitive. It
never builds a fresh array or object, because React compares results with
`Object.is`, and a new object on every call re-renders forever. A store
replaces its snapshot object when something changes and keeps it otherwise.

There are no subscribe-in-`useEffect` hooks and no dummy counters bumped to
force a render.

**Why:** a subscription made in an effect misses an update that lands between
render and subscribe, and it doesn't work with concurrent rendering. A
counter re-renders without telling React what changed.
`scripts/invariants.test.ts` rejects counter bumps in `src/lib` and
`src/agent`.

### 4. A hook subscribes to the narrowest part it uses

A hook that returns one item selects that item: `useRecipe`, `useCookLog`,
`useCookState`'s row, `usePhotoUrl`'s blob, `useRecipeAccess`,
`useRecipeSharedBy`.

A hook that returns a list subscribes to the maps it's built from and
derives the list with `useMemo`, never inside the getter. Only
`src/lib/useLibrary.ts` subscribes to `libraryMemory` directly; other modules
go through its two hooks.

**Why:** the library changes often (photos arrive, cook progress ticks, chat
streams in). A screen that shows one recipe shouldn't re-render because
another recipe's photo loaded.

A per-recipe chat index or finer selectors wait until a profiler shows they
are needed (see Non-goals).

### 5. Everything a render reads comes from a subscription

A value that decides what a component renders must reach it through a hook
that subscribes to that value. This includes access, whether something is
shared, and who shared it.

Calling a store function such as `recipeStore.isShared` or
`collectionStore.sharedBy` inside render is allowed only when a hook the
component already calls depends on the same map. For this reason
`useRecipes` also depends on `recipeOrigins`, and `useCollections` on
`collectionOrigins`. A single-item screen uses a selector hook instead:
RecipeView, RecipeEdit and CookLogEdit read `useRecipeAccess`, and RecipeView
also reads `useRecipeSharedBy`.

Event handlers may read stores directly, since they run at the moment they
need the value.

**Why:** narrowing subscriptions (Principle 4) removes the accidental
re-renders that used to hide these reads. Once `useRecipe` stopped
re-rendering on every store change, RecipeView's Edit control would have
stopped following a viewer→editor change. A value read during render without
a subscription is a stale value waiting to happen.

### 6. A screen's dialogs are one reducer, with one open sheet that carries its own data

Library's dialogs live in a pure reducer (`src/lib/libraryFlow.ts`). At most
one sheet is open. Each sheet kind carries what its workflow needs:

- the move's recipe id;
- the collection that a create which failed partway already made, so a retry
  reuses it instead of making a second one;
- the leave sheet's collection name, so it can still title itself after the
  collection drops out of the list.

Every open or close changes a `token`. An async handler captures the token
when it starts, and after each `await` it checks the token before it
dispatches **or navigates**. The reducer ignores completions whose token
doesn't match. Side effects (store calls, navigation, clipboard) stay in
handlers, never in the reducer.

State that belongs to a request rather than a dialog, and must outlive the
sheet, stays outside the reducer. Library's `deletingId` and `leavingId`
hold off the missing-collection redirect until the request that removed the
collection settles.

A new dialog in Library, or a new multi-step workflow in another screen,
follows the same pattern.

**Why:** separate booleans let two dialogs be open at once, and they can lose
a workflow's data between steps. A late result from a dialog the user closed
could close a newer dialog or navigate away from where the user now is.
Keeping the reducer pure lets the transitions be unit-tested without a DOM.

### 7. Tests stay pure

As the root `AGENTS.md` requires, tests for these rules run in the node
environment with no DOM testing library:

- store contracts through the exported subscribe and getter pairs
  (`sessionStore.test.ts`, `syncEngine.test.ts`);
- copy-only-what-changes identity and immutability for every write
  (`libraryMemory.test.ts`);
- reducer transitions, including stale tokens (`libraryFlow.test.ts`);
- the grep checks in `scripts/invariants.test.ts`.

Anything that depends on how React re-renders is checked in the browser.

## Known exception

`RecipeView` keeps a `revision` counter that it bumps after its own translate
or show-original actions, so the memoized `recipeForDisplay` rereads
`translationStore`'s cache. That cache has no subscribe function, and
RecipeView is the only component that reads it. This is the one counter left
in the client. It is governed by `docs/constitutions/i18n.md` and predates
this document. If another component starts reading or writing that cache,
give `translationStore` a subscribe function and a getter per Principle 3,
and delete the counter.

## Non-goals (a PR that adds one of these amends this document)

- A state library (Redux, Zustand, MobX, Jotai) (Principles 1–3)
- Splitting the library into separately published stores (Principle 1)
- A per-recipe chat index or other finer selectors, before a profiler shows a
  need (Principle 4)
- A server-rendering snapshot for these stores. The app is a client-only SPA;
  adding server rendering needs its own design.

## Amending this constitution

A change that breaks or relaxes a principle must, in the same PR:

1. Edit the principle so it describes the new rule, keeping the **Why**
   accurate. Don't leave the old text in place with an exception bolted on.
2. Add an entry to the amendment log with the principle number, what changed,
   why the change is worth breaking the original intent, what risk the
   original principle guarded against, and how the new design handles that
   risk.
3. Say in the PR description, under a "Constitution amendment" heading, that
   the PR amends `docs/constitutions/client-state.md`.

A reviewer or verifier who finds a principle broken without an amendment
should treat it as a failing check. Don't loosen an invariant check to get a
change through; amend the principle instead.

## Amendment log

None yet.
