# Failed cook tap versus a newer pulled step

## Goal

A failed cook push restores its optimistic row after an overlapping pull publishes. That restore only checks whether a later local write replaced the same recipe (`stillCurrent`). It does not look at the row the pull just published. The next tap is then computed from the failed step and sent with a fresh `Date.now()`, so it can overwrite another device's newer step on the server.

The server already last-write-wins cook docs on the client `updatedAt` it stores. The client drops that timestamp in `normalizeCookChange`, so the in-memory row cannot tell a newer pulled step from the stale pre-tap row. Keep one `updatedAt`, captured once at the tap, on the optimistic row and on the push. After the follow-up read publishes, skip the existing `preserve` callback when the published row's `updatedAt` is strictly greater. Do not add a field to `Recipe`, and do not add a flag to `withLocalWrite`.

## Constitutions applied

- **Client state** (`docs/constitutions/client-state.md`), read in full. Principles 1, 2, and 4 apply. `upsertCook` stays the only cook-row writer. `preserve` either returns without writing or calls `upsertCook`; it does not mutate a published map. No new store, subscription, selector, or render read of the timestamp. `selectCookRow` already returns the row object the snapshot holds. Screens keep reading servings, step, and checks through `progressFor`. No amendment.
- **Cook log** (`docs/constitutions/cook-log.md`), principle 1 read. This change is cook progress, not a cook-log entry. It does not put a rating, count, lesson, or any other cook-log field on `Recipe`, `ChatMessage`, or `CookStateRow`. `useCookState.ts` is outside that constitution's `scope`. No amendment.
- **i18n** and **image import** do not apply. No user-facing string, no `Recipe.lang`, no import photos.

## Starting state

Verified on this tree. Do not re-derive it from `docs/plans/sous-oauth-db.md`; that plan describes the old Dexie row, which deliberately omitted `updatedAt`. The library is in memory now, and the bug is that the in-memory row still omits the clock the server already uses.

### Cook tap and restore

`CookStateRow` in `src/lib/useCookState.ts` is `{ recipeId, servings, currentStep, checkedKeys, recipeUpdatedAt }`. `recipeUpdatedAt` is the recipe revision the step was recorded against. `progressFor` resets `currentStep` and `checkedKeys` when it differs from `recipe.updatedAt`, and leaves servings. It is not the progress-write clock.

`cookStateStore.update` builds `next` without its own timestamp, then pushes `{ ...next, updatedAt: Date.now() }`. On a result other than `'ok'` or `'signedOut'` it returns `preserve: () => upsertCook(next)` and `stillCurrent: () => cookWriteGeneration.get(recipe.id) === generation`. `cookWriteGeneration` is bumped only by a cook-progress write, because a pull replaces the row object and object identity cannot tell a later tap from the snapshot.

`src/lib/localWrite.ts` `flushReread` samples `stillCurrent` into `keep` before `pullAfterLocalWrite`, then calls `preserve` only when the follow-up outcome is `'ok'` or `'error'` and `keep[i]` is true. `'superseded'` defers the batch and samples again later. The comment on `withLocalWrite` says a new one-row write must not add another `reread` or `preserve` switch. Sign-out writes nothing back (`preserve` is omitted when the push returns `'signedOut'`, and `withLocalWrite` also drops `preserve` when `reconcile` is true).

`pullAll` in `src/lib/syncEngine.ts` starts from an empty cook map and applies every owned page, then `replaceFromPull` / `replaceFromPullWithShared` publishes that map. A live row missing from that snapshot is absent. A tombstone deletes the id inside `applyPullChanges`. `getCook` after `preserve`'s turn is the row that publish left, or `undefined`.

### Pull already carries the clock

`server/sync.ts` `cookState.put` passes `body.updatedAt` into `putDoc` as the client LWW time. `validateCookStatePut` in `server/store.ts` already requires a finite `updatedAt`. `chatOrCookPutBody` stores that client `updatedAt` and a separate `serverUpdatedAt`. `compareMutation` rejects a live put only when `storedAt > clientUpdatedAt`. An equal timestamp is allowed.

`docToChange` for a live `cookState` doc returns `chatCookPullFields`. That copy deletes `serverUpdatedAt` and `deletedAt` and puts `sharedParentOwnerSub` back only when it is a non-empty string. It does not delete `updatedAt`. A tombstone is `{ id, deletedAt }` only. No server change.

