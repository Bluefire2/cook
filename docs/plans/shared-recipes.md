# Shared recipes (collections, then view ACLs)

Parent: `docs/plans/sous-oauth-db.md` (identity + per-user library).
Predecessor this **explicitly contradicts**: `docs/plans/invitation-flow.md`
goal 4 and `docs/handoff-invitation-only.md` (“No shared or household library
exists and none is invented”). Those docs stay true until **PR 2** lands;
PR 1 is still a private library. PR 2’s docs step rewrites the handoff.

Branch for this plan: `cursor/shared-recipes-plan-cdc9`. Implementation
branches are cut later, one per PR, from `main`.

## Goal (both PRs)

1. A signed-in member can group their recipes into **named collections**
   (folders). Recipes that are not in any named collection live in an
   implicit **default** collection. With zero named collections the library
   at `/` is indistinguishable from today.
2. The owner of a **named** collection can add other already-admitted Sous
   accounts **by email**. Those accounts can **view** that collection’s
   recipes and photos. They cannot edit, delete, import-into, share, or
   move those recipes. The owner’s default collection is never shareable.

Two PRs, in that order. PR 1 is useful on its own.

## Workback

Sharing is “principal B may read owner A’s documents that belong to
collection C”. That sentence has three nouns that do not exist today:

| Noun | Today | Needed before share |
| --- | --- | --- |
| Collection C | One implicit root: every row in `users/{sub}/recipes` | A first-class id, stored under the owner, listing which recipe ids it contains |
| Principal B | `requireMember` only checks “is this session a member?”, then every store path uses `access.sub` | A grant that binds `viewerSub` → `(ownerSub, collectionId)` |
| Read of A’s docs | `syncPull` / `photosGet` / push all hard-code `uid = access.sub` | An authorization helper: session may read `users/{ownerSub}/…` iff a live grant says so |

Working backward from the share end-state:

1. **Photo GET and recipe pull must authorize across `users/` trees.**
   `photosGet` today does `photoDocRef(access.sub, photoId)` and GCS
   `users/${access.sub}/${photoId}`. A viewer cannot see a cover image
   unless PR 2 can take `(photoId, ownerSub)` and prove a grant. The join
   key for that proof is **collection membership of the photo’s recipe**,
   which is a PR 1 document.
2. **Do not copy recipes into the viewer’s tree.** Duplication forks LWW,
   cascade-delete, and photo bytes. Shared rows stay at
   `users/{ownerSub}/recipes/{id}`. The viewer’s pull *reads* them; the
   viewer’s push *must not* `recipe.put` them.
3. **ACL rows are not client LWW push.** If viewers lived on
   `collection.put`, a stale owner device could wipe a share. PR 2 mutates
   grants through owner-only REST; the server writes a reverse index the
   viewer’s pull can see. PR 1 therefore must **not** grow a `viewers[]`
   field on the collection document.
4. **Default/root must not be a share target.** Sharing “the default
   collection” is sharing the whole library. PR 1’s default is implicit
   (no document, no id). PR 2 can only mint grants for a live *named*
   collection id.
5. **Recipe schema stays locked.** `compactRecipe` / `compactRecipeFields`
   drop unknown keys; `src/lib/recipeStore.test.ts` asserts the exact key
   set. Collection membership is **not** `Recipe.collectionId`. PR 1 adds a
   new store kind. That is the extension point PR 2 attaches grants to.

PR 1 ships folders without any share surface. PR 2 does not rewrite
collections; it adds grants, a shared pull, and cross-tree photo GET.

## Why this is not trivial

- **Locality.** Every library document and every GCS object is under
  `users/{session.sub}`. Sharing is the first time a request’s session sub
  and the document’s owner sub diverge.
- **Email vs `sub`.** Membership, recipes, and photos are keyed by Google
  `sub`. The product asks to add people by email. There is no email→sub
  index today (`users/{sub}.email` is written at sign-in; queryable, not
  a dedicated index doc). Grants must be stored by `sub` and only *accept*
  email at the add-API boundary.
