# Shared access hardening — PR #23 follow-up

Parent: `docs/plans/shared-recipes.md` (PR 2 view ACLs).
Branch: `cursor/shared-collections-cdc9` (PR #23).

## Goal

Close the remaining authorization, sync-partial-failure, and grant-request
gaps before PR #23 merges, without changing the sharing product:

- shared named collections remain view-only;
- the session determines the viewer, and stored incoming-share documents
  determine the owner; client bodies never supply a trusted `ownerSub`;
- no fields are added to `Recipe`, `ChatMessage`, or `CookStateRow`;
- the Vite SPA keeps library network IO in `remote.ts` / `syncEngine.ts`, and
  `collectionStore` remains the wrapper around grant REST;
- tests stay pure/in-memory with injected dependencies: no Firestore emulator,
  GCS mock, or DOM testing library;
- Node code remains compatible with `erasableSyntaxOnly` (no enums or
  constructor parameter properties).

## Required behavior

| Finding | Required result |
| --- | --- |
| #1 | `buildSharedPullPage` and `sessionCanViewOwnerPhoto` have explicit dependency seams and meaningful authorization/pagination tests. Revoked shares, tombstoned collections, removed recipes, and unrelated photos cannot leak owner data. |
| #2 | Shared pull uses `canViewRecipe` for the recipe authorization decision. `incomingShareFromGrant` is removed only after a fresh usage search confirms that its definition and test are the only live usages. |
| #3 | `sharedParentLive` performs its incoming-share query, collection reads, and recipe reads through the `Transaction` already opened by `putDoc`, and returns on the first authorized match. |
| #4 | A completed owned pull is installed even when `/api/sync/shared` fails. A shared 401 still signs out and clears all library state; a non-auth shared failure keeps the newly loaded owned state and reports the normal refresh error. |
| #5 | Library mount does not prefetch grants for every owned collection. An owned collection receives the shared badge only after its Share sheet has loaded/refreshed its grant list. Incoming shared collections keep their icon without any grant-list request. |
| #9 | Add/revoke performs one mutation request and one caller-owned refresh: `POST + GET`, never `POST + GET + GET`. |

## Invariants

- `GET /api/sync/shared` derives candidate grants from
  `incomingShares/{session.sub}/items`; a cursor can select a position only,
  never an arbitrary owner or collection.
- A collection must be live and match the stored incoming share. A recipe must
  be live and still listed in that collection at the authorization decision.
- Shared pull emits photo metadata only for photo ids referenced by recipes
  authorized on that page. Photo GET authorizes only recipe `photoId` /
  `galleryPhotoIds`, never an arbitrary owner photo or a chat attachment.
- Owned pull remains all-or-nothing across its own pages. Shared pages are also
  staged until the shared pull completes; a failed later shared page must not
  install a partial shared snapshot.
- On a non-auth shared failure, the exact client state is: the completed owned
  recipes, collections, chat, cook state, and owned photo ids are installed
  and `loaded` is true; all prior shared recipes, collections, origins, and
  shared-only photo ids are absent (fail closed); pending local blobs and
  already-known grant counts retain the existing `replaceFromPull` behavior.
  The sync outcome is `error`, `lastSyncedAt` is not advanced, and the existing
  “Couldn't refresh” toast remains.
- On `401`/`403` from either pull, `invalidateSession` and `clearLibrary`
  preserve current signed-out semantics; no owned data remains visible and no
  error toast is shown.
- `sharedParentLive` reads the incoming-share query and every candidate
  collection/recipe from one Firestore transaction snapshot. It never reads
  `ownerSub` from a chat/cook push payload.
- Without a recipe-to-share reverse index, `sharedParentLive` still has
  worst-case reads proportional to the viewer's live incoming shares. This
  fix intentionally adds no reverse index, cache, or other subsystem; it only
  makes the existing scan snapshot-consistent and preserves the early return
  on the first match.
- Owned collection badge state is unknown until Share has been opened in the
  current in-memory session. Unknown and known-zero both render no badge;
  incoming shared collections render `SharedIcon` from their origin.

## Steps (sequential)

### 1. [core] Add dependency-injected shared-read authorization tests

**Files:** `server/sharedPull.ts`, `server/sharedPull.test.ts`,
`server/grants.ts`, `server/grants.test.ts`, `server/sync.ts`,
`server/photos.ts`.

Refactor the two IO orchestrators in the same explicit-input style as
`resolveShareTarget`:

- `buildSharedPullPage` receives one input object containing `viewerSub`,
  `cursor`, `limit`, `listLiveIncomingShares`, `readLiveIncomingShare`, and
  `readDocData`.
- `sessionCanViewOwnerPhoto` receives one input object containing `viewerSub`,
  `ownerSub`, `photoId`, `listLiveIncomingShares`,
  `readLiveIncomingShare`, and `readDocData`.
- `syncSharedPull` and `photosGet` pass the real store functions. Tests pass
  deterministic in-memory async functions; do not mock Firestore modules or
  construct a Firestore client.

Add `readLiveIncomingShare(viewerSub, grantId)` in `server/grants.ts`. It reads
that document only below the session viewer's `incomingShares` path and returns
the parsed `{ grantId, ownerSub, collectionId }` only while the row is live and
well formed. Before reading an owner collection, each orchestrator must
revalidate the candidate returned by the list and require the current row to
match the candidate owner and collection. A tombstone or changed row is
skipped. This closes the testable list-then-read revocation window; it does not
claim to cancel a response whose authorization read already completed.

Keep the cursor codec pure and unchanged. The injected share list is the
authorization boundary: it must be called with the session `viewerSub`, and
only its stored `ownerSub` / `collectionId` values may drive owner-tree reads.

Expand `server/sharedPull.test.ts` beyond codec coverage:

- paginate one grant with a small limit and assert stable sorted recipe
  boundaries, no duplicate/skipped authorized recipe, collection emitted once
  per returned grant page, and `hasMore` / cursor progression into the next
  grant;
- make the initial injected list return a live grant, then make
  `readLiveIncomingShare` observe its tombstone/revocation in the same page
  invocation; assert its collection and remaining recipes are not emitted and
  pagination may advance only to another currently live grant;
- return a tombstoned collection and assert no collection, recipe, or photo
  metadata crosses the boundary;
- return a live recipe document that is no longer in the collection's current
  `recipeIds` and assert it is not emitted;
- include a listed tombstoned/missing recipe and assert it is skipped while
  the cursor still advances over the examined id, preventing a pagination
  loop;
- include photo documents for an authorized recipe and for an unrelated
  recipe/account, and assert only referenced metadata from the authorized
  owner is emitted;
- supply a cursor for a grant the viewer does not have and assert it cannot
  manufacture access to that grant's owner tree.

Expand `server/grants.test.ts` around `sessionCanViewOwnerPhoto`:

- cover a live share + live collection + listed live recipe cover/gallery
  success;
- cover no live share after revoke, a tombstoned collection, a recipe removed
  from `recipeIds`, and a tombstoned recipe;
- use the same photo id in another owner's listed recipe and an unrelated
  photo document under the requested owner; neither may authorize the
  requested owner;
- verify chat/unreferenced photo ids remain denied and that the function
  returns immediately after the first authorized share.

Run the two focused Vitest files after this step.

### 2. [core] Centralize shared-pull recipe decisions and remove verified dead code

**Files:** `server/sharedPull.ts`, `server/grants.ts`,
`server/grants.test.ts`, `server/shareAuth.ts`,
`server/shareAuth.test.ts`.

In the per-recipe loop in `buildSharedPullPage`, call
`canViewRecipe(recipeId, share, collection, recipe)` before compacting or
collecting photo ids. Remove the local
`recipe !== undefined && isLiveDoc(recipe)` authorization branch; collection
gating may still use `canViewCollection` to avoid unnecessary recipe reads.
Keep output compaction and pagination separate from authorization.

Immediately before deleting `incomingShareFromGrant`, run:

```bash
rg -n "incomingShareFromGrant" .
```

The current branch has only the export in `server/grants.ts`, its isolated
test/import in `server/grants.test.ts`, and a historical mention in
`docs/plans/shared-recipes.md`. If implementation-time usages differ, keep the
helper and update this plan before deleting it. Otherwise remove the export
and its test/import; keep `incomingSharePayload`, which is used by active grant
transitions. Do not rewrite the historical parent plan solely to erase the
old design note.

Extend `server/shareAuth.test.ts` only as needed to lock the shared decision:
wrong collection id, recipe absent from current `recipeIds`, tombstoned
collection, and tombstoned recipe all deny; a matching listed live recipe
allows.

### 3. [core] Put shared-parent authorization on the active transaction snapshot

**Files:** `server/store.ts`, `server/store.test.ts`,
`server/shareAuth.ts`, `server/shareAuth.test.ts`.

Change the signature to
`sharedParentLive(tx: Transaction, sessionSub: string, recipeId: string)`.
Inside it:

- build the `incomingShares/{sessionSub}/items` query from server-controlled
  paths and execute it with `tx.get(query)`, not `query.get()`;
- skip tombstoned/malformed incoming rows;
- derive `ownerSub` and `collectionId` only from each stored incoming row;
- read `collectionDocRef(ownerSub, collectionId)` with `tx.get`;
- read `recipeDocRef(ownerSub, recipeId)` with `tx.get` only when the live
  collection currently lists the recipe;
- route the final candidate decision through `canViewRecipe`, and return
  `true` immediately on the first match.

In `putDoc`, pass its existing `tx` into `sharedParentLive`. The destination
document read, owned-parent recipe read, incoming-share query, owner collection
read, and owner recipe read then belong to the same transaction snapshot,
before the transaction's `tx.set`.

Keep photos on the existing owned-parent-only branch. Do not accept or inspect
`ownerSub` from `payload`. Add/retain pure tests in
`server/shareAuth.test.ts` for the candidate decisions and a small exported
pure predicate only if `server/store.test.ts` needs coverage; do not add an
emulator-backed transaction test or a fake Firestore implementation. Review
the production function directly to verify every authorization read is
`tx.get`.

### 4. [core] Commit owned pull state before handling shared-pull failure

**Files:** `src/lib/syncEngine.ts`, `src/lib/syncEngine.test.ts`,
`src/lib/libraryMemory.ts`, `src/lib/libraryMemory.test.ts`.

Make the pull orchestration unit-testable with injected `pullPage` and
`pullSharedPage` functions (an explicit dependency object; production passes
the existing functions from `remote.ts`).

After every owned page succeeds, call `replaceFromPull(ownedAccumulator)`
before requesting the first shared page. This intentionally clears the prior
shared snapshot and marks the newly fetched owned library loaded. Accumulate
shared pages separately and call `mergeSharedFromPull` only after all shared
pages succeed.

Return behavior:

- owned page `error`: do not install the incomplete owned accumulator; retain
  existing error handling;
- owned or shared `signedOut`: clear the entire library defensively and return
  `signedOut` (the real remote helper also invalidates the session);
- shared `error` or thrown non-auth failure: leave the already-installed owned
  snapshot in place, install no partial shared rows, and return `error`;
- complete shared pull: merge it once and return `ok`.

Add isolated unit tests with in-memory pages:

- seed old owned + shared rows, return updated owned rows then shared `error`,
  and assert updated owned recipes/collections/chat/cook/photos are loaded
  while old shared rows/origins/shared-only photo ids are gone;
- fail on a later shared page and assert no first-page shared rows were merged;
- return shared `signedOut` after owned install and assert the whole library is
  empty with signed-out outcome;
- fail an owned page after an earlier owned page and assert the incomplete
  owned accumulator was not installed;
- complete both pulls and assert own-id precedence and shared origin behavior
  remain unchanged;
- keep `decideSyncToast` expectations: partial shared failure is the existing
  `error`/“Couldn't refresh”; signed-out stays silent.

Do not add a new outcome or toast just for partial failure.

### 5. [ui] Remove eager owned-grant prefetch and make badge discovery explicit

**Files:** `src/screens/Library.tsx`,
`src/lib/libraryMemory.test.ts`.

Delete `prefetchedGrantListsRef`, `ownedCollectionIdSignature`, and the Library
effect that calls `collectionStore.listGrants` for every owned collection.
Remove now-unused React imports. Library render must not list grants.

Keep the badge expression semantically split:

- `isSharedCollection(collection.id)` always renders `SharedIcon`;
- an owned collection renders it only when
  `(getGrantCount(collection.id) ?? 0) > 0`;
- opening `ShareCollectionSheet` remains the action that calls
  `collectionStore.listGrants`, stores the count, and reveals/removes the
  owned badge after that refresh.

Retain the `setGrantCount` no-op notification test. Add a memory-level test if
needed to state that absent count is distinguishable from a positive known
count; do not introduce component tests or a DOM testing dependency.

### 6. [core] Make Share sheet the sole post-mutation grant-list refresher

**Files:** `src/lib/collectionStore.ts`,
`src/lib/collectionStore.test.ts`,
`src/components/ShareCollectionSheet.tsx`.

Remove the internal `collectionStore.listGrants` call from both `addGrant` and
`revokeGrant`. Keep error mapping and the `addGrant` return value. These store
methods perform only their mutation request.

Keep `ShareCollectionSheet` in charge of refreshing its rows after a
successful mutation:

- add: `addGrant` POST, clear the email, then exactly one `listGrants` GET;
- revoke: `revokeGrant` POST, then exactly one `listGrants` GET;
- the GET result updates both sheet rows and `grantCounts` through
  `collectionStore.listGrants`;
- a failed POST performs no GET; a failed post-mutation GET shows the existing
  sheet error and does not claim a refreshed badge count.

Extend the existing remote mocks in `src/lib/collectionStore.test.ts` and
assert `addGrant` calls `addCollectionGrant` once without
`listCollectionGrants`, while `revokeGrant` calls `revokeCollectionGrant` once
without `listCollectionGrants`. No DOM test is required; browser network
verification in the next step proves the component-owned GET.

### 7. [ui] Browser verification of partial sync, badges, and request counts

**Files:** no production files expected.

Run both processes and restart `dev:api` after the server edits:

```bash
npm run dev
npm run dev:api
```

Use `http://localhost:5173` with a signed-in owner and, for shared reads, a
second admitted member. Exercise the flow, not only screenshots:

- load `/` with owned collections while the Network panel is filtered to
  `grants`; expect zero grant-list GETs before opening Share;
- confirm incoming shared collection chips still show `SharedIcon`;
- open an owned collection's Share sheet; expect one GET and a badge only when
  the returned list is non-empty;
- clear the Network panel, add a grantee, and expect exactly one POST followed
  by one GET; repeat for revoke and expect exactly one revoke POST followed by
  one GET;
- block or force a non-auth failure for `/api/sync/shared`, change owned data
  from the other session, then use Settings Refresh; expect the changed owned
  library to be visible and loaded, prior shared rows absent, the existing
  “Couldn't refresh” toast, and no sign-out;
- unblock the endpoint and Refresh; expect current shared rows/icons to return;
- verify a shared recipe's cover/gallery loads, while an unreferenced owner
  photo URL returns 404 without signing out;
- verify Ask/cook writes on a shared recipe still succeed, while shared recipe
  edit/photo-write controls remain unavailable.

Also revisit `/`, `/?c=`, `/recipe/:id`, and `/settings`, because they share
the same in-memory library and sync state.

### 8. [core] Run the full merge gate

**Files:** all files changed by steps 1–6.

Run focused tests while iterating, then from the repository root run:

```bash
npm test
npm run build
```

`npm run build` is mandatory because it is the server TypeScript gate. Confirm
the exact `Recipe` key-set assertion in `src/lib/recipeStore.test.ts` remains
unchanged. Review the final diff for no Firestore emulator/GCS mock/DOM test
dependency, no screen-level `fetch`, no `ownerSub` trust from client bodies,
and no changes to Vercel handlers, backup markers, auth scopes, or deployment.

## Explicitly deferred product decisions

- **#6 — account-existence oracle and rate limiting:** do not change generic
  email lookup responses, admission disclosure, or add rate limiting in this
  follow-up. These need a separate product/security decision.
- **#7 — `ownerSub` exposure versus opaque grant id:** keep the current wire
  and in-memory origin shape for PR #23. Do not introduce opaque owner handles
  or rewrite photo routing in this fix.
- **#8 — legacy backup clone UX copy:** do not add warnings, restore/clone
  choice, or new copy for legacy backups here.

## BLOCKING open questions

None.
