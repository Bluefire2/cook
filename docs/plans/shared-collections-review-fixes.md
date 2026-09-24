# Shared collections — PR #23 review fixes

Parent: `docs/plans/shared-recipes.md` (PR 2 view ACLs).
Branch: `cursor/shared-collections-cdc9` ([PR #23](https://github.com/kyrylochernihivskiy/cook/pull/23)).

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
- Node `erasableSyntaxOnly`: no enums, no constructor parameter properties in
  new server code.

## Findings map

| # | Symptom | Root cause (today) |
| --- | --- | --- |
| 1 | `/` hammers `GET …/grants` | `Library` effect depends on `collections`; `useCollections()` returns a new array whenever `libraryMemory` emits; `listGrants` → `setGrantCount` always `emit`s even when count unchanged. |
| 2 | Grants dropped while delete rejected | `server/sync.ts` `collection.delete` always calls `cascadeCollectionGrants` after `tombstoneDoc`, even when `applied: false` (stale delete). |
| 3 | Orphan live ACLs; cascade clobber | `collectionGrantsPost` checks collection liveness outside the transaction; `cascadeCollectionGrants` blindly `set`s incoming shares with `{ merge: false }`. |
| 4 | Cap blocks owners with shares | `collectionStore.create` uses `listCollections().length`, which includes `collectionOrigins.kind === 'shared'`. |
| 5 | Shared rows vanish after backup | `importLibrary` `upsertRecipe` / `upsertCollection` force `kind: 'own'`; `mergeSharedFromPull` skips ids already in maps — backup/restored UUIDs can collide with incoming shared ids (UUID collision is rare but real; same backup on two accounts is a separate, safe case). |

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
6. **ID namespace:** On import, **shared** recipe/collection ids in memory
   are never overwritten by backup rows; conflicting backup ids are remapped
   to fresh UUIDs with references rewritten inside the backup payload only.
   Own-on-own backup merge (“existing ids get overwritten”) is unchanged.
7. **Same backup, two accounts:** Each Google `sub` has its own Firestore
   tree; importing the same `cook-backup-*.json` on two members creates
   duplicate ids in **different** `users/{sub}` paths — no viewer-level
   collision. Finding 5 is **per signed-in library** (shared ∪ own in memory).

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

- For each grant doc, read current incoming share in the same transaction
  (batch reads first, then writes — respect Firestore read-before-write order).
- Use step 1 helpers: skip forward/incoming writes when LWW says the cascade
  `at` is stale relative to existing docs.
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
- Optional hardening: `useRef<Set<string>>` of ids already prefetched this
  session; only call `listGrants` for new owned ids (still call from
  `ShareCollectionSheet` on open).

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

### 6. [core] Finding 5 — backup import remaps ids that collide with shared rows

**Files:** new `src/lib/backupImportRemap.ts` (+ test), `src/lib/backup.ts`,
`src/lib/libraryMemory.test.ts` or `src/lib/backup.test.ts`.

**Pure module `backupImportRemap.ts` (no `fetch`, no Firestore):**

- Input: compacted backup entities (`recipes`, `collections`, `chatMessages`,
  `cookState`, photo id list) + `occupiedSharedIds: ReadonlySet<string>`
  (all recipe/collection ids where `recipeOrigins` / `collectionOrigins`
  are `kind: 'shared'` in current snapshot).
- Output: remapped entities + `Map<oldId, newId>` for every remapped id.
- Rule: for each backup recipe/collection id in `occupiedSharedIds`, assign
  `crypto.randomUUID()` (inject uuid fn in tests); rewrite:
  - `collection.recipeIds`
  - `chatMessages[].recipeId`
  - `cookState[].recipeId`
  - photo attribution map keys/values as needed in `importLibrary`
- Do **not** remap ids that only collide with **owned** rows (backup still
  overwrites owned per existing contract).
- Do **not** add fields to `Recipe` / `ChatMessage` / `CookStateRow`.

**`importLibrary` (`backup.ts`):**

- Before the optimistic `upsert*` loop, build `occupiedSharedIds` from
  `captureSnapshot()` origins.
- Run remap; use remapped arrays for memory + `pushOps`.
- Photos: remapped recipe ids for `postPhoto(..., recipeId, ...)`.

**Same backup across two accounts:** Document in test comment only —
remap is keyed off **current viewer** shared origins; two accounts importing
the same file do not share memory or `incomingShares`; no extra logic.

**Tests:**

- Shared id `S` in memory + backup recipe `S` → after import, own copy has
  new id `S'`, `getRecipe(S)` still shared, `mergeSharedFromPull` can still
  refresh shared row.
- Backup id collides with owned only → still overwrites owned (unchanged).
- Collection in backup references remapped recipe id.

**Verify:** `npm test`.

---

### 7. [ui] Browser verification — grant prefetch, cap, backup + share

**Manual (signed-in member with at least one owned named collection):**

1. Open `http://localhost:5173/` (not Share sheet). DevTools Network:
   filter `grants` — expect **one** GET per owned collection, not a loop.
2. Owner with many **incoming** shared collections at client cap edge: create
   a new owned collection — should succeed when owned count &lt; 50 even if
   total switcher rows &gt; 50.
3. **Backup collision:** Grantee with a shared recipe visible; import a backup
   that contains the same recipe id (fixture file prepared by copying id from
   shared row into a minimal `cook-backup-*.json`). After import + Settings
   Refresh, shared collection/recipe still visible; owned imported copy exists
   under a different id.
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
| `src/lib/libraryMemory.ts` | 1, 4, 5 (occupied set helper if needed) |
| `src/lib/collectionStore.ts` | 1, 4 |
| `src/screens/Library.tsx` | 1 |
| `src/lib/backupImportRemap.ts` | 5 (new) |
| `src/lib/backup.ts` | 5 |
| `server/sync.ts` | 2 |
| `server/grants.ts` | 3 |
| `server/grantsHttp.ts` | 3 |
| `*.test.ts` | 1–6 |

No `AGENTS.md` or legal copy updates unless manual testing exposes user-facing
wording bugs (not expected).