- **Schema lock.** Folders are the obvious place to put `collectionId` on
  `Recipe`. That would vanish on save. Do not file a gallery-style
  exception; a new kind is the smaller contract change.
- **Default UX.** `/` is a flat list (`src/screens/Library.tsx`). Folder
  chrome that is always visible would change the product for people who
  never create a collection. PR 1 hides that chrome until at least one
  **owned** named collection exists. PR 2 also shows it when there is a
  live incoming share (a member with an empty owned library must still
  reach shared folders).
- **In-memory library is a single `Map<id, Recipe>`.** Shared recipes must
  not collide with the viewer’s own ids (UUIDs make that a non-issue) but
  they **must** carry origin metadata *beside* `Recipe`, so `recipeStore.save`
  cannot push a shared row as if it were owned. Chat and cook-state stay
  in the viewer’s tree keyed by the same `recipeId`.
- **Chat sends the recipe in the POST body** (`src/lib/chatApi.ts`). Ask
  can run on a shared recipe without a server-side recipe fetch. Apply /
  `update_recipe` / Edit must not.

## Locked decisions

### Both PRs

- **D1. Flat named collections.** No nesting, no collection-in-collection.
- **D2. A recipe belongs to exactly one collection.** Named folders, not
  tags. The **default collection** is the set of live recipes whose id is
  **not** in any live named collection’s `recipeIds`. There is no default
  document and no default UUID.
- **D3. No `Recipe` / `ChatMessage` / `CookStateRow` fields.** No schema-lock
  exception. `src/lib/recipeStore.test.ts` key set stays exact.
- **D4. Tombstones + LWW `updatedAt`** for collection documents, same as
  recipes. Missing collection docs are invisible to another device’s cursor.
- **D5. `uid` from the session only.** Ignore `uid` / `sub` / `ownerSub` in
  push bodies. PR 2’s shared pull uses the session to *find grants*, then
  reads the owner path server-side.
- **D6. No production deploy** in either slice unless asked. No new env
  vars, no new Google scopes, no Auth.js, no polling, no Firestore
  listeners, no conflict-merge UI.
- **D7. Caps.** 50 live named collections per owner. 500 `recipeIds` per
  collection. 20 live grants per collection (PR 2). `recipeIds` length and
  name rules are validated on every `collection.put`. The live-collection
  cap is enforced on **create** only: if there is no live doc at that id,
  the server pages `collections` until it has seen 51 **live** docs or the
  query is exhausted (tombstones do not count; a `limit(51)` mixed page is
  not enough). Reject with push reason `invalid` when 50 live docs already
  exist. A put that updates an existing live doc is not a create. The
  client also refuses create in `collectionStore` before pushing.

### PR 1 only (collections)

- **D8. New store kind `collections`.** Path
  `users/{ownerSub}/collections/{collectionId}`. Live payload:

  ```
  { id, name, recipeIds, createdAt, updatedAt }
  ```

  Tombstone: `{ id, updatedAt, deletedAt }` (plus `serverUpdatedAt` on the
  server, stripped on pull like other kinds). `id` is a UUID. `name` is a
  trimmed non-empty string, max 80 chars. `recipeIds` is an ordered unique
  UUID list, omit-empty-on-compact not required (empty named collection is
  allowed). Unknown keys stripped by `compactCollection`.
- **D9. Push ops** `collection.put` and `collection.delete`. Same
  `MAX_PUSH_OPS` (50) and `MAX_PUSH_BYTES` (1_000_000) envelope.
  `validatePushOp` grows; unknown kinds still reject.
- **D10. Pull grows a `collections` array** on the existing
  `GET /api/sync/pull` body. Cursor tuple kind `collections` is added to
  `StoreKind` / `PullCursor`. Clients with an old cursor still work
  (`decodePullCursor` already ignores unknown keys).
- **D11. Moving a recipe** is one or two `collection.put`s: remove id from
  the source named collection (if any), add to the destination named
  collection (if any). Moving to default = remove from every named
  collection that lists it (in practice one). Client enforces single
  membership; if pull ever shows an id in two live collections, the named
  collection with the lexicographically smallest `id` wins and the other
  listing is ignored until the next owner save. Do not read-all-collections
  inside every server `collection.put`.
