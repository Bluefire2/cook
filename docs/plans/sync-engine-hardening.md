# Sync engine hardening

## Status of this document

**Findings, not an approved plan.** These are pre-existing defects in `src/lib/syncEngine.ts`
found while auditing `docs/plans/sync-toast.md`. They were deliberately excluded from that feature
because none of them is needed for a toast, and bundling them would have turned a small UI addition
into a rewrite of the sync engine's concurrency model.

Each item below records the evidence and a proposed direction, at enough detail to pick up cold.
Before any of it is implemented it must go through the normal pipeline — planner, then auditor to
APPROVE — because several items interact with each other and with the ownership/migration logic
that guards against data loss.

Nothing here is known to have caused user-visible damage. They are ordered by expected impact.

## 1. `resyncFromServer()` races an in-flight pull

**Evidence.** `resyncFromServer()` deletes `syncMeta['cursor']` and then calls `sync()`. `sync()`
returns the existing `inFlight` promise when a run is already active, and `pullAll()` reads the
cursor once at its start. So a resync tapped while a visibility- or online-triggered sync is
already running joins that run, which is already pulling from the *old* cursor. The user's
last-resort "pull everything again" silently does nothing of the kind, and the Settings button
still resolves and looks successful.

**Direction.** Make the cursor deletion and the pull that follows it one serialized unit: wait for
any current `inFlight` to settle, then start a guaranteed new run rather than joining one.
Consider an explicit queued-intent flag (`resyncRequested`) that the next run consumes, so two
taps cannot start two full resyncs.

**Why deferred.** Pre-existing and unrelated to the toast, which only reports whatever the run it
observed actually did.

## 2. The Dexie lease fallback does not check ownership

**Evidence.** In `withLock`'s non-`navigator.locks` path, the 5-second refresh interval writes
`syncMeta['lease']` unconditionally, and the `finally` deletes it unconditionally. A tab that was
throttled long enough for its lease to expire will, on its next interval tick, overwrite the lease
another tab has since taken, and will then delete it on completion. After that both tabs believe
they hold the lock and can drain the same outbox concurrently.

**Direction.** Do the refresh and the delete inside a `db.transaction('rw', db.syncMeta, …)` that
reads first and acts only when `lease.owner === TAB_OWNER`. On discovering the lease is lost, stop
the interval; do not try to abort the run mid-flight, since the ops are idempotent and LWW and a
forced abort is worse. Catch and log the rejected async transaction so it cannot become an
unhandled rejection outside `sync()`'s catch.

**Why deferred.** Only affects browsers without the Web Locks API (older WebKit). Worst observed
consequence is duplicated work and a duplicated toast.

## 3. A parseable-but-invalid session proceeds through ownership logic

**Evidence.** Both `sync()` and `confirmMigration()` read `localStorage['cook.session']` and only
guard against `JSON.parse` throwing. A stored `{}` — or any object without `sub` — yields
`sub === undefined`, which then flows into `syncOwnershipDecision(ownerUid, undefined, rowCount)`
and, on the `wipe-and-pull` branch, into `wipeForAccountSwitch(undefined)`, which would write
`cook.ownerUid = "undefined"`.

**Partly addressed.** `docs/plans/sync-toast.md` step 3 validates
`typeof sub === 'string' && sub !== ''` in the two functions the toast work touches. What remains
is auditing **every** reader of `cook.session` for the same assumption, and deciding whether an
unusable cached session should be actively cleared rather than merely ignored.

## 4. Malformed but successful push responses

**Evidence.** `drainOutbox` does `const body = (await response.json()) as PushResponse;` and then
indexes `body.results[i]`. A 200 response with invalid JSON, or with `results` missing or not an
array, throws inside the drain. There is also no handling for a `results` array that is shorter
than the batch or whose `index` fields do not line up with the ops sent.

**Partly addressed.** The toast plan's central `catch` in `sync()` turns any such throw into a
visible error toast and a recoverable `error` status instead of a silent rejection that wedges the
UI at `syncing`.

**What remains.** A deliberate policy: validate the response shape before use; decide whether a
malformed response should increment `attempts` (it is a server bug, not a client one, so parking
rows after five tries may be wrong); and decide how to handle misaligned `index` values rather than
trusting positional order.

## 5. An ordinary sync overlapping a migration does redundant work

**Evidence.** `confirmMigration()` calls `runSyncInner` directly, outside `inFlight` and outside
`withLock`. An `online` or `visibilitychange` trigger firing during the migration pull starts a
second, concurrent run against the same tables.

**Direction.** Serialize migration through the same in-flight mechanism *without* letting it join an
unrelated run — the naive fix of calling `sync()` from `confirmMigration` is wrong, because joining
an existing run means the migration pull never happens and `AccountGate` stays stuck on its `busy`
flag. Something like a queued exclusive-run primitive is needed, which is why this belongs with
items 1 and 2 rather than on its own.

**Why deferred.** Both runs are LWW and idempotent, so the outcome converges; the cost is wasted
requests. The toast cannot leak over the gate, because `runSyncInner` no longer emits and the gate
is mounted structurally above the toast.

## Suggested grouping if this is picked up

Items 1, 2 and 5 are one piece of work: they are all the same missing primitive, an exclusive
"run this sync alone, and queue rather than join" lock that behaves the same with and without the
Web Locks API. Items 3 and 4 are independent input-validation work and could ship separately or
first, since they are small and carry no concurrency risk.