`normalizeCookChange` in `src/lib/remote.ts` returns `'tombstone'` when `deletedAt` is set, and otherwise builds a row from `recipeId`, `servings`, `currentStep`, `checkedKeys`, and `recipeUpdatedAt`. A finite `updatedAt` on the wire is dropped. `sharedParentOwnerSub` is not copied onto the row; `applyPullChanges` still reads it from the raw change into `cookParentOrigins`.

### Key locks

`src/lib/remote.test.ts` (`normalizeChatChange / normalizeCookChange`) feeds `updatedAt: 4` into `normalizeCookChange` and expects the keys `checkedKeys`, `currentStep`, `recipeId`, `recipeUpdatedAt`, `servings`. The same test expects no `sharedParentOwnerSub` on the row.

`src/lib/syncEngine.test.ts` asserts that same five-key list for the revoked-recipe cook rows in the shared-parent sidecar tests (the `applyPullChanges` block around the `revoked` cook row, and `keeps shared parent sidecars from owned pull after the shared recipe is gone`). Those fixtures do not include `updatedAt`.

`scripts/invariants.test.ts` does not mention `CookStateRow` and does not encode the AGENTS.md "do not add fields" sentence. `src/lib/recipeStore.test.ts` locks recipe keys via `compactRecipe`. Nothing there reads cook rows.

`src/lib/pushOps.ts` types `cookState.put` as `CookStateRow & { updatedAt: number }`. The payload must still have a definite `updatedAt` even when the row field is optional.

### Backup

`exportLibrary` JSON-stringifies the in-memory cook rows (after stripping `sharedParentOwnerSub` only). `importLibrary` upserts those rows and pushes `{ ...row, updatedAt: Date.now() }`. Backup version is 4. `app` stays `'cook'`. Old files omit a cook-row timestamp. There is no cook compact that would reject an extra `updatedAt`.

### Photo delete

`photoStore.remove` drops the id, then pushes `photo.delete`. On failure it restores the id only when `result !== 'signedOut'` and `localWriteOverlapsPull(epoch)` is false. That restore runs before `withLocalWrite` returns, and the returned result sets `reread: 'no'`. When a pull did overlap, it sets `reread: 'always'`, `reconcile: false`, and no `preserve`. `flushReread` therefore has nothing to put back after the follow-up publish. The pull snapshot is the library: `keeps a remote photo when the follow-up snapshot still lists it` comes from the pull listing the id, and `leaves a photo gone when the follow-up snapshot omits it` leaves a tombstone or omission in place. There is no path that paints a local delete back over a newer published state.

### Tests that already keep the failed tap

These follow-up fixtures are `cook(0)` / `pullDoc(cook(0))` with no `updatedAt`. After this change they are the missing-timestamp row and must still end on the optimistic step:

- `rereads a failed cook tap and keeps the optimistic step` in `src/lib/optimisticWrite.test.ts`. The follow-up page publishes the pre-tap row. This is the missing-timestamp proof.
- `keeps a failed cook tap when another pull publishes during the quiet window`. A pull publishes the pre-tap row, then `preserve` puts the optimistic step back.

`does not put a failed cook tap back over a later successful one` is the `stillCurrent` proof (generation bumped by the later tap). Its follow-up fixture is `cook(2)` with no `updatedAt`. It must keep passing because the failed tap's `preserve` does not run, not because of the new timestamp check.

No current test publishes a cook row with a finite `updatedAt`.

## Decisions

**Field name.** `updatedAt?: number` on `CookStateRow`. That is the wire field `chatCookPullFields` already returns and the field `compareMutation` already compares. Do not invent a second name, and do not store the clock only in a module-level map: a pull replaces the row, and the next session has to see the published stamp.

**Optional, omitted when unusable.** Old docs, old backups, and the existing pull fixtures have no cook-row timestamp. A missing value, or any value that is not a finite number (`NaN`, `Infinity`, a string, `null`), is omitted. Do not set `updatedAt: undefined` or `updatedAt: 0` in its place. `Object.keys` must stay the five-key list for those rows. A present finite number is kept, including `0` and negatives. Comparison treats an omitted or non-finite stamp as `0`, which is not newer than `Date.now()`.