- **D12. Delete named collection** = tombstone the collection doc. Recipes
  are **not** deleted; they fall back to default because they no longer
  appear in a live `recipeIds`. PR 1 cascade does not walk recipes. PR 2
  extends delete: the same owner `collection.delete` (or a server hook on
  that tombstone) also tombstones every
  `collections/{id}/grants/{viewerSub}` and the matching
  `incomingShares/{viewerSub}/items/{grantId}` so a deleted folder
  disappears from grantees on the next shared pull. Shared pull also
  skips tombstoned collections even if a grant row is still live (belt).
- **D13. New / import** land in **default**, unless the UI is currently
  inside a named collection. Library `+` links become `/import?c=` and
  `/recipe/new?c=` when `/?c=<uuid>` is set; `RecipeEdit` and
  `ImportScreen` read `c` and pass `{ collectionId }` into
  `recipeStore.create`. Back links keep `c` so the user returns to that
  folder. Missing/unknown `c` → default (omit the extra `collection.put`).
  Server does not infer collection from the URL; the client sends the op.
  ChatPanel “Save as a new recipe” always creates in **default** (no `c`).
- **D14. Folder chrome is conditional (PR 1).** Zero live **owned** named
  collections → Library markup and copy match today’s `/` (search, cards,
  + sheet). ≥1 owned named collection → a switcher (Default + names);
  `/` with no `c` lists owned unfiled recipes; `/?c=<uuid>` lists that
  collection’s `recipeIds` that exist in memory (skip unknown /
  tombstoned). PR 2 extends when chrome appears (D27); PR 1 has no
  incoming shares.
- **D15. No ACL fields, no share UI, no second pull, no photo-path change.**
- **D16. Backups.** Keep `app: 'cook'` and `cook-backup-` filenames. Add
  `version: 3` with a `collections` array of compacted live named
  collections. v1/v2 import still works; imported recipes land in default
  if the file has no collections. Do not export another user’s data (N/A
  until PR 2).

### PR 2 only (view ACLs)

- **D17. View-only.** Grantee may pull and render the collection’s live
  recipes and their **recipe** photos (`photoId` / `galleryPhotoIds`).
  Forbidden: `recipe.put` / `recipe.delete`, `photo` POST/DELETE,
  `collection.put` / `collection.delete`, grant mutations, Edit route,
  delete sheet, import-into-that-collection, Apply on an Ask proposal,
  attaching camera/images on Ask (those `photo` POSTs need a live parent
  in the session tree and would leak viewer bytes into the owner’s
  bucket if ever pointed at `ownerSub`). **Allowed on the viewer’s own
  tree:** `chat.put`, `chat.clearForRecipe`, `cookState.put` for that
  `recipeId` (personal cook session / Ask thread; does not leak to the
  owner). Today `putDoc` requires `readRecipeLive(tx, session.sub,
  recipeId)`; that fails for a shared parent (`recipe-deleted`). PR 2
  changes that check: for chat/cook (not photos), if the owned recipe is
  not live, load live `incomingShares/{session.sub}/items/*`, then the
  owner collection+recipe those grants point at; succeed if any grant’s
  live collection `recipeIds` contains that `recipeId`. **Never** read
  `ownerSub` from the push body (D5). Photo writes stay session-tree +
  live owned parent only.
- **D18. Ask is allowed** on a shared recipe (client already POSTs the
  recipe body to `/api/chat`). Apply is not. **Save as a new recipe**
  (ChatPanel) **is** allowed: it `recipeStore.create`s a viewer-owned
  copy in **default**. Hide Apply and the Ask camera control when origin
  is shared. If Ask should be off entirely, say so before PR 2; it does
  not affect PR 1.
- **D19. Named collections only.** No grant whose `collectionId` is missing
  or tombstoned. Revoking the last grant does not delete the collection.
