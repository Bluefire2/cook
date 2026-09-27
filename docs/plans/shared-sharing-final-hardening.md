# Shared sharing — final pre-merge hardening

Parent: `docs/plans/shared-recipes.md` (PR 2 view ACLs).
Predecessors: `docs/plans/shared-collections-review-fixes.md` and
`docs/plans/shared-access-hardening.md`.
Branch: `cursor/shared-collections-cdc9` (PR #23).

## Goal

Close the final confirmed correctness, privacy, performance, and documentation
gaps before PR #23 merges, without expanding the sharing product.

- Shared named collections remain view-only and the default collection remains
  private.
- The session and stored incoming-share rows remain the only trust roots.
  Client input never supplies a trusted `ownerSub`.
- No fields are added to `Recipe`, `ChatMessage`, or `CookStateRow`.
- Screens do not fetch library data; library network IO remains in `remote.ts`
  and `syncEngine.ts`, while grant REST remains behind `collectionStore`.
- Tests use pure/in-memory dependency seams. Do not add a Firestore emulator,
  GCS mock, or DOM testing library.
- Server code remains compatible with `erasableSyntaxOnly`: no enums or
  constructor parameter properties.
- Keep `app: 'cook'`, `cook-backup-` filenames, and backup version 3. Do not
  deploy.

## Required end state

| Area | Required behavior |
| --- | --- |
| Sync publication | A successful owned + shared refresh publishes one complete library snapshot. Subscribers never observe a transient owned-only library or a partial shared page. |
| Shared failure | After the owned pull completes, a non-auth shared failure installs that completed owned snapshot, removes every prior shared row, preserves the current fail-closed behavior, and returns the existing error outcome/toast. |
| Legacy backup | Explicit same-account provenance preserves IDs; explicit different-account provenance clones. Missing provenance preserves the whole graph only when a backup ID overlaps an existing **owned** graph ID; otherwise it clones the whole graph. |
| Shared photo read | Each candidate share performs a bounded number of point reads: fresh incoming-share row, live collection, requested photo metadata, and exactly the photo's parent recipe. Authorization requires the recipe to remain viewable and to list the photo. |
| Email lookup | Sign-in writes normalized `emailLower`. Sharing queries `emailLower`, with an exact normalized `email` fallback for pre-field lowercase profiles. Responses reveal no more than the current generic behavior. |
| Revoke | Malformed viewer document IDs return 400 before any `.doc()` call. A missing grant returns generic 404 with no writes; an existing tombstone returns idempotent success with no writes. |
| Collection delete retry | A delete that finds an already-stored tombstone reruns the grant cascade at that stored tombstone timestamp. A stale delete against a newer live collection does not cascade. |
| Shared icon | Only incoming shared collections render `SharedIcon`. Owned collections never render it, regardless of grant count. |
| Backup export | Chat rows whose parent recipe is shared are omitted, like shared recipes and cook state, so their messages and attachments cannot become orphan exports. |

## Invariants

- Owned pull pages and shared pull pages are accumulated without publishing.
  On complete success, one library-memory operation constructs and emits the
  final owned-precedence snapshot.
- A shared `401`/`403` keeps the existing signed-out path: invalidate the
  session, clear all library state, and do not show the refresh-error toast.
  Only a non-auth shared failure publishes the completed owned-only snapshot.
- A failed later shared page never publishes an earlier shared page.
- Atomic publication retains the existing treatment of pending blobs and
  in-memory grant-count cache; this task does not put grant counts in owned
  pull responses.
- Legacy overlap detection compares like-for-like IDs against an
  ownership-filtered local graph. Incoming shared recipes, collections, and
  their referenced photos are not evidence that a provenance-less backup
  belongs to the current account. Once the decision is made, preserve or clone
  the entire imported graph; never mix modes by entity.
- Photo authorization does not scan every `collection.recipeIds` entry. A live
  requested photo metadata row supplies `recipeId`; the server reads only that
  recipe, then requires both `canViewRecipe` and
  `recipeListsPhoto(recipe, photoId)`. A chat attachment remains private
  because its parent `Recipe` does not list it.
- `emailLower` is derived server-side with the same trim/lower normalization
  used for share input. The fallback query is exact on normalized `email`, so
  legacy mixed-case profiles require a next sign-in or explicit backfill.
- Revoke decisions come from the authoritative forward grant read inside the
  transaction. Missing and already-tombstoned grants never create or rewrite
  an arbitrary reverse incoming-share row.
- A collection cascade retry uses the stored tombstone's finite
  `deletedAt`/`updatedAt` timestamp, not the stale request timestamp.
- Every per-viewer cascade transaction also reads the collection and proceeds
  only while it remains a canonical tombstone with
  `updatedAt === deletedAt === cascadeAt`. A concurrent collection revival
  conflicts/retries and then skips the grant writes.

## Steps (sequential)

### 1. [core] Publish successful owned and shared pulls atomically

**Files:** `src/lib/libraryMemory.ts`,
`src/lib/libraryMemory.test.ts`, `src/lib/syncEngine.ts`,
`src/lib/syncEngine.test.ts`.

Add one library-memory publication operation that accepts the completed owned
accumulator and completed shared accumulator and builds the final snapshot
before calling `emit`:

- mark every owned recipe and collection with origin `own`;
- merge shared recipes and collections with owned-ID precedence;
- union only the completed owned and shared remote-photo sets;
- preserve the current pending-blob and grant-count behavior;
- set `loaded: true`;
- emit exactly once.

Keep both pull accumulators private to `pullAll` until their respective page
loops finish. Do not call `replaceFromPull` between the owned and shared
requests on the success path. When all shared pages complete, invoke the new
atomic publisher once.

For a non-auth shared `error` or throw, publish the completed owned accumulator
through the owned-only replacement path at that point. That removes all old
shared recipes, collections, origins, and shared-only remote photo IDs while
retaining the newly completed owned rows, then returns `outcome: 'error'`.
Keep owned-page failure all-or-nothing. Keep signed-out handling clearing the
entire library.

Add subscriber-level tests by registering `libraryMemory.subscribe` and
capturing every emitted snapshot during `pullAll`:

- successful owned + multi-page shared pull emits no owned-only intermediate
  snapshot and the sole refresh publication already contains the complete
  shared collection, every shared recipe, origins, and photos;
- no subscriber snapshot contains a shared collection with only a first-page
  subset of its recipes;
- a later shared-page error emits one completed owned-only snapshot, with no
  first-page shared rows and no prior shared rows;
- shared signed-out still clears everything;
- owned-ID precedence, pending blobs, grant counts, `loaded`, sync outcomes,
  and the existing “Couldn't refresh” toast remain unchanged.

Run the focused sync and memory tests after this step.

### 2. [core] Make provenance-less backup restore idempotent only on owned overlap

**Files:** `src/lib/backupImportRemap.ts`,
`src/lib/backupImportRemap.test.ts`, `src/lib/backup.ts`,
`src/lib/backup.test.ts`, and ownership-filtered snapshot helpers in
`src/lib/libraryMemory.ts` only if needed.

Replace the current two-input `shouldCloneBackupIds` rule with a pure import
mode decision that receives the optional `exportedBySub`, current sub, backup
graph IDs, and existing **owned** graph IDs:

- `exportedBySub === currentSub` always preserves;
- a different explicit `exportedBySub` always clones, even if IDs overlap;
- missing provenance plus any like-for-like owned ID overlap preserves every
  ID in the backup graph;
- missing provenance with no owned overlap clones every entity and rewrites
  every reference.

Build the existing-owned ID view without treating incoming shared rows as
owned. Include the imported namespaces used by the graph—recipes,
collections, chat messages, cook-state parent recipe IDs, and photos
referenced by owned recipes/owned-parent chat—as appropriate, comparing IDs
within their namespace. The key regression is that a legacy file containing
IDs visible only through an incoming share must still clone.

Define the complete imported ID universe before remapping. Recipe-id mappings
must include ids from recipe entities plus every collection membership,
chat-message parent, and cook-state parent reference. Photo-id mappings must
include backup photo entities plus every recipe and chat reference. Repeated
references share one generated id. In clone mode, no reference may fall
through to an original canonical owner/shared id merely because its parent
entity is absent from the backup.

Decide once before optimistic upserts, uploads, or push operations, then pass
that one mode to `remapBackupImport`. Keep new exports writing
`exportedBySub`. Update the misleading comment that currently says missing
provenance always clones.

Add pure decision tests for explicit same/different sub, missing provenance
with owned overlap, no overlap, and shared-only overlap. Add import-level cases
showing:

- a populated same-account legacy restore preserves IDs and remains
  overwrite-by-ID/idempotent;
- an empty account importing a legacy file clones;
- a foreign account with only shared canonical rows clones the whole graph;
- explicit foreign provenance clones despite an owned collision;
- collections, photos, chat, and cook references all follow the single
  preserve-or-clone decision.
- orphan collection/chat/cook recipe references and orphan photo references
  are remapped consistently rather than retaining canonical foreign ids.

### 3. [core] Bound shared-photo authorization reads per candidate

**Files:** `server/grants.ts`, `server/grants.test.ts`,
`server/shareAuth.ts`, `server/shareAuth.test.ts`, `server/photos.ts`.

Refactor `sessionCanViewOwnerPhoto` so each candidate for the requested owner
uses this order:

- freshly re-read and match the incoming-share row under the session viewer;
- point-read the collection and require it to be live and match the share;
- point-read requested owner photo metadata and require a live photo with a
  valid `recipeId`;
- point-read exactly that owner recipe;
- require `canViewRecipe(recipeId, share, collection, recipe)` and
  `recipeListsPhoto(recipe, photoId)`.

Do not enumerate `collection.recipeIds` or read unrelated recipes. Keep the
dependency-injected read seams and early return on the first authorized
candidate. It is acceptable to repeat the bounded metadata/recipe reads for a
different candidate collection; complexity must be O(1) reads per candidate,
not O(recipes in collection).

Replace the broad `canViewPhoto` usage if it becomes dead, after a fresh usage
search. Tests must prove:

- a live cover or gallery photo succeeds;
- an unrelated owner photo and a chat attachment deny even when their photo
  metadata points at a recipe;
- tombstoned/missing photo metadata, tombstoned/missing recipe, tombstoned
  collection, and freshly revoked/changed share deny;
- a recipe removed from the collection denies through `canViewRecipe`;
- one candidate performs no more than one fresh-share read, one collection
  read, one photo read, and one recipe read, and an authorized first candidate
  prevents reads for later candidates.

No GCS mock is needed; these tests stop at the authorization decision.

### 4. [core] Normalize profile email for mixed-case sharing lookup

**Files:** `server/store.ts`, `server/store.test.ts`,
`server/grants.ts`, `server/grants.test.ts`, and `server/auth.ts` only if its
profile-upsert call needs adjustment.

On every successful admitted sign-in/profile upsert, write both the existing
display/original `email` and server-derived `emailLower` using trim +
lowercase. Keep existing profile merge and sign-in-failure tolerance.

Split sharing lookup into a pure/query-orchestration seam:

- query `users` where `emailLower == normalizedEmail`;
- if that returns no rows, query legacy `email == normalizedEmail`;
- retain the existing latest-`lastSeenAt` selection, owner/member admission
  check, self-share rejection, generic not-found response, and 503 mapping for
  query or membership uncertainty;
- do not broaden the fallback to case variants or return different public
  errors.

Add pure tests for profile normalization and lookup orchestration: primary
match, fallback after an empty primary result, no fallback when primary found,
query failure as unknown, lowercase legacy fallback, latest-row selection,
self detection, and a mixed-case legacy row remaining undiscoverable until
next sign-in/backfill. No emulator is required.

### 5. [core] Validate revoke viewer IDs and make transaction outcomes write-safe

**Files:** `server/grants.ts`, `server/grants.test.ts`,
`server/grantsHttp.ts`, `server/grantsHttp.test.ts`.

Add a pure safe-Firestore-document-ID validator for the viewer `sub` accepted
by revoke. Accept only a nonempty string unchanged by trim, containing no
slash, not equal to `.` or `..`, not matching the reserved `^__.*__$` form,
and no longer than Firestore's 1,500-byte UTF-8 document-id limit. Validate
the exact body value and return 400 before constructing
`grantColRef(...).doc(sub)` or `incomingShareRef(sub, ...)`.

Change the pure revoke transition to distinguish:

- missing forward grant → `missing`;
- live forward grant → `write` with its grant tombstone;
- existing forward tombstone → `already`, retaining the stored tombstone.

Inside the transaction, read the authoritative forward grant first. Map
`missing` to a generic 404 and perform no forward or reverse write. Map
`already` to idempotent 200 `{ ok: true }` and perform no write, especially no
write to an incoming-share path derived from request input. Only `write`
tombstones both forward grant and matching reverse incoming share.

Extract an injected revoke orchestration seam whose dependencies
construct/read the authoritative forward grant and perform the paired write
only after validation. Production dependencies wrap the real Firestore refs
and transaction. Tests must prove malformed input invokes neither dependency
(therefore no `.doc()`); missing and already outcomes invoke no paired write;
only a live grant invokes one paired write.

Add pure/orchestration/status tests for valid IDs, trim changes, slash,
reserved ids, byte-limit overflow, missing grant → generic 404/no-write
outcome, live grant → paired writes, and already-tombstoned grant →
200/no-write outcome. Keep errors generic so revoke does not disclose more
than current behavior.

### 6. [core] Retry collection-delete cascade from an existing tombstone

**Files:** `server/sync.ts`, `server/sync.test.ts`,
`server/store.ts` only if a shared stored-tombstone parser is needed.

Replace the boolean `shouldCascadeCollectionDelete` decision with a pure
function returning a cascade timestamp or no cascade:

- an applied delete cascades at the accepted delete timestamp;
- an unapplied result whose `current` state is a valid tombstone cascades at
  the stored tombstone timestamp;
- an unapplied result whose current state is missing, malformed, or live does
  not cascade.

Pass the returned timestamp to `cascadeCollectionGrants`. This heals a prior
request that committed the collection tombstone but failed during the
post-tombstone grant cascade. It must not let an older delete revoke grants on
a collection that has since been recreated or updated live.

Make the cascade itself race-safe: in every per-viewer transaction, read the
collection document before the forward/reverse grant writes and require a
canonical tombstone whose finite `updatedAt` and `deletedAt` both equal the
requested cascade timestamp. If the collection is missing, malformed, live,
or tombstoned at a different timestamp, skip both grant writes. Because the
collection read participates in the transaction, a concurrent revival causes
a retry that observes the live collection and skips.

Add table-driven pure tests for applied delete, same/newer stored tombstone,
malformed tombstone, stale delete against a newer live collection, and absent
current state. Assert the retry uses stored `deletedAt`/`updatedAt`, not the
incoming stale request timestamp. Add cascade-decision tests for exact
collection tombstone match, timestamp mismatch, malformed/missing, and live
collection; inspect the transaction implementation to confirm the collection
read occurs before any grant/share write.

### 7. [ui] Show `SharedIcon` only for incoming collections

**Files:** `src/screens/Library.tsx` and memory tests only if removal makes a
grant-count UI helper dead.

Remove the owner-side badge condition and its `getGrantCount` render
dependency. A collection chip renders `SharedIcon` exactly when
`isSharedCollection(collection.id)` is true. Keep Share-sheet grant loading
and mutation behavior intact, but do not add grant counts to owned pull,
collection rows, or any schema.

Remove imports/helpers made dead by this UI change. Do not add a DOM test
library; verify the owner/viewer distinction in the browser in step 11.

### 8. [core] Exclude shared-parent chat from backup export

**Files:** `src/lib/backup.ts`, `src/lib/backup.test.ts`.

Filter exported chat messages with the same origin decision used by recipe and
cook filtering: omit a message when `isSharedRecipe(message.recipeId)` is
true. Feed only the retained chat rows to photo attribution, ensuring a shared
recipe's viewer-local Ask attachments are not exported as orphan photos.
Keep owned-parent and existing non-shared/orphan behavior unchanged.

Add export tests with owned and shared recipes, chat on each, and attachments.
Parse the generated backup and assert shared recipes, their chat, cook state,
and chat-only photos are absent while owned rows remain. Assert
`exportedBySub` is still present and no entity schema gains fields.

### 9. [core] Record current sharing limits and production checks

**Files:** `AGENTS.md`, `docs/handoff-invitation-only.md`, and the sharing
section of `docs/plans/shared-recipes.md` where it remains the durable product
decision record.

Reconcile the durable parent plan as well as documenting current limits:

- shared pull is a full positional reread of live incoming grants and current
  collection contents, not an `updatedAt` delta;
- successful sync publishes owned and shared rows atomically, while a non-auth
  shared failure publishes the completed owned-only snapshot;
- email lookup uses `emailLower` first and exact normalized `email` only as a
  legacy lowercase-profile fallback;
- shared photo authorization uses requested photo metadata only as a
  parent-recipe index, then still requires the fresh share, live collection,
  `canViewRecipe`, and `recipeListsPhoto`; photo metadata alone never
  authorizes;
- backup export omits viewer chat and attachments whose parent recipe is
  shared;
- viewers have no leave-shared-collection flow yet;
- viewer-owned chat for a shared recipe can remain orphaned after revoke;
- Ask text is available but Ask photo attachments are intentionally
  unavailable on shared recipes;
- the generic add-by-email account-existence signal is a conscious
  invite-only product choice; do not make responses more revealing;
- first production verification after deploy must exercise a real recipe
  delete that is listed in a collection and confirm the
  `array-contains recipeIds` query/index path succeeds.

Keep legal copy unchanged unless implementation alters data handling beyond
this plan (not expected). Do not add leave UI, orphan cleanup, Ask
attachments, rate limiting, a new email index service, or deployment work.
Replace contradictory statements in `docs/plans/shared-recipes.md`; do not
leave the old `users.email` lookup, photo-metadata prohibition, backup-chat,
or publication behavior authoritative beside the new decisions.

### 10. [core] Run focused and full automated merge gates

Run focused tests while implementing:

```bash
npx vitest run src/lib/syncEngine.test.ts src/lib/libraryMemory.test.ts
npx vitest run src/lib/backupImportRemap.test.ts src/lib/backup.test.ts
npx vitest run server/grants.test.ts server/grantsHttp.test.ts
npx vitest run server/sync.test.ts server/store.test.ts server/shareAuth.test.ts
```

Then run the complete repository gates:

```bash
npm test
npm run build
```

`npm run build` is mandatory because it is the server TypeScript gate. Review
the final diff and confirm:

- the exact Recipe key-set assertion in `src/lib/recipeStore.test.ts` is
  unchanged;
- no fields were added to `Recipe`, `ChatMessage`, or `CookStateRow`;
- no Firestore emulator, GCS mock, DOM test dependency, screen-level fetch,
  client-trusted `ownerSub`, auth-scope change, Vercel-handler change, backup
  marker change, or deployment change was introduced;
- the shared pull remains staged across all pages and all numbered steps in
  this plan are complete.

### 11. [ui] Exercise the final owner/viewer flow in the browser

Run both processes, restarting `dev:api` after server edits:

```bash
npm run dev
npm run dev:api
```

Use `http://localhost:5173` with a signed-in owner and a second admitted
member. Exercise the flows rather than relying on screenshots:

- on successful Settings Refresh, watch the subscriber-visible UI and confirm
  the previous complete library remains until owned + shared data appears
  together; no owned-only flicker and no partially populated shared
  collection;
- force a non-auth `/api/sync/shared` failure, Refresh, and confirm newly
  completed owned state appears, all prior shared rows disappear, the current
  “Couldn't refresh” toast appears, and the user stays signed in;
- restore shared pull and confirm all current shared rows return together;
- confirm only incoming collection chips show `SharedIcon`; an owner sharing a
  collection sees no badge;
- verify shared cover/gallery photos load, while an unrelated owner photo and
  a chat attachment URL return 404 without signing out;
- add by a mixed-case email after that target signs in once on the new code;
  confirm legacy behavior remains generic when no normalized profile exists;
- revoke a real viewer and confirm repeated revoke remains harmless, while a
  malformed slash-containing revoke request returns 400;
- export the viewer library after using Ask on a shared recipe and inspect the
  backup: no shared recipe, shared-parent chat, or attachment is present;
- revisit `/`, `/?c=`, `/recipe/:id`, `/settings`, and the Share sheet because
  they share library, origin, photo, and grant state.

Do not deploy. The real production `array-contains` verification is recorded
for the later explicitly authorized deployment, not run as part of this task.

## BLOCKING questions

None.