**`Progress` omits it.** `Progress` becomes `Omit<CookStateRow, 'recipeId' | 'recipeUpdatedAt' | 'updatedAt'>`. Callers of `updateCookState` keep passing servings, step, and checks. `progressFor` does not read or return `updatedAt`. `recipeUpdatedAt` keeps its current meaning and its comment must say it is not the progress-write clock.

**One clock for the row and the push.** `const updatedAt = Date.now()` once inside `cookStateStore.update`. The optimistic row and the `cookState.put` payload both use that binding. Do not call `Date.now()` a second time in the payload. Because `updatedAt` is optional on the row, the payload stays assignable by spreading the same binding: `payload: { ...next, updatedAt }`.

**Where the comparison lives.** Inside the existing cook `preserve` callback, which runs after the follow-up publish. `stillCurrent` stays the generation check, sampled in `flushReread` before the pull. Do not move the timestamp check into `stillCurrent`: that function runs before the pull and cannot see the published row. Do not add a field to `LocalWriteResult`, a new `reread` choice, or any other `withLocalWrite` flag.

**Comparison.** Let `publishedAt` be `finiteCookUpdatedAt(getCook(recipe.id)?.updatedAt) ?? 0` and `failedAt` the captured `updatedAt`. If `publishedAt > failedAt`, return without `upsertCook`. Otherwise call `upsertCook(next)`. Strictly greater matches `compareMutation`, which rejects only when the stored time is greater. Equal keeps today's restore: a lost response whose pull echoes this write must not be replaced by a different step, and the stale pre-tap row (missing or older) must still be replaced by the optimistic step. Do not compare `currentStep`. Another device moving backward is still a newer write when its timestamp is greater.

A missing published row, including a cook tombstone that deleted the id, has stamp `0` and is restored. That is the specified "missing" case. Do not special-case tombstones.

**Helper placement.** Export `finiteCookUpdatedAt(value: unknown): number | undefined` from `src/lib/remote.ts` next to `normalizeCookChange`. Predicate: `typeof value === 'number' && Number.isFinite(value) ? value : undefined`. `normalizeCookChange` and the `preserve` callback both use it. `useCookState.ts` already imports `pushOps` from `remote.ts`. Do not add a value import of `useCookState.ts` from `remote.ts`; the existing import is type-only, and a value import would cycle.

**Photo delete.** Leave `src/lib/photoStore.ts` and its tests unchanged. Do not add a photo timestamp, a `Recipe` field, or a `preserve` callback. The follow-up pull is already the source of truth, and a failed delete does not restore the id when a reread will run.

**Backup.** No edit to `src/lib/backup.ts`. Version stays 4. `app` stays `'cook'`. Filenames stay `cook-backup-`. Import of a row with or without `updatedAt` keeps working. The cook push stays `{ ...row, updatedAt: Date.now() }`, so a timestamp inside an old or new file does not become the LWW time of the import. `remapCookRow` already spreads the row, so a present `updatedAt` survives clone remapping. Do not strip it.

**AGENTS.md.** Do not edit it. `scripts/invariants.test.ts` will not fail. The sentence "Do not add fields to `Recipe`, `ChatMessage`, or `CookStateRow`" is the warning not to expand the recipe/chat/cook-log schema locks (`compactRecipe`, `src/lib/recipeStore.test.ts`, and the cook-log key lock). This `updatedAt` is the deliberate exception for the cook-progress LWW clock. Do not revert the field to satisfy that sentence. Do not "fix" the sentence by adding `updatedAt` to the recipe allow-list or to `ChatMessage` / `CookLog`. Do not add this plan to the AGENTS.md plans table.

**No constitution amendment.** The change does not break a client-state or cook-log principle.

## Steps

### 1. [core] Carry `updatedAt` on the cook row and skip `preserve` when the published row is newer

Files: `src/lib/useCookState.ts`. Import `finiteCookUpdatedAt` from `./remote` (step 2 adds it; land the two together).