- **D20. Add by email, store by `sub`.** `POST` body is `{ email }`. Server
  normalizes (trim + lower), looks up `users` where `email == normalized`
  (single-field query; pick the `lastSeenAt` max if more than one). Target
  must be an **owner** (`ALLOWED_EMAILS`) or an **active** `members/{sub}`.
  Fail closed: unknown email, unverified never-signed-in, pending,
  declined, revoked → **404** with a generic “No Sous account with that
  email” (do not distinguish). Adding self → 400. Duplicate live grant →
  200 idempotent. A `members/{sub}` **read throw** (membership unknown) →
  **503**, never 404 — same 401/503 split as `requireMember`. Do **not**
  mint app membership; invitation-flow / invite links stay the only admit
  paths.
- **D21. Grants are server REST, not push ops.**

  ```
  POST   /api/collections/:id/grants     { email }     owner of :id
  GET    /api/collections/:id/grants                   owner of :id
  POST   /api/collections/:id/grants/revoke  { sub }   owner of :id
  ```

  JSON: POST 200 `{ grant: { sub, email, createdAt } }`; GET 200
  `{ grants: [{ sub, email, createdAt }] }` (live only); revoke body
  `{ sub }` → 200 `{ ok: true }`. Not-owner, missing id, or tombstoned
  collection → **404** (never 401/403; `remote.ts` signs the client out
  on those). Cap 20 live grants → **409**. `requireMember` then
  **owner-of-collection** (session sub equals the collection’s tree,
  collection live). Not `requireOwner` (app admin).
- **D22. Firestore for a grant.** One grant per **(collection, viewer)**,
  not one per owner+viewer. Two writes in one transaction:

  1. Forward:
     `users/{ownerSub}/collections/{collectionId}/grants/{viewerSub}` —
     `{ viewerSub, email, collectionId, createdAt, updatedAt }` or a
     tombstone `{ viewerSub, updatedAt, deletedAt }`. Doc id = viewer
     `sub`. This is **not** a `StoreKind`; pull/push never list it.
  2. Reverse index, **top-level**
     `incomingShares/{viewerSub}/items/{grantId}` where `grantId` is
     `${ownerSub}_${collectionId}` — `{ ownerSub, collectionId,
     ownerEmail?, updatedAt, deletedAt? }`.

  Top-level `incomingShares` needs no extra IAM (`roles/datastore.user`
  already covers the DB), same argument as `members` / `accessRequests`.
  Viewer cannot push this collection; only the grant APIs (and collection
  delete cascade, D12) write it.
- **D23. Viewer pull is a second endpoint**, not a silent widening of
  `GET /api/sync/pull`.

  ```
  GET /api/sync/shared?cursor=…
  ```

  Returns `{ changes: { collections, recipes, photos }, cursor, hasMore }`
  for rows the session may view. `syncEngine` runs it after the owned
  pull, merging into memory with origin `shared`. Owned pull stays
  “everything under me”. A 401 still means denied; a 503 still means
  unknown. Empty grants → empty changes, 200.

  **Cursor is a separate codec** from `decodePullCursor`. Google `sub` is
  not a UUID; reusing `isUuid` would drop the cursor and loop `hasMore`.
  Wire: base64url JSON `{ grantId: string, recipeId: string }` where
  `grantId` is `${ownerSub}_${collectionId}` and `recipeId` is a recipe
  UUID (empty strings mean “start of that key”). Do not run this object
  through `decodePullCursor`. Iterate grants with
  `incomingShares/{sub}/items` `orderBy(documentId)`. A page belongs to
  one grant: emit that collection **once**, then recipes after the
  recipe cursor, plus photo metadata only for recipes **on that page**.
