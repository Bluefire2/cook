# Collection path

Named collections open at `/collections/<id>`. The default library stays
`/`. When adding from an owned named collection, import and new-recipe
open at `/collections/<id>/import` and `/collections/<id>/recipe/new`.
Legacy `?c=` on `/`, `/import`, and `/recipe/new` replace-redirect.

Constitutions: `docs/constitutions/i18n.md` was read and does not apply.
This slice changes no user-facing text and does not touch `src/i18n/`.
Cook log and image import are out of scope. No constitution amendment.

The plans-table row in `AGENTS.md` is already added. Do not add another.
Do not rewrite historical plan docs (`docs/plans/shared-recipes.md` and
the other plans that still say `/?c=`).

## Decisions

1. `libraryHref` in `src/lib/collectionStore.ts` returns `/` when the id
   is missing or `''`, and `/collections/${encodeURIComponent(id)}`
   otherwise. Chips, create, and move already navigate with
   `libraryHref`, including shared collections. No second href helper.
2. `src/App.tsx` gains `<Route path="/collections/:collectionId"
   element={<Library />} />`. `/collections` alone redirects to `/`.
   Server grant routes stay
   `/api/collections/:id/...`. Workbox `navigateFallbackDenylist` in
   `vite.config.ts` already excludes `/api/` and does not match
   `/collections/`; leave it alone. `/collections/:collectionId` stays
   on the SPA fallback.
3. `Library` reads `useParams().collectionId` as `requestedId`. An
   unknown or missing id still shows the default unfiled list and does
   not redirect away. `currentId` is still set only when the id matches
   a loaded collection.
4. Old bookmarks are a client redirect, only on `/`. When `c` is
   present, replace-navigate with `libraryHref`: a non-empty id goes to
   `/collections/<encoded id>`, and empty `c` goes to `/` and drops the
   query. `c` is the only search param `Library` reads, so redirect the
   whole `/?c=` URL and do not keep other params. Use `replace` so Back
   does not return to `/?c=`. `/import?c=` and `/recipe/new?c=` redirect
   to `importHref` / `newRecipeHref` the same way.
5. `importHref` and `newRecipeHref` in `collectionStore.ts` mirror
   `libraryHref`. `Library` links use them for an owned named collection.
   `ImportScreen` and `CreateRecipe` read `useParams().collectionId`.
   Back links call `libraryHref(knownCollectionId)`.
6. No new copy. Do not edit `src/i18n/`. No production deploy.

## Steps

### 1. [core] Href, route, param, redirect, test

Files: `src/lib/collectionStore.ts`, `src/lib/collectionStore.test.ts`,
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

In `src/lib/collectionStore.test.ts`, add `describe('libraryHref')`.
Assert `undefined` and `''` return `/`, and an id returns
`/collections/<encoded id>` (include one id that `encodeURIComponent`
changes, such as `a/b` → `/collections/a%2Fb`). The helper does not
`fetch`. Do not add a DOM test, a router integration test, a Firestore
emulator, or a fake IndexedDB.

In `src/App.tsx`, add the collection route next to `/`. Keep `/` as
the default library. Redirect only that route:

```tsx
function LibraryAtRoot() {
  const [params] = useSearchParams();
  const legacy = params.get('c');
  if (legacy !== null) {
    return <Navigate to={libraryHref(legacy)} replace />;
  }
  return <Library />;
}
```

`legacy === null` means `c` is absent (`/` stays). `''` is present and
`libraryHref` returns `/`. Import `Navigate` and `useSearchParams` from
`react-router-dom`, and `libraryHref` from `src/lib/collectionStore.ts`.
No enums, no constructor parameter properties.

`Library`: drop `useSearchParams` for the collection id. Read
`useParams().collectionId` (undefined on `/` is the same as a missing id
today). Leave the `collections.find` check, `importHref` /
`newRecipeHref` on the add sheet, and the `libraryHref` navigations as
they are.

### 2. [ui] Review manifest routes

Files: `docs/i18n-review/screens.json`, `docs/i18n-review/README.md`.
No component edits and no catalog edits.

In `screens.json`, set `route` to `/collections/:collectionId` on
`share-collection-sheet`, `library-shared-banner`, and
`library-leave-sheet`. In the `library-populated` setup, change the
named-collection URL from `/?c=<id>` to `/collections/<id>`. Leave
every setup that only says to open import or new-recipe with no `?c=`
query (`import-form`, the extract setups, `recipe-new`,
`save-to-collection-sheet`). That query stays.

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
- Visiting `/?c=<that id>` replace-navigates to `/collections/<id>`.
  Back does not return to `/?c=`.
- Visiting `/?c=` replace-navigates to `/` with no query.
- `/collections/<unknown id>` stays on that URL and shows the unfiled
  list after collections load.
- `/import?c=<id>` and `/recipe/new?c=<id>` replace-navigate to
  `/collections/<id>/import` and `/collections/<id>/recipe/new`. Back
  links go to `/collections/<id>`. Do not save or extract.
- No production deploy.