- Add optional `updatedAt?: number` to `CookStateRow` with a comment that it is the client time of this progress write, absent on old rows, and not the recipe revision.
- Keep `recipeUpdatedAt`. Adjust its comment so it cannot be read as the progress-write clock. Do not use it inside the new comparison.
- Change `Progress` to `Omit<CookStateRow, 'recipeId' | 'recipeUpdatedAt' | 'updatedAt'>`.
- In `cookStateStore.update`, capture `const updatedAt = Date.now()` before building `next`. Set `next.updatedAt` to that binding. Push `{ kind: 'cookState.put', payload: { ...next, updatedAt } }` using the same binding.
- Leave `bumpCookWrite`, `reconcile: result === 'ok'`, and the `stillCurrent` generation check as they are. Omit `preserve` and `stillCurrent` for `'ok'` and `'signedOut'`, as today.
- Replace the failed `preserve` body with: read `getCook(recipe.id)` at call time; if `(finiteCookUpdatedAt(published?.updatedAt) ?? 0) > updatedAt`, return; otherwise `upsertCook(next)`. Close over `next` and `updatedAt`. Do not call `Date.now()` inside `preserve`. Do not read `currentStep` for the decision.

Acceptance:

- The optimistic row's `updatedAt` and the push payload's `updatedAt` are the same number.
- A later local tap still bumps `cookWriteGeneration`, so the earlier `preserve` does not run.
- A published row with a strictly greater finite `updatedAt` stays after the reread. The next `updateCookState` reads that row through `progressFor`.
- A published row that is missing, has no finite `updatedAt`, or has an equal or lower finite `updatedAt` is replaced by `next`.
- `useCookState` still does not read `updatedAt`. No new selector and no new subscription.
- `upsertCook` is still the write. The published cook map is not mutated in place.

### 2. [core] Keep a finite cook `updatedAt` through normalize

Files: `src/lib/remote.ts`.

- Add `finiteCookUpdatedAt` as specified above.
- In `normalizeCookChange`, keep the `deletedAt` tombstone return first. On a live row, copy `updatedAt` only when `finiteCookUpdatedAt(raw.updatedAt)` is defined. Omit the property otherwise. Do not copy `sharedParentOwnerSub`, `serverUpdatedAt`, `uid`, or `sub`.
- Leave `applyPullChanges` sidecar handling as it is. It must keep reading `sharedParentOwnerSub` from the raw change, not from the normalized row.

Acceptance:

- A live change with `updatedAt: 4` normalizes to a row whose `updatedAt` is `4`.
- A live change with no `updatedAt`, or with `NaN`, `Infinity`, or a non-number, normalizes without throwing and without an `updatedAt` key.
- A change with `deletedAt` set is still `'tombstone'`.
- `sharedParentOwnerSub` is still absent on the row and still present on `cookParentOrigins` when the raw change has a non-empty string.

### 3. [core] Lock the new row in unit tests

Files: `src/lib/remote.test.ts`, `src/lib/syncEngine.test.ts` only if a fixture starts including `updatedAt` (it should not), `src/lib/optimisticWrite.test.ts`. No new test dependencies. Node Vitest only.

`src/lib/remote.test.ts`, in `normalizeChatChange / normalizeCookChange`:

- The existing live cook object includes `updatedAt: 4`. Change its key assertion to `['checkedKeys', 'currentStep', 'recipeId', 'recipeUpdatedAt', 'servings', 'updatedAt']`. Keep `expect(cook).not.toHaveProperty('sharedParentOwnerSub')` and `expect(cook.updatedAt).toBe(4)`.
- Add cases on the same normalizer: missing `updatedAt`; `updatedAt: Number.NaN`; `updatedAt: Number.POSITIVE_INFINITY`; `updatedAt: '4'`. Each returns a row with no `updatedAt` key and does not throw. A `deletedAt` change is still `'tombstone'`.
- The sidecar test's cook fixture has no `updatedAt`. Leave its "no `sharedParentOwnerSub` on the row" assertion. Do not add `updatedAt` to that fixture.

`src/lib/syncEngine.test.ts`:

- Leave both five-key assertions (`checkedKeys`, `currentStep`, `recipeId`, `recipeUpdatedAt`, `servings`) and their fixtures. They are the absent-timestamp key set. Do not insert `updatedAt: 0`.