- **D24. Photo GET for shared bytes.** Keep `GET /api/photos/:id` as
  “session’s own tree”. Add `GET /api/photos/:id?owner=<ownerSub>`.
  Server:

  - `owner` omitted or `owner === session.sub` → today’s own-tree path.
  - else: `requireMember` + live incoming share whose **live** collection
    lists a **live** recipe whose `photoId` or `galleryPhotoIds` contains
    that photo id. Then read GCS `users/{ownerSub}/{photoId}`.
  - **Do not** authorize via “a live photo doc under the owner with that
    `recipeId`” — that would stream the owner’s Ask/chat attachments.
  - Unauthorized / missing / tombstoned → **404** (never 401/403; those
    sign the client out). Store or grant **read throw** → **503**.

  Client `fetchPhotoBlob` / `usePhotoUrl` / `photoStore.ensureLocal` pass
  `owner` when the recipe origin is shared. `usePhotoUrl(photoId)` has no
  recipe id (Library `CardThumb`): look up the in-memory recipe whose
  `photoId` or `galleryPhotoIds` contains that id, then `recipeOrigins`.
  Shared pull emits photo **metadata** only for those recipe-referenced ids.
- **D25. Origin beside Recipe.** `libraryMemory` holds
  `recipeOrigins: Map<recipeId, { kind: 'own' } | { kind: 'shared', ownerSub }>`
  and `collectionOrigins` analogously. `replaceFromPull` sets `own`;
  shared pull sets `shared` and must not overwrite an `own` row with the
  same id. Stores refuse save/delete when origin is `shared`. Screens
  hide Edit / Delete / Move / Share. **`RecipeEdit`:** if origin is
  `shared` or the id is missing, render the same not-found UI as a
  missing recipe (do not save). Direct `/recipe/:id/edit` is not trusted
  to stay hidden.
- **D26. Legal / handoff.** `/privacy` and `/terms` state that recipes and
  photos in a collection you share are visible to the Google accounts
  whose emails you add. Handoff loses “no shared library”. AGENTS.md
  architecture paragraph grows the new kind + grant rule. Still no
  IndexedDB / offline-library copy.
- **D27. Viewer chrome (PR 2).** Same switcher as D14, no separate Shared
  rail. Chrome appears when the session has **≥1 live owned named
  collection or ≥1 live incoming shared collection** (a member with an
  empty owned library must still reach shared folders). Shared rows in
  the switcher are marked Shared. `/` with no `c` still lists **owned
  unfiled** only.

## Out of scope

- Nested folders, public unlisted links, write ACLs, a single household
  `uid`, sharing one recipe without a named collection, sharing default
  - GIS `id_token` fallback, Auth.js, extra Google scopes
  - Conflict-merge UI (LWW on collection `recipeIds` is the product; last
  array wins)
- Firestore emulator, GCS mock, DOM testing library
- Vercel origin / `api/chat.ts` recipe-ACL (chat is membership-gated and
  body-supplied; do not teach Vercel copies to read grants)
- Changing `app: 'cook'` / `cook-backup-` names
- Production deploy

## Starting state (verified)

- `StoreKind` = `recipes | chatMessages | cookState | photos`
  (`server/store.ts`). Pull loops those four (`server/sync.ts`).
- Push kinds: `recipe.put/delete`, `chat.put`, `chat.clearForRecipe`,
  `cookState.put`, `photo.delete` (`src/lib/pushOps.ts`).
- Recipes live at `users/{sub}/recipes/{id}`. Photos metadata there too;
  bytes at GCS `users/{uid}/{photoId}`. `photosGet` / `photosPost` use
  `access.sub` only (`server/photos.ts`).
- Client library is in-memory (`src/lib/libraryMemory.ts`).
  `syncEngine.pullAll` replaces the maps from owned pull only.
- `Recipe` keys are schema-locked (`src/lib/compactRecipe.ts`,
  `src/lib/recipeStore.test.ts`).
- `/` is `Library.tsx`: search, cards, ⋯ Edit/Delete, + Import/New.
  Routes: `/recipe/:id`, `/recipe/:id/edit`, `/recipe/new`, `/import`
  (`src/App.tsx`).
- Membership: `ALLOWED_EMAILS` owners + `members/{sub}` active. Profile
  email on `users/{sub}` via `upsertUser`. No email index collection.
- Chat POST body includes the full recipe (`src/lib/chatApi.ts`).

## PR 1 — Collections (no sharing)

Ship folders. Leave collection ids and `recipeIds` as the only join key
PR 2 will need. Do not invent grants.

