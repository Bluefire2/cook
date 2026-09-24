# PR #23 review fixes — round 2

Parent: `docs/plans/shared-recipes.md` (PR 2 view ACLs).
Predecessor: `docs/plans/shared-sharing-final-hardening.md`.
Branch: `cursor/shared-collections-cdc9` (PR #23).

## Goal

Close exactly four verified review findings before PR #23 merges:

1. a grant revocation or collection-membership removal between paginated
   `/api/sync/shared` requests can leave rows from an earlier page in the
   client accumulator and publish them after access has disappeared;
2. clone-mode backup restore uploads remapped photos before their remapped
   parent recipes exist in the viewer's server tree;
3. a client-clock collection delete can be older than server-clock grant
   rows, causing the cascade to skip those grants and allowing them to become
   live again if the collection is undeleted;
4. viewer-owned chat and cook rows for a shared parent lose their origin when
   that parent disappears after revocation, so backup export mistakes them for
   ordinary owned orphans.

Keep the scope to those four findings. Shared collections remain view-only;
the default collection remains private; the session and stored incoming-share
rows remain the trust roots. Do not add fields to `Recipe`, `ChatMessage`, or
`CookStateRow`. Do not add a Firestore emulator, GCS mock, DOM test library,
dependency, route, user-facing sharing feature, deployment step, or backup
format bump. Keep `app: 'cook'`, `cook-backup-` filenames, and backup version
3.

## Findings map

| # | Current mechanism | Required end state |
| --- | --- | --- |
| 1 | Each HTTP page revalidates only the grant it is about to emit. `syncEngine` privately stages page 1, but a later page cannot tell it that page 1's grant or recipe membership has since disappeared. | One successful shared refresh represents one stable authorization scope. If that scope changes while paging, no shared row from that attempt is published; the client discards the shared accumulator and restarts from page 1, with a bounded retry count. |
| 2 | `importLibrary` calls `postPhoto` before its single `pushOps` call. `photosPost` correctly rejects a remapped parent id that is not yet a live recipe. | Import pushes all remapped parent recipes successfully before the first photo upload, then uploads photos, then pushes dependent collections/chat/cook rows. |
| 3 | `collection.delete` passes `body.updatedAt` into the grant cascade. Grant and reverse-share `updatedAt` values come from server request time, so a valid delete can look stale to the ACL rows. | Collection deletion and its ACL transition use an authoritative server-side cascade order and cannot leave pre-delete live grant pairs behind. Undelete never revives an old grant; sharing again requires the existing explicit grant API. |
| 4 | `recipeOrigins` disappears with a revoked shared recipe. Owned pull still returns viewer-local chat/cook rows, and export treats a missing recipe origin as owned. | Server-derived parent provenance is stored beside chat/cook documents and pulled into client sidecar maps. It survives revocation and process reload, while domain entity schemas and backup payloads remain unchanged. |

## Cross-cutting invariants

- A successful shared refresh has a single authorization-scope generation.
  The positional cursor still cannot introduce an owner or collection.
  Per-candidate fresh grant, collection, recipe, and photo checks remain
  mandatory; a generation token is consistency detection, not authorization.
- Shared-page staging remains private until the complete owned + shared
  snapshot is published once. A generation restart publishes nothing. Shared
  `401`/`403` still clears the session/library. A terminal non-auth failure
  still publishes completed owned-only state and returns the existing error
  outcome/toast.
- Collection recipe removal is part of the shared authorization scope, not
  merely a content update. Rows staged from the removed membership cannot
  survive a scope restart.
- Import ordering never uploads bytes against a parent recipe that the same
  import has not first pushed successfully. This does not make multi-request
  backup import transactional and does not broaden photo-write authorization.
- Collection `updatedAt`/`deletedAt` remain client LWW fields. The fix must not
  compare server-created ACL rows against that client clock when deciding
  whether the accepted delete owns the cascade.
- A collection delete revokes the grant generation that existed before the
  tombstone. A later collection undelete restores only the collection and its
  recipes, not old viewers.
- Parent provenance is server-derived. Ignore and overwrite any client-sent
  provenance marker. A live owned recipe takes precedence over a shared recipe
  with the same id.
- Parent provenance lives beside the locked domain objects:
  `chatParentOrigins` keyed by message id and `cookParentOrigins` keyed by
  recipe id. It is not added to `ChatMessage`, `CookStateRow`, or a version-3
  backup entity.
- Backup export omits chat/cook rows if either the current recipe origin or
  the persisted parent-origin sidecar says shared. Photo attribution receives
  only retained recipes and chat, so omitted shared-parent attachments cannot
  become orphan photo exports.

## Steps (sequential)

### 1. [core] Give paginated shared pull a stable authorization generation

**Files:** `server/grants.ts`, `server/sharedPull.ts`,
`server/sharedPull.test.ts`, `server/sync.ts`, `server/sync.test.ts`,
`src/lib/remote.ts`, `src/lib/remote.test.ts`, `src/lib/syncEngine.ts`,
`src/lib/syncEngine.test.ts`.

Add a server-built, authenticated scope generation to the separate shared
cursor. Keep `grantId` and `recipeId` as the positional fields; add a version
and scope digest rather than reusing the owned pull cursor. Sign the complete
continuation payload `{ v, viewerSub, generation, grantId, recipeId }` with
HMAC-SHA256 using the existing server secret. Reject/restart on an invalid
signature or viewer mismatch. A caller must never be able to splice a position
from one cursor into a newly obtained generation.

Build the digest from a canonical, deterministically sorted description of the
authorization surface visible to the session:

- every live incoming share's `grantId`, stored `ownerSub`, `collectionId`,
  and Firestore document `updateTime`;
- whether the referenced collection is currently live;
- for a live collection, its id and complete ordered `recipeIds` membership
  plus the collection snapshot's Firestore `updateTime`, so revoke/re-grant
  or delete/undelete cannot return to the same generation accidentally.

Use Node's built-in cryptography for the digest; do not add a dependency and
do not place raw ACL data in the cursor. Extend `LiveIncomingShare` or add a
scope-only parsed type so mutation identity comes from Firestore snapshot
metadata, not client input or millisecond `Date.now()`. Build the canonical
scope in one Firestore read-only transaction: query the session's reverse
shares, then read every referenced collection before finishing the
transaction. This avoids hashing a hybrid assembled from different database
moments.

At the first page, establish the scope generation. Rebuild and compare it
inside a read-only transaction on every continuation and again after every
page read, including a single-page completion and the final page. If it
differs from the verified starting generation, return a typed
`shared-snapshot-changed` response with no changes. A continuation with a
malformed, unsigned, missing, or mismatched generation must never be treated
as permission to continue from its position. Existing per-grant
`readLiveIncomingShare` and `canViewCollection` / `canViewRecipe` checks stay
in place to close the within-page authorization window.

`pullSharedPage` maps only the typed snapshot-change response to a new
`'restart'` result. Old clients that do not understand it fail closed through
their existing non-2xx path. In `pullAll`, discard all shared maps, origins,
photos, and cursor state from that attempt, then restart shared pull from
`null`. Cap restarts at a small named constant (for example, three attempts);
exhaustion follows the existing non-auth shared-error path, publishing the
completed owned-only snapshot and showing “Couldn't refresh.” Never restart
owned pull for this condition.

Regression tests:

- codec round-trip includes the opaque generation, while a legacy/start
  cursor can begin only at page 1;
- cursor signature binds version, viewer, generation, and both positional
  fields; tampering or replay under another viewer restarts safely;
- stable single-page and multi-page pulls complete with the same generation;
- revoke a grant after page 1 but before the final request: the final request
  returns restart/no changes, and `syncEngine` publishes none of page 1;
- remove a recipe from the collection after page 1: the scope changes and the
  earlier staged recipe is discarded;
- revoke then recreate a logically identical grant: its changed mutation
  identity still forces restart;
- a changed generation cannot be combined with a hostile positional cursor to
  read another owner tree;
- one restart followed by a stable reread publishes exactly once;
- repeated churn reaches the retry cap, installs owned-only state, retains
  pending blobs/grant counts, and returns the existing error outcome;
- shared signed-out behavior and later-page transport failure behavior remain
  unchanged.

### 2. [core] Push remapped recipe parents before backup photo uploads

**Files:** `src/lib/backup.ts`, `src/lib/backup.test.ts`.

Keep the existing one-time preserve/clone decision and complete-graph remap.
After optimistic local upserts, split remote persistence into this order:

1. build and `pushOps` all `recipe.put` operations;
2. only after every recipe operation returns `ok`, upload each attributed
   backup photo with its remapped photo id and remapped parent recipe id;
3. after all uploads succeed, `pushOps` the dependent `collection.put`,
   `chat.put`, and `cookState.put` operations.

Do not call `postPhoto` if the parent recipe phase is rejected or signed out.
Keep `pushOps` batching and existing error copy. Preserve the current snapshot
rollback behavior and document in code/tests that remote import remains
best-effort across requests: a failure after recipe push can leave accepted
server rows that the next refresh reveals. Do not add compensating deletes or
a new import endpoint in this fix.

Before optimistic or remote writes, sanitize dangling dependent rows in the
backup graph: omit chat/cook rows whose `recipeId` is not present in the
backup's usable recipe set, and omit photos attributable only to those rows.
Do not synthesize parent recipes and do not attempt photo upload against a
parent absent from the parent phase. This preserves all recipe entities in
version-1/2/3 backups while making explicit that legacy orphan dependents are
not restorable under the server's parent invariant.

Regression tests must record call order, not merely final arguments:

- explicit foreign-provenance clone: remapped `recipe.put` completes before
  the first `postPhoto`; the upload uses the same remapped recipe/photo ids;
- provenance-less clone into an empty account has the same ordering;
- a parent recipe rejection performs zero photo uploads and zero dependent
  pushes;
- after successful uploads, collections, chat references, cook references,
  and attachments use the same remapped graph;
- same-account preserve mode remains overwrite-by-id/idempotent;
- photo-free imports do not make an unnecessary upload call and still execute
  parent before dependent pushes.
- the existing orphan-chat-photo export fixture can be imported without any
  orphan photo upload or dependent push; sanitization happens before local or
  remote mutation.

### 3. [core] Make collection delete and grant revocation one server-ordered transition

**Files:** `server/store.ts`, `server/store.test.ts`, `server/grants.ts`,
`server/grants.test.ts`, `server/sync.ts`, `server/sync.test.ts`.

Replace the current `tombstoneDoc(...body.updatedAt)` followed by an
independent client-timestamp cascade with a collection-specific,
dependency-injected delete orchestration. Add an internal
`active: true | false` field to forward grant documents. Grant add/revoke and
delete-cascade writes maintain it; it is not part of any client grant shape.
Because sharing is undeployed, old development grants without `active` are
reset/re-shared rather than backfilled. The production implementation must
use one Firestore transaction for the collection decision and all currently
live forward/reverse grant pairs:

- read the collection and apply the existing client-LWW
  `compareMutation` decision;
- if the delete applies, query forward grants with `active == true` and
  `limit(MAX_LIVE_GRANTS + 1)`, then read matching reverse incoming shares
  before any write;
- derive a server-side cascade order that is at least every authoritative
  grant/share order read in the transaction (never `body.updatedAt`), using
  `max(Date.now(), ...pairUpdatedAt) + 1`;
- write the collection tombstone with its existing client
  `updatedAt === deletedAt` plus normal `serverUpdatedAt` and an internal
  `grantCascadeAt` equal to the authoritative cascade order;
- tombstone each pre-delete forward/reverse pair at the server cascade order
  with `active: false` on the forward side, in the same transaction.

The 20-live-grant product cap keeps the paired write count bounded. Ensure all
transaction reads, including the grant query and reverse point reads, happen
before writes. A concurrent grant add already reads the collection in its own
transaction; the shared collection read/write makes Firestore retry one side,
so an add cannot commit against a tombstoned collection.

Retain retry-healing behavior from the previous hardening: if the current
collection is already a canonical tombstone, rerun the bounded live-grant
query and ACL cleanup using exactly its stored `grantCascadeAt`; if the
current collection is missing, malformed, or live and newer than the delete
request, do not revoke. Remove the old rule that allows a pre-delete live pair
to survive solely because its server timestamp is greater than the client's
delete timestamp. If the collection is later undeleted, all prior grant pairs
remain tombstoned and the owner must explicitly share again. All transaction
reads—including the bounded grant query and reverse point reads—must finish
before the first write.

Keep pure transition/orchestration seams so tests require no emulator.
Regression tests:

- accepted delete with client `updatedAt = 100` revokes a live grant/reverse
  pair at server order `> 100`;
- a grant/share timestamp newer than the client clock is still revoked;
- collection tombstone and every paired ACL tombstone are one successful
  orchestration outcome, with no write before all reads;
- a transaction conflict/retry cannot commit grant add and collection delete
  as simultaneously live;
- retrying an already-stored tombstone heals a leftover live pair using stored
  `grantCascadeAt`, not the stale request timestamp;
- stale delete against a newer live/undeleted collection performs no ACL
  writes;
- undeleting after a completed delete does not make the old reverse share
  live, while an explicit later grant add can create a new live pair;
- the existing missing/malformed collection and generic push-rejection
  behavior remain unchanged.

### 4. [core] Persist shared-parent provenance beside viewer chat and cook rows

**Files:** `server/store.ts`, `server/store.test.ts`, `server/sync.ts`,
`src/lib/remote.ts`, `src/lib/remote.test.ts`,
`src/lib/libraryMemory.ts`, `src/lib/libraryMemory.test.ts`,
`src/lib/syncEngine.ts`, `src/lib/syncEngine.test.ts`,
`src/lib/backup.ts`, `src/lib/backup.test.ts`.

Change the server's shared-parent authorization helper to return the
server-derived shared owner identity on success instead of only `true`.
`putDoc` still checks an owned parent first. For `chatMessages` and
`cookState` only:

- strip any provenance marker supplied in the push payload;
- when authorization falls back to a shared parent, store an internal
  `sharedParentOwnerSub` (name may follow local convention) beside the row;
- when the parent is owned, omit/clear the internal marker.

Photo writes remain owned-parent-only. Do not trust an `ownerSub` from a
client body and do not change `ChatMessage` or `CookStateRow`.

Owned pull may expose the internal marker as explicit wire metadata for
chat/cook rows. `normalizeChatChange` and `normalizeCookChange` continue to
return the exact locked domain objects, while `applyPullChanges` records the
marker in new sidecar maps. Thread `chatParentOrigins` and
`cookParentOrigins` through the owned accumulator, snapshot clone/capture/
restore/clear operations, `replaceFromPull`, and
`replaceFromPullWithShared`. Tombstones remove both the row and its sidecar.
Locally optimistic `upsertChat` / `upsertCook` infer the sidecar from the
current recipe origin, so an export before the next pull is also safe.

Backup export retains a chat/cook row only when neither source says shared:
the persisted parent sidecar and the currently visible `recipeOrigins`.
Run photo attribution after this filtering. Do not serialize sidecars into
the backup and do not import provenance from backup JSON.

Apply the same classifier in `ownedBackupGraphIds()`: when a chat/cook row's
persisted sidecar is shared, exclude that row's id, parent recipe reference,
and attachment photo ids from owned-overlap evidence even after
`recipeOrigins` has disappeared. Keep one shared-parent classifier for export
and ownership detection so the policies cannot drift.

Regression tests:

- a hostile chat/cook payload cannot choose or clear stored provenance;
- shared-parent authorization stores the server-discovered owner, while an
  owned parent stores no shared marker;
- pull normalization leaves the exact `ChatMessage`/`CookStateRow` key sets
  unchanged and places provenance only in sidecars;
- after a refresh with no remaining shared recipe/collection, viewer-owned
  chat and cook rows retain shared parent sidecars from owned pull;
- exporting that revoked state omits chat, cook, and chat-only photos even
  though `recipeOrigins` no longer contains the parent;
- optimistic chat/cook created while the share is live is omitted before a
  subsequent pull;
- overlap only through revoked shared-parent sidecars does not select
  preserve mode for a provenance-less foreign backup;
- owned-parent rows and legacy non-shared orphan rows retain their existing
  export behavior;
- clear/tombstone/sign-out removes the corresponding sidecar state;
- backup version, entity shapes, `exportedBySub`, marker, and filenames are
  unchanged.

### 5. [core] Run focused and complete automated verification

Run focused tests while implementing:

```bash
npx vitest run server/sharedPull.test.ts server/sync.test.ts server/grants.test.ts
npx vitest run src/lib/remote.test.ts src/lib/syncEngine.test.ts src/lib/libraryMemory.test.ts
npx vitest run src/lib/backup.test.ts src/lib/backupImportRemap.test.ts
npx vitest run server/store.test.ts
```

Then run both complete repository gates:

```bash
npm test
npm run build
```

`npm run build` is mandatory because it is the only server TypeScript gate.
Review the final diff and confirm:

- the exact Recipe schema-lock assertion remains unchanged;
- no field was added to `Recipe`, `ChatMessage`, or `CookStateRow`;
- shared cursor input still cannot choose a trusted owner;
- photo POST still requires a live owned parent;
- backup version 3 and `app: 'cook'` remain unchanged;
- no dependency, emulator/mock framework, auth scope, Vercel handler,
  deployment, polling, listener, or unrelated UI change was introduced.

### 6. [ui] Exercise the four fixes through the running application

Run Vite and `dev:api` at `http://localhost:5173`, restarting `dev:api` after
server edits. Use an owner and a second admitted member; do not deploy.

- Force shared pagination with a test-sized limit. Revoke the first-page
  grant, then continue Refresh. Confirm the attempt restarts and the revoked
  collection/recipes never appear. Repeat by removing a first-page recipe
  from its collection.
- Import a foreign backup containing a recipe photo. Confirm the recipe POST
  succeeds before the photo POST, the photo loads from the cloned recipe, and
  collection/chat/cook references point to the clone.
- Delete a shared collection from a client whose clock is behind the server,
  then undelete it. The prior viewer must not regain access until the owner
  explicitly shares again.
- As viewer, create Ask text and cook progress on a shared recipe, revoke the
  share, Refresh/reload, and export. Inspect the JSON: the recipe,
  shared-parent chat, cook row, and chat attachment are absent; owned recipes
  and owned-parent chat/cook remain.
- Recheck `/`, `/?c=`, `/recipe/:id`, `/settings`, and the Share sheet because
  these paths consume the changed sync/origin state.

## Migration and compatibility

- No production data migration is expected: PR #23 sharing has not been
  deployed. The shared cursor is request-scoped and is not persisted; an old
  opaque cursor is treated as a safe restart/failure, never as authorization.
- Existing version-1/2/3 recipe entities remain importable. New imports keep
  version 3 and change remote write order; dangling chat/cook rows and photos
  without a usable recipe in the same backup are sanitized before mutation
  because the server cannot accept them.
- Collection and grant document shapes remain readable. `active`,
  `grantCascadeAt`, and server-side mutation identity are internal/additive;
  no client consumes them. Sharing is undeployed, so development grants made
  before `active` are reset and re-shared for testing rather than migrated.
  No production backfill script belongs in this PR.
- `sharedParentOwnerSub` is additive server metadata and absent on legacy
  rows. Absence continues to mean “no persisted evidence of shared parent,”
  preserving owned legacy/orphan backup behavior. Because sharing is
  undeployed, there is no production population requiring backfill. Already
  revoked development rows created before this marker cannot be inferred
  safely once both recipe and grant are gone; do not guess or classify every
  orphan as shared.
- Cached old SPA code sees a typed snapshot-change response as an ordinary
  shared failure and therefore installs owned-only state. It fails closed
  until the new client bundle loads.

## Out of scope

- Viewer leave flow or cleanup/deletion of viewer-owned chat/cook rows
- Atomic all-or-nothing backup import, compensating deletes, or a new import API
- Exporting shared rows, changing legacy orphan policy, or backup version 4
- Shared Ask photo attachments or any widening of photo POST authorization
- Public links, write grants, nested collections, default-collection sharing
- Firestore/GCS test infrastructure, new indexes, production deploy, or data
  backfill tooling

## BLOCKING open questions

None.