`src/lib/optimisticWrite.test.ts`. Cook fixtures used by the tests named in Starting state stay without `updatedAt`. Add three cases beside `rereads a failed cook tap and keeps the optimistic step`. Use the same `startSync` / gate style as that test so the follow-up page can be built after the failed push is visible. The recipe `updatedAt` and the pulled row's `recipeUpdatedAt` must both stay `2` (`recipe()` and `cook()`), or `progressFor` will reset the step and the following tap will not be `currentStep + 1`.

1. **Newer device.** Seed step 0. Push returns `'error'`. Tap to `currentStep: 1`. Read the failed `cookState.put` payload and keep its `updatedAt` as `failedAt`. The follow-up page publishes `{ ...cook(4), updatedAt: failedAt + 1 }` (a different step and a greater stamp). After the reread, `getCook(RECIPE_ID)` is that pulled row (`currentStep === 4`, `updatedAt === failedAt + 1`). Then `pushOps` returns `'ok'` and `updateCookState` does `(prev) => ({ ...prev, currentStep: prev.currentStep + 1 })`. The new `cookState.put` has `currentStep === 5` and an `updatedAt` strictly greater than `failedAt + 1`, equal to the in-memory row's `updatedAt`. It must not be `2` (failed step `1` plus one) and must not reuse `failedAt`.
2. **Older stamp.** Same failed tap to step 1. Follow-up publishes `{ ...cook(0), updatedAt: failedAt - 1 }`. After the reread, `currentStep` is `1` and `updatedAt` is `failedAt`.
3. **Equal stamp.** Same failed tap to step 1. Follow-up publishes `{ ...cook(7), updatedAt: failedAt }`. After the reread, `currentStep` is `1` and `updatedAt` is `failedAt`. This locks `>` rather than `>=`.

The existing missing-timestamp tests listed above are the missing-`updatedAt` coverage. Do not duplicate them. Do not weaken `does not put a failed cook tap back over a later successful one`.

`CookStateRow` object literals elsewhere (`optimisticWrite.test.ts` `cook()`, `syncEngine.test.ts` `cook()`, `libraryMemory.test.ts` `cookRow()`, `backup.test.ts` `COOK`, `backupImportRemap.test.ts`, `librarySelectors.test.ts`) stay valid because `updatedAt` is optional. Do not add the field to them unless a test is asserting a written tap's row.

Acceptance: `npm test` and `npm run build` pass. No fake-indexeddb, Firestore emulator, or DOM testing library.

## Tests

Gates are `npm test` and `npm run build`.

| Case | Where |
| --- | --- |
| Finite `updatedAt` kept; non-finite and missing omitted; tombstone unchanged; sidecar unchanged | `src/lib/remote.test.ts` |
| Absent-timestamp key list unchanged | `src/lib/syncEngine.test.ts` assertions left as they are |
| Failed tap, pull publishes a greater `updatedAt` and a different step; next tap pushes that step + 1 | new test in `src/lib/optimisticWrite.test.ts` |
| Older finite `updatedAt` still restored | new test in the same file |
| Equal `updatedAt` still restored | new test in the same file |
| Missing `updatedAt` still restored | existing `rereads a failed cook tap and keeps the optimistic step` and `keeps a failed cook tap when another pull publishes during the quiet window` |
| Later local tap still wins | existing `does not put a failed cook tap back over a later successful one` |

## Out of scope

- Server LWW, `validateCookStatePut`, `chatOrCookPutBody`, `chatCookPullFields`, and the `cookState.put` wire shape. The pull does not strip `updatedAt`.
- `Recipe`, `ChatMessage`, and `CookLog` fields. Do not expand `compactRecipe` or `src/lib/recipeStore.test.ts`.
- Cook-log data on `CookStateRow`. No constitution amendment.
- A new `withLocalWrite` flag, a second reread path, or a change to when `stillCurrent` is sampled.
- `src/lib/photoStore.ts` and the photo-delete tests.
- Backup version, `app: 'cook'`, `cook-backup-` filenames, and the import push's `Date.now()`.
- `AGENTS.md`, `scripts/invariants.test.ts`, i18n catalogs, and `docs/i18n-review/screens.json`.
- UI copy and screens. Nothing renders the timestamp.
- Client clock skew. LWW stays on client `updatedAt`. This only stops a failed tap from being restored over a pull that already holds a greater stamp.
- Deploy.
