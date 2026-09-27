# Shared collections — PR #23 review fixes

Parent: `docs/plans/shared-recipes.md` (PR 2 view ACLs).
Branch: `cursor/shared-collections-cdc9` (PR #23 on `bluefire2/cook`).

## Goal

Close five confirmed review findings on shared named collections without
changing product scope: shared data stays view-only, ACLs stay on owner REST
(not client LWW push), server remains source of truth, tombstones/LWW unchanged,
no new `Recipe` / `ChatMessage` / `CookStateRow` fields, no polling, screens
still do not `fetch` library data (`remote.ts` / `syncEngine.ts` only; grant
REST stays behind `collectionStore`).

## Assumptions

- Implementers run `npm test`, `npm run build`, and for UI steps `npm run dev`
  + `npm run dev:api` (restart `dev:api` after `server/` edits). No Firestore
  emulator, GCS mock, or DOM testing library.
- Pure unit tests cover transition/decision helpers; Firestore transaction
  ordering is reasoned from helpers + code review, not integration tests.
- Backup format stays `app: 'cook'`, `cook-backup-` filenames, `version: 3`.
  Version 3 gains an optional top-level `exportedBySub` provenance value; this
  is backup metadata, not a `Recipe` / `ChatMessage` / `CookStateRow` field.
- Node `erasableSyntaxOnly`: no enums, no constructor parameter properties in
  new server code.

## Findings map

| # | Symptom | Root cause (today) |
| --- | --- | --- |
| 1 | `/` hammers `GET …/grants` | `Library` effect depends on `collections`; `useCollections()` returns a new array whenever `libraryMemory` emits; `listGrants` → `setGrantCount` always `emit`s even when count unchanged. |
| 2 | Grants dropped while delete rejected | `server/sync.ts` `collection.delete` always calls `cascadeCollectionGrants` after `tombstoneDoc`, even when `applied: false` (stale delete). |
| 3 | Orphan live ACLs; cascade clobber | `collectionGrantsPost` checks collection liveness outside the transaction; `cascadeCollectionGrants` blindly `set`s incoming shares with `{ merge: false }`. |
| 4 | Cap blocks owners with shares | `collectionStore.create` uses `listCollections().length`, which includes `collectionOrigins.kind === 'shared'`. |
| 5 | Shared rows vanish after backup | `importLibrary` preserves ids. If Carol imports Alice's backup and Alice later shares the originals, `mergeSharedFromPull` skips the incoming rows because Carol already owns rows with those ids. |

## Invariants (must hold after fixes)

1. **Grant prefetch:** At most one successful grant-list fetch per owned
   collection id per in-memory library session, unless the user opens Share
   (explicit refresh) or mutates grants (`addGrant` / `revokeGrant`).
2. **Delete cascade:** `cascadeCollectionGrants` runs only when
   `tombstoneDoc` returns `{ applied: true }` for that `collection.delete`.
3. **Grant add:** No forward grant or live incoming share is written unless
   the owner’s collection document is live **inside** the same Firestore
   transaction as the grant writes.
4. **Cascade LWW:** A collection-delete cascade must not tombstone an
   incoming share (or forward grant) whose stored `updatedAt` is **greater**
   than the cascade `at` (stale cascade or concurrent re-grant after a
   superseded delete attempt).
5. **Owned cap:** Client and server cap counts include only **owned** live
   named collections (`!shared` origin on client; live docs in owner tree
   on server — already true server-side).
6. **ID namespace:** A backup exported by another account is imported as a
   clone: recipe, collection, photo, and chat-message ids are remapped to fresh
   UUIDs and every internal reference is rewritten. A backup whose
   `exportedBySub` equals the current session `sub` keeps the existing
   overwrite-by-id restore behavior. Legacy backups with no provenance are
   treated as foreign and cloned, favoring collision safety over legacy
   overwrite semantics.
7. **Same backup, two accounts:** If Alice exports and Carol imports before
   Alice shares, Carol's clone already has fresh ids. Alice's later incoming
   share therefore remains independently addressable. Share-then-import is
   safe for the same reason.

**BLOCKING open questions:** none.

---

## Steps (sequential)

### 1. [core] Pure helpers — owned cap count and incoming-share cascade LWW

**Files:** `src/lib/libraryMemory.ts`, `server/grants.ts`, tests.

- Add `countOwnedNamedCollections(): number` in `libraryMemory.ts`: count
  entries in `snapshot.collections` where `collectionOrigins.get(id)?.kind !==
  'shared'` (treat missing origin as own, matching `upsertCollection`).
- Add exported pure functions in `server/grants.ts` (names illustrative;
  match repo style):
  - `collectionLiveForGrant(txRead: Record<string, unknown> | undefined):
    boolean` — `readStoredState` / `isLiveDoc` equivalent without IO.
  - `incomingShareCascadeDoc(existing: IncomingShareDoc | undefined,
    ownerSub, collectionId, cascadeAt): IncomingShareDoc | null` — return
    tombstone doc only when `existing` is absent or `existing.updatedAt <=
    cascadeAt`; return `null` to skip write when a newer live share exists.
  - Extend `revokeGrantTransition` or add
    `grantCascadeRevoke(existing, viewerSub, cascadeAt)` so forward grant
    tombstones are skipped when an existing live grant has `updatedAt >
    cascadeAt` (mirror incoming-share rule).

**Tests:** `src/lib/libraryMemory.test.ts` — owned count with mixed origins.
`server/grants.test.ts` — cascade LWW cases: newer incoming share survives
stale `cascadeAt`; absent doc gets tombstone; equal `updatedAt` tombstones.

**Verify:** `npm test` (new cases pass).

---

### 2. [core] Finding 2 — gate cascade on applied delete

**Files:** `server/sync.ts`, `server/sync.test.ts` (or `server/store.test.ts`
if sync op tests live there).

- In `applyPushOp` `collection.delete` branch: assign `result` from
  `tombstoneDoc`; call `cascadeCollectionGrants(uid, body.id, body.updatedAt)`
  **only** when `result.applied === true`.
- Document invariant in a one-line comment referencing stale LWW rejection.

**Tests:** Pure/table test on a small extracted function if needed, e.g.
`shouldCascadeCollectionDelete(result: MutationResult): boolean`; or extend
existing `collection.delete` op test to assert cascade is not invoked when
`applied: false` (mock/spy pattern consistent with repo — prefer extracting
the predicate and unit-testing it if full `applyPushOp` is heavy).

**Verify:** `npm test`.

---

### 3. [core] Finding 3 — grant transaction reads live collection; cascade uses LWW helpers

**Files:** `server/grantsHttp.ts`, `server/grants.ts` (`cascadeCollectionGrants`).

**`collectionGrantsPost` transaction (inside `db.runTransaction`):**

- After `tx.get(grantColRef(...))`, `tx.get(collectionDocRef(access.sub,
  collectionId))` (use `collectionDocRef` from `server/store.ts`).
- If collection data is missing or not live (`isLiveDoc`), abort transaction
  with a sentinel outcome → HTTP **404** (same as `requireOwnedLiveCollection`
  missing), not 503.
- Keep email lookup **outside** the transaction (unchanged).

**`cascadeCollectionGrants`:**

- The outer query may enumerate viewer ids only; it is not authoritative for
  LWW. For each viewer, one transaction must `tx.get(grantRef)` and
  `tx.get(incomingShareRef)` before any writes.
- Apply step 1 helpers to those in-transaction snapshots. Forward and reverse
  docs either both tombstone or both skip in that transaction; never decide
  from the outer grant snapshot and never write one side alone.
- Per-viewer transactions remain acceptable. Use step 1 helpers to skip both
  writes when either authoritative doc proves the cascade `at` is stale.
- Do not change revoke/add REST shapes.

**Tests:** `server/grants.test.ts` for helpers; optional thin test that
`collectionGrantsPost` outcome mapping returns 404 when collection read is
dead (if extractable without emulator).

**Verify:** `npm test`; `npm run build`.

---

### 4. [core] Finding 1 — stop grant-count emissions from retriggering Library

**Files:** `src/lib/libraryMemory.ts`, `src/lib/collectionStore.ts`,
`src/screens/Library.tsx`, tests.

**`setGrantCount`:** If `snapshot.grantCounts.get(collectionId) === count`,
return without `emit` (same invariant as `markLoaded` short-circuit).

**`Library.tsx` effect (lines ~105–116):**

- Depend on a **stable** signature of owned collection ids, not the
  `collections` array reference — e.g.
  `ownedCollections.map((c) => c.id).sort().join('\0')` or a small
  `useMemo`d id list from `useCollections()`.
- Required: keep a `useRef<Set<string>>` of ids already prefetched this
  mounted Library session and call `listGrants` only for newly seen owned ids
  (the Share sheet still refreshes explicitly on open).

**`collectionStore.listGrants`:** May keep `setGrantCount` call; with
no-op emit, repeated fetches are harmless.

**Invariant:** Navigating `/` with N owned collections does not cause
unbounded `/api/collections/:id/grants` traffic in the network panel.

**Tests:** `libraryMemory.test.ts` — `setGrantCount` same value does not
notify subscribers (listener call count).

**Verify:** `npm test`.

---

### 5. [core] Finding 4 — owned-only cap in `collectionStore.create`

**Files:** `src/lib/collectionStore.ts`, `src/lib/collectionStore.test.ts`.

- Replace `listCollections().length >= MAX_NAMED_COLLECTIONS` with
  `countOwnedNamedCollections() >= MAX_NAMED_COLLECTIONS`.
- Add unit test: with snapshot containing shared + owned collections at cap
  of **owned** only, `create` succeeds when shared rows push total length
  over cap (mock `libraryMemory` state via public APIs:
  `mergeSharedFromPull` + `upsertCollection`, or direct test of
  `countOwnedNamedCollections` + thin wrapper).

**Invariant:** Server cap (`namedCollectionCreateCapReason` /
`countLiveNamedCollections`) and client pre-check stay aligned for owners
with incoming shares.

**Verify:** `npm test`.

---

### 6. [core] Finding 5 — account-aware backup clone ids

**Files:** new `src/lib/backupImportRemap.ts` (+ test), `src/lib/backup.ts`,
`src/screens/Settings.tsx`, backup tests.

**Backup provenance:**

- Add optional top-level `exportedBySub?: string` to `BackupFile` while
  retaining `version: 3`, `app: 'cook'`, and filenames.
- Pass the signed-in `user.sub` from `Settings` to `exportLibrary` and
  `importLibrary`; export records it.
- Import preserves ids only when `backup.exportedBySub === currentSub`.
  Different or missing provenance uses clone mode.

**Pure module `backupImportRemap.ts` (no `fetch`, no Firestore):**

- Input: compacted backup recipes, collections, chat messages, cook state,
  photos, and an injectable UUID generator.
- Clone mode assigns fresh UUIDs to every recipe, collection, photo, and chat
  message. Rewrite `collection.recipeIds`, recipe `photoId` /
  `galleryPhotoIds`, `chatMessages[].recipeId` / `photoIds`,
  `cookState[].recipeId`, backup photo ids, and photo-attribution recipe ids.
- Preserve ids and current merge/overwrite behavior in same-account mode.
- Do not add fields to `Recipe`, `ChatMessage`, or `CookStateRow`.

**`importLibrary` (`backup.ts`):**

- Decide same-account restore vs clone before optimistic `upsert*`.
- Use one remapped entity graph consistently for memory writes, photo
  uploads, and `pushOps`.

**Tests:**

- Alice export (`exportedBySub: alice`) imported by Carol remaps every entity
  and reference; a later shared pull with Alice's original recipe and
  collection ids installs alongside Carol's owned clone.
- Share-then-import also leaves canonical shared rows untouched.
- Same-account restore preserves ids and overwrites owned rows as before.
- Legacy backup with no provenance clones safely.
- Photo ids and chat/cook/collection recipe references follow remapped ids.

**Verify:** `npm test`.

---

### 7. [ui] Browser verification — grant prefetch, cap, backup + share

**Manual (signed-in member with at least one owned named collection):**

1. Open `http://localhost:5173/` (not Share sheet). DevTools Network:
   filter `grants` — expect **one** GET per owned collection, not a loop.
2. Owner with many **incoming** shared collections at client cap edge: create
   a new owned collection — should succeed when owned count &lt; 50 even if
   total switcher rows &gt; 50.
3. **Backup collision, both orders:** (a) Carol imports Alice's backup, then
   Alice shares the original collection; (b) Alice shares first, then Carol
   imports. After Settings Refresh in both cases, the shared
   collection/recipe and Carol's owned clone are independently visible and
   have different ids. Cover photos resolve from the correct owner.
4. **Share sheet** still loads grants on open; add/revoke updates badge count.

**Regression:** Stale collection delete from a second device must not revoke
grants when server rejects delete (exercise via unit tests in steps 2–3; no
multi-device manual required if tests cover predicate).

**Verify:** `npm run build` before manual pass.

---

### 8. [core] Final CI gate

From repo root:

```bash
npm test
npm run build
```

Both must pass. No changes to `vercel.json`, Vercel handlers, or
`recipeStore.test.ts` schema lock.

---

## Files touched (summary)

| File | Findings |
| --- | --- |
| `src/lib/libraryMemory.ts` | 1, 4 |
| `src/lib/collectionStore.ts` | 1, 4 |
| `src/screens/Library.tsx` | 1 |
| `src/lib/backupImportRemap.ts` | 5 (new) |
| `src/lib/backup.ts` | 5 |
| `src/screens/Settings.tsx` | 5 (pass current account provenance) |
| `server/sync.ts` | 2 |
| `server/grants.ts` | 3 |
| `server/grantsHttp.ts` | 3 |
| `*.test.ts` | 1–6 |

No `AGENTS.md` or legal copy updates unless manual testing exposes user-facing
wording bugs (not expected).