### Files (expected)

| File | Change |
| --- | --- |
| `src/lib/types.ts` | `Collection` type (not a Recipe field). |
| `src/lib/compactCollection.ts` | New. Strip unknown / empty-name reject at validate time. |
| `src/lib/collectionMembership.ts` | New. Pure: default ids, recipes in a collection, move, caps, two-list conflict. |
| `server/store.ts` + test | `StoreKind` += `collections`; compact; `collection.put/delete` validate; cursor. |
| `server/sync.ts` + test | Pull/push the new kind. |
| `src/lib/pushOps.ts` | New ops. |
| `src/lib/remote.ts` + `syncEngine.ts` | Cursor + `applyPullChanges` for collections. |
| `src/lib/libraryMemory.ts` | `collections` map. |
| `src/lib/collectionStore.ts` | New. create/rename/delete/move; `useCollections`, `useCollection`. |
| `src/lib/recipeStore.ts` | After create, optional `collection.put` when `collectionId` argument set. **Do not** put `collectionId` on Recipe. |
| `src/screens/Library.tsx` | Conditional switcher; filter; move sheet; `+` links carry `?c=` when filtering a named collection. |
| `src/screens/RecipeEdit.tsx` | Read `c` on `/recipe/new`; pass `{ collectionId }` into `create`; preserve `c` on back. |
| `src/screens/ImportScreen.tsx` | Same `c` → `create` as RecipeEdit. |
| `src/App.tsx` | No new route. `/?c=` filters; missing/unknown `c` → default. |
| `src/lib/backup.ts` + test | version 3 + collections. |
| `AGENTS.md` | Plans table; mention `collections` kind. |

`compactRecipe` tests must stay byte-identical on the Recipe key set.

### Steps

#### 1. [core] Collection type, compact, membership helpers

`Collection` in `types.ts`. `compactCollection`. Pure
`collectionMembership.ts`:

- `unfiledRecipeIds(recipes, collections)`
- `recipesInCollection(recipes, collection)`
- `moveRecipe(collections, recipeId, dest: 'default' | collectionId)` →
  next collection docs that changed
- cap checks

Unit tests only. No Recipe field.

#### 2. [core] Store kind + push/pull

`StoreKind`, `decodePullCursor`, `validatePushOp`, `isKnownPushKind`,
`applyPushOp`, `docToChange`. Tombstone + LWW via existing `putDoc` /
delete helpers. On `collection.put`, if the existing doc is missing or
a tombstone (create / undelete), run the D7 `limit(51)` live count and
reject over cap. Tests: accept minimal `collection.put`; reject empty
name, >500 ids, non-UUID ids, 51st live create; unknown kind still
`unknown`; cursor round-trip includes `collections`.

#### 3. [core] Client memory + stores

`libraryMemory` map; `applyPullChanges`; `collectionStore` write-through
`pushOps`. `recipeStore.create(data, { collectionId? })` — if named,
push `recipe.put` then `collection.put` (two ops, one `pushOps` call).
Failure rolls back in-memory collection + recipe the same way today’s
save rolls back. `syncEngine` already replaces from pull; include
collections in `replaceFromPull`.

#### 4. [ui] Library: default-identical, then folders

Zero owned named collections: no switcher, no “Default” label, same
empty copy. ≥1 named: switcher (Default + names), current filter from `?c=`. ⋯ menu gains **Move to…** (list
default + named). Header or overflow: New collection (name sheet),
rename, delete collection (confirm: recipes return to default). Inside
a named collection, + links are `/import?c=` and `/recipe/new?c=`;
`RecipeEdit` / `ImportScreen` pass that id into `create` (D13).

Exercise `/`, `/?c=`, `/recipe/new`, `/recipe/new?c=`, `/recipe/:id`,
`/recipe/:id/edit`, `/import`, `/import?c=`. Search filters the
**current** list only.

#### 5. [core] Backup v3 + AGENTS.md

Export live collections. Import v3 restores membership after recipes.
v1/v2 unchanged. Plans table: PR 1 in progress. Do not describe
sharing.

