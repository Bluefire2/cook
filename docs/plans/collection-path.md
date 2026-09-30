# Collection path

Named collections open at `/collections/<id>`. The default library stays
`/`. When adding from an owned named collection, import and new-recipe
open at `/collections/<id>/import` and `/collections/<id>/recipe/new`.
Legacy `?c=` URLs are not redirected (see Decision 4): `/?c=<id>` shows the
default library, and `/import?c=<id>` and `/recipe/new?c=<id>` save to the
default collection.

Constitutions: `docs/constitutions/i18n.md` was read and does not apply.
This slice changes no user-facing text and does not touch `src/i18n/`.
Cook log and image import are out of scope. No constitution amendment.

The plans-table row in `AGENTS.md` is already added. Do not add another.
Do not rewrite historical plan docs (`docs/plans/shared-recipes.md` and
the other plans that still say `/?c=`).

## Decisions

1. `libraryHref` in `src/lib/collectionHref.ts` (moved out of
   `collectionStore.ts` so it has no store imports) returns `/` when the
   id is missing or `''`, and `/collections/${encodeURIComponent(id)}`
   otherwise. Chips, create, and move already navigate with
   `libraryHref`, including shared collections. No second href helper.
2. `src/App.tsx` serves `/` and `/collections/:collectionId` from one
   pathless layout route, `<Route element={<Library />}>` with two
   child routes whose element is `null`, so a single `Library` instance
   stays mounted when the user changes chips. Import and new-recipe
   paths are outside that layout. `/collections` and any other
   `/collections/*` path redirect to `/`.
   Server grant routes stay
   `/api/collections/:id/...`. Workbox `navigateFallbackDenylist` in
   `vite.config.ts` already excludes `/api/` and does not match
   `/collections/`; leave it alone. `/collections/:collectionId` stays
   on the SPA fallback.
3. `Library` reads `useParams().collectionId` as the requested id.
   `currentId` is set only when the id matches a loaded collection.
   Once that load came from a successful sync and the id is not among
   the collections, `Library` `replace`-navigates to `/`. The client
   signal for that success is sync status `idle` with `lastSyncedAt`
   set (`missingCollectionAction` in `src/lib/collectionHref.ts`).
   Status `loading`, `error`, or `signedOut`, or `lastSyncedAt === null`,
   stays on the URL and shows the unfiled list, so a slow or failed
   first pull does not send a still-valid collection home. An owned
   delete removes the collection locally before the server answers;
   while that request is in flight the redirect waits, so a failed
   delete can still show its error in the sheet. Amended for issue #58.
   The earlier rule (unknown id stays on the URL and shows the unfiled
   list, with no redirect) made revocation and stale Back look like the
   default library.
4. There are no legacy `?c=` redirects. The first version of this plan
   redirected `/?c=`, `/import?c=`, and `/recipe/new?c=`; that was
   removed on purpose. `Library`, `ImportScreen`, and `RecipeEdit` take
   the collection only from the path and ignore `c`, so an old bookmark
   opens the default library or saves to the default collection.
   Do not add the redirects back.
5. `importHref` and `newRecipeHref` in `collectionHref.ts` mirror
   `libraryHref`. `Library` links use them for an owned named collection.
   `ImportScreen` and `CreateRecipe` read `useParams().collectionId`.
   Back links call `libraryHref(knownCollectionId)`.
6. No new copy. Do not edit `src/i18n/`. No production deploy.
7. Because `Library` stays mounted across `/` and `/collections/:id`, its
   per-collection state must be reset when the path's collection
   changes: open sheets, menu, typed name, errors, and the All
   collections scope (`shownCollectionId` effect in `Library`).
   A save (rename, delete, leave) that finishes after the user moved to
   another collection must not close that collection's sheets, show an
   error in them, or navigate; it compares against `shownCollectionId`.
   The reset runs in `useLayoutEffect` so the old sheet never paints over
   the new collection.
   Rename, delete, leave, and share also reset when the loaded library
   no longer contains the path's id, even though the URL has not changed
   yet. Without that, the sheet is only hidden by its `named &&` guard:
   the flag still swallows Escape, and the sheet reappears if the
   collection comes back. The in-flight owned delete in Decision 3 is
   the exception, so its error still has a sheet if the delete rolls back.
8. Search text and the All collections scope are kept in
   `sessionStorage` under `cook.librarySearch`
   (`src/lib/librarySearchMemory.ts`) so they also survive leaving
   Library for a recipe and coming back. An empty, unwidened view removes
   the key, and `invalidateSession()` clears it so a sign-out or account
   change starts clean.

## Steps

### 1. [core] Href, route, param, test

Files: `src/lib/collectionHref.ts`, `src/lib/collectionHref.test.ts`,
`src/App.tsx`, `src/screens/Library.tsx`.

`libraryHref`:

```ts
export function libraryHref(collectionId: string | undefined): string {
  if (collectionId === undefined || collectionId === '') {
    return '/';
  }
  return `/collections/${encodeURIComponent(collectionId)}`;
}
```

In `src/lib/collectionHref.test.ts`, add `describe('libraryHref')`.
Assert `undefined` and `''` return `/`, and an id returns
`/collections/<encoded id>` (include one id that `encodeURIComponent`
changes, such as `a/b` → `/collections/a%2Fb`). The helper does not
`fetch`. Do not add a DOM test, a router integration test, a Firestore
emulator, or a fake IndexedDB.

Route patterns live in `src/lib/routePaths.ts` and `src/App.tsx` uses
them, so `src/lib/routePaths.test.ts` can check with `matchRoutes` (no
DOM) which paths reach the `Library` layout, that import, new-recipe,
and junk paths stay outside it, and that `libraryHref`, `importHref`, and
`newRecipeHref` build paths the table matches.

In `src/App.tsx`, wrap the two list paths in one pathless layout route:

```tsx
<Route element={<Library />}>
  <Route path="/" element={null} />
  <Route path="/collections/:collectionId" element={null} />
</Route>
```

No enums, no constructor parameter properties.

`Library`: read `useParams().collectionId` (undefined on `/` is the same
as a missing id today). A parent layout route sees the child's params, so
no `useMatch` is needed. Leave the `collections.find` check,
`importHref` / `newRecipeHref` on the add sheet, and the `libraryHref`
navigations as they are.

### 2. [ui] Review manifest routes

Files: `docs/i18n-review/screens.json`, `docs/i18n-review/README.md`.
No component edits and no catalog edits.

In `screens.json`, set `route` to `/collections/:collectionId` on
`share-collection-sheet`, `library-shared-banner`, and
`library-leave-sheet`. In the `library-populated` setup, change the
named-collection URL from `/?c=<id>` to `/collections/<id>`. Leave
every setup that opens import or new-recipe with no collection
(`import-form`, the extract setups, `recipe-new`,
`save-to-collection-sheet`) as it is.

In `docs/i18n-review/README.md`, replace the `route` sentence
`A query such as `?c=` is included when the state is a named collection.`
with `A named collection is `/collections/:collectionId`.` Leave
`Path from `src/App.tsx`.`

Do not run the in-context translation review.

## Verification

From the repo root: `npx tsc -b` and `npm test` (includes
`describe('libraryHref')`).

Browser, `npm run dev` and `npm run dev:api`, `http://localhost:5173`
(Vite may be IPv6-only; do not use `127.0.0.1`). Use an existing
signed-in session. Do not create a collection, recipe, or invite, and
do not sign out.

- `/` is the unfiled library.
- A collection chip (owned and, if one is already listed, shared)
  lands on `/collections/<id>` and lists that collection.
- `/?c=<that id>` shows the default library and does not redirect.
- Type a search, then switch chips: the query stays. Open a recipe and
  press Back: the query and the All collections scope are restored.
  Clear the box, open a recipe, press Back: the box stays empty.
- Open Rename on collection A, then Back to collection B: no sheet is
  open. Sign out: the stored search is gone.
- `/collections/<unknown id>` `replace`-navigates to `/` after a
  successful sync. While that pull is still loading, or if it fails,
  the URL stays and the unfiled list shows.
- From a named collection, Add → Import and Add → New recipe open
  `/collections/<id>/import` and `/collections/<id>/recipe/new`. Back
  links go to `/collections/<id>`. `/import?c=<id>` opens the plain
  import screen. Do not save or extract.
- No production deploy.