#### 6. [ui] Browser verification (PR 1)

Vite + `dev:api`, `http://localhost:5173` (not `127.0.0.1`). Signed in.

- Fresh library: no folder chrome; create recipe; it shows on `/`.
- Create collection “Dinners”; switcher appears; `/` still has the
  recipe; move it to Dinners; `/` empty of that card; `/?c=` shows it.
- From Dinners, + Import and + New; the new recipe appears in Dinners,
  not on `/`.
- Delete collection; recipe returns to `/`; switcher gone if it was the
  last named collection.
- Refresh / Settings Refresh: membership survives pull.
- Edit/delete/import still work; other routes share the same memory.

### PR 1 status

- [x] 1. [core] Collection type, compact, membership helpers
- [x] 2. [core] Store kind + push/pull
- [x] 3. [core] Client memory + stores
- [x] 4. [ui] Library default-identical, then folders
- [x] 5. [core] Backup v3 + AGENTS.md
- [ ] 6. [ui] Browser verification

## PR 2 — Collection view ACLs

Depends on PR 1 merged. Do not start from a collections branch that
still puts viewers on `collection.put`.

### Files (expected)

| File | Change |
| --- | --- |
| `server/grants.ts` + test | Pure parse/transition; email lookup; transaction. |
| `server/shareAuth.ts` + test | `canViewCollection`, `canViewRecipe`, `canViewPhoto`. |
| `server/store.ts` + test | Chat/cook `putDoc` parent: live owned recipe **or** `canViewRecipe`. Photo writes unchanged (owned live parent only). `collection.delete` cascades grant + incomingShare tombstones (D12). |
| `server/sync.ts` | `syncSharedPull` with **its own** cursor codec (D23). Push still owner-tree only. |
| `scripts/server.ts` | Register grant routes + `/api/sync/shared`. |
| `server/photos.ts` | Optional `owner` query on GET (D24). POST unchanged. |
| `src/lib/remote.ts` | `pullSharedPage`, grant HTTP helpers, `fetchPhotoBlob(id, ownerSub?)`. |
| `src/lib/photoStore.ts` | `ensureLocal` / `usePhotoUrl` pass `owner` from `recipeOrigins`. |
| `src/lib/syncEngine.ts` | Owned pull then shared pull; origins. |
| `src/lib/libraryMemory.ts` | `recipeOrigins` / `collectionOrigins`. |
| `src/lib/collectionStore.ts` | `addGrant` / `listGrants` / `revokeGrant` wrap `remote.ts` (screens must not `fetch`). |
| `src/lib/recipeStore.ts` | save/remove throw if origin shared. |
| `src/lib/backup.ts` | Export only `kind: 'own'` recipes, collections, and `remotePhotoIds` / pending blobs referenced by owned recipes+chat. |
| `src/screens/Library.tsx` | Switcher includes shared (D14); hide mutating actions on shared. |
| `src/screens/RecipeView.tsx` | Hide Edit when shared; Ask stays; no camera. |
| `src/screens/RecipeEdit.tsx` | Shared origin → not-found UI (same as missing id). |
| `src/components/ChatPanel.tsx` | No Apply, no camera on shared; Save-as-new stays (default). |
| `src/App.tsx` | No new routes. |
| `public/privacy.html`, `public/terms.html` | Shared-collection disclosure. |
| `docs/handoff-invitation-only.md`, `AGENTS.md` | Shared named collections exist; still no household `uid`. |

### Steps

#### 7. [core] Grant documents + email lookup + pure authz

`parseGrantDoc`, `addGrantTransition`, `revokeGrantTransition`,
`incomingShareFromGrant`. `lookupSubByEmail` (users query + membership
check). `canViewRecipe(ownerSub, recipeId, grants, collections)` pure
given in-memory snapshots of those docs — keep Firestore IO in a thin
wrapper. Tests: self add rejected; revoked member rejected; tombstoned
collection rejected; photo authorized only via a listed recipe.

#### 8. [core] Owner grant APIs

The three routes in D21. Register in `scripts/server.ts`. Cap 20 → 409.
No Vite special case beyond existing `/api` proxy. Unit tests on
handlers’ decision functions; no emulator.

#### 9. [core] Shared pull + photo GET

`GET /api/sync/shared`: list live `incomingShares/{sub}/items/*`, for
each grant load owner collection (skip tombstone), emit collection +
listed live recipes + photo **metadata** only for those recipes’
`photoId` / `galleryPhotoIds`. Page with D23 `{ grantId, recipeId }`
cursor. `hasMore` required.

`photosGet`: honor `owner` as in D24. POST still session tree only.

`putDoc`: chat/cook parent may be a live owned recipe **or** a live
granted collection listing that `recipeId`, looked up from
`incomingShares/{session.sub}` (never from the body). Photos still
require a live owned parent. Tests cover `recipe-deleted` vs shared-ok
vs photo-still-denied.

#### 10. [core] Client merge + write guards

`syncEngine`: after owned `replaceFromPull`, merge shared changes
without dropping owned maps; set origins. `pushOps` unchanged
(viewer simply does not enqueue recipe ops). Stores throw a dedicated
error if a shared save is attempted. `fetchPhotoBlob` / `photoStore`
pass owner. Backup export **omits** shared recipes, shared collections,
and photo ids that are only referenced by shared recipes (owned chat
attachments of the viewer stay).

#### 11. [ui] Share sheet + viewer chrome

On a **named** collection the owner owns: Share (email field, live
grant list, revoke). Default has no Share. Viewer: D27 chrome (switcher
appears from incoming shares even if they own zero folders); shared
rows marked Shared; cards open `/recipe/:id`; no ⋯ Edit/Delete/Move;
RecipeView has no Edit; ChatPanel Ask yes, Apply no, camera no,
Save-as-new yes (lands in viewer default); cook checkboxes yes.
`/recipe/:id/edit` on a shared id shows not-found. Settings Refresh
pulls shared too. Sign-out clears shared maps.

#### 12. [core] Docs

Privacy, terms, handoff, AGENTS.md. Say: libraries are still per
`sub`; sharing is an explicit named-collection grant by email to an
existing member; photos of those recipes are visible to grantees;
chat/cook on a shared recipe stay in the viewer’s account.

#### 13. [ui] Browser verification (PR 2)

Two members (owner + grantee). `http://localhost:5173`.

- Owner shares “Dinners” with grantee email; grantee Refresh sees it
  read-only, including cover photo; Ask streams; Apply hidden; camera
  hidden; Edit link hidden; `/recipe/:id/edit` is not-found; mutating
  push not issued.
- Unknown email: generic failure, no grant row. Membership-store blip:
  503, not 404.
- Revoke: grantee Refresh drops the collection and photo GET with
  `owner` is 404 (session stays signed in).
- Grantee’s own `/` library unchanged. Owner’s default still unshared.
- Grantee with **no** owned folders still sees the switcher (incoming
  share).
- Owner still edits the shared recipe; grantee sees the update on
  Refresh.
- Save-as-new from Ask creates a recipe in the grantee’s default.
- Routes: `/`, `/?c=`, `/recipe/:id`, `/recipe/:id/edit`, `/settings`.

### PR 2 status

- [ ] 7. [core] Grant documents + email lookup + pure authz
- [ ] 8. [core] Owner grant APIs
- [ ] 9. [core] Shared pull + photo GET
- [ ] 10. [core] Client merge + write guards
- [ ] 11. [ui] Share sheet + viewer chrome
- [ ] 12. [core] Docs
- [ ] 13. [ui] Browser verification

## Confirm before PR 2 (not blocking PR 1)

User LGTM 2026-09-20 on:

- Ask-on-shared is on; Apply is off.
- Default collection cannot be shared; share a named folder instead.
- Grantee must already be an admitted Sous member (no share-email invite
  that also admits them to the app).
- One recipe, one collection (not multi-folder tags).

Also locked in audit: Save-as-new from Ask copies into the viewer’s
default; Ask camera is off on shared recipes.

No other open questions. Implement PR 1 from steps 1–6 without waiting.
