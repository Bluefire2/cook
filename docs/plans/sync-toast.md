# Sync toast

## Goal

Show a transient in-app toast when a background sync finishes **and that sync actually moved
data** — at least one outbox op accepted by the server, or at least one row written into Dexie
from server data that genuinely differs from what was already stored. A sync that finds nothing to
do (the common case on app open and on tab focus) shows nothing. A sync that **fails** shows a
toast in the app's danger style so the failure is not silent; Settings keeps its existing inline
error line as well.

Toasts auto-dismiss, never block interaction, are never modal, never steal focus, and are
announced to screen readers.

Client-only. No wire-contract change, no new dependencies, no Dexie schema change.

## Scope

This plan is deliberately narrow. Auditing it surfaced a set of pre-existing weaknesses in the
sync engine (lease ownership across tabs, `resyncFromServer` racing an in-flight pull, a
parseable-but-empty session, a malformed-but-HTTP-200 push response, redundant work when an
ordinary sync overlaps a migration). Those are **not** required for the toast and are recorded
separately in `docs/plans/sync-engine-hardening.md`. The "Deferred" section below names each one
and states the residual risk it leaves for this feature, so nothing is silently dropped.

Three defects **are** in scope, because without them the toast is untruthful or absent:

1. **401 during pull reports a clean sync.** `pullAll()` handles a 401 by calling
   `invalidateSession()`, `setSnapshot({ status: 'signedOut' })` and `return` — it does not throw.
   `runSyncInner` therefore continues past the `try`, overwrites the snapshot with
   `status: 'idle'`, and emits success. A session expiring mid-pull currently reports "synced".
2. **An exception inside a sync produces no toast and wedges the UI.** Nothing wraps
   `drainOutbox()`. If it throws — a malformed 200 response whose `body.results` is not an array
   is enough — the rejection propagates out of `runSyncInner` and `withLock`, `sync()` rejects, no
   result is reported, and `status` is left at `'syncing'`, which disables the Settings buttons
   permanently. Settled decision 2 requires a failure to be visible.
3. **A throwing listener breaks the emit loop.** `emitSyncFinished` (like `emit`) iterates
   listeners with no isolation. One throwing listener skips every later listener and rejects
   `sync()`.

## Starting state (verified by reading the code, not assumed)

A first, naive version already exists and is wired up:

- `src/components/SyncToast.tsx` renders a top-centre pill reading "The app has synced".
- `src/App.tsx` already renders `<SyncToast />` between `<AccountGate />` and `<Routes>`.
  **Do not add a second one.**
- `src/lib/syncEngine.ts` already has `finishedListeners`, `emitSyncFinished()` and an exported
  `onSyncFinished(listener: () => void)`, called inside `runSyncInner` on every successful sync
  **regardless of whether anything changed**.

So this is a **rework**. The existing version violates settled decision 1 (fires on every no-op
sync) and decision 2 (never fires on failure).

One structural decision drives the shape of the fix: **`runSyncInner` stops emitting entirely and
returns a `SyncResult`; the single emit moves up into `sync()`.** That gets the migration case
right for free. `confirmMigration()` calls `runSyncInner` directly, outside `sync()`, so once the
emit lives in `sync()` the migration pull cannot toast at all — no suppression flag, no extra
parameter, and no risk of the migration accidentally joining an unrelated in-flight run. An
earlier draft routed `confirmMigration` through `sync()` instead; that was wrong, because joining
an existing in-flight sync would skip the migration pull and leave `AccountGate` stuck on its
`busy` flag.

## Assumptions

- **"Moved data" = `pushed + applied > 0`**, where `pushed` counts outbox ops the server reported
  `applied: true` for, and `applied` counts rows written into Dexie from server data **that
  materially differ** from what was already stored.
- **`photo.put` never counts as pushed.** `splitDrainBatch` filters those rows out before the push
  request, so they never reach the server and never produce a result. Accepted consequence: an
  outbox holding *only* `photo.put` rows reports `pushed: 0` and shows no toast even though
  Settings shows a non-zero pending count. Nothing moved, so that is correct.
- **Offline and signed-out are not failures.** Neither toasts; both already have durable UI (the
  Settings offline line, the signed-out account section).
- **A sync that changes nothing shows no toast, including a manual one.** Settled decision 1 is
  unconditional. Manual taps get feedback from a local busy label plus the existing `syncedLabel`
  flipping to "Synced just now".
- **Only the tab that ran the sync toasts.** `finishedListeners` is module scope, so this is
  already the behaviour; no `BroadcastChannel` is added. A background tab toasting is noise the
  user never sees, and when they return its screens are already correct because they read Dexie
  through `dexie-react-hooks` live queries.
- Counting a pull row that is an echo of this tab's own push is fine — data did move.
- `vitest.config.ts` pins `environment: 'node'`, and `src/lib/syncEngine.test.ts` already imports
  `syncEngine` in that environment and passes. Adding pure exports there and testing them is the
  established pattern. No new test infrastructure.

## Deferred to `docs/plans/sync-engine-hardening.md`

Each item states the residual risk **for this feature**, so the trade-off is explicit.

| Deferred | Residual risk here |
| --- | --- |
| Dexie lease refresh/delete does not check ownership, so two tabs can sync at once | Only in the no-`navigator.locks` fallback (older WebKit). Two tabs could each toast for the same work. Transient and cosmetic. |
| `resyncFromServer()` deletes the cursor then may join an in-flight pull that already captured the old cursor | The resync silently is not a full resync. Pre-existing; the toast merely reports whatever that run did. Verify (f) notes it. |
| A parseable-but-empty session (`{}` → `sub === undefined`) is partly guarded here (step 3 validates `sub`), but the wider audit of every `cook.session` reader is deferred | Step 3 covers the sync path, which is the only path this feature touches. |
| Malformed-but-HTTP-200 push response: exact `attempts` policy and misaligned `results` entries | Step 3's catch-all turns any such throw into a visible error toast and a recoverable `error` status. The precise retry accounting is unchanged from today. |
| An ordinary sync overlapping a migration does redundant work | It cannot toast over the gate: `runSyncInner` no longer emits, and steps 5–6 put the gate structurally above any toast. Wasted work only. |

## Files to change

| File | Change |
| --- | --- |
| `src/lib/syncEngine.ts` | `recordsEqual`; material-change counting in `applyPullPage` and `applyServerCurrent`; non-throwing `pullAll` (incl. the 401 fix); counting in `drainOutbox`; `runSyncInner` returns a `SyncResult`; one central emit in `sync()` with a catch-all; listener isolation; `resolveSyncResult`; `decideSyncToast`. |
| `src/lib/syncEngine.test.ts` | Unit tests for the three pure helpers. |
| `src/components/SyncToast.tsx` | Rewrite: success + error, single slot, auto-dismiss, a11y, animation. |
| `src/App.tsx` | Mount order only: `<SyncToast />` moves **above** `<AccountGate />`. |
| `src/screens/Settings.tsx` | One shared local busy state for "Sync now" and "Resync from server". |

No new files. No changes to `src/lib/db.ts`, `src/lib/types.ts`, `src/lib/outbox.ts`,
`src/lib/uiClasses.ts`, `src/index.css`, `server/**`, or `vite.config.ts`.

## The contract

Added to `src/lib/syncEngine.ts`:

```ts
export type SyncOutcome = 'ok' | 'error' | 'offline' | 'signedOut' | 'skipped';

export interface SyncResult {
  outcome: SyncOutcome;
  /** Outbox ops the server reported applied:true. photo.put is never included. */
  pushed: number;
  /** Rows written into Dexie from server data that differ from what was stored. */
  applied: number;
}

export type SyncFinishedListener = (result: SyncResult) => void;

/** Listeners must not call sync(). */
export function onSyncFinished(listener: SyncFinishedListener): () => void;

/** Pure. Key-order-insensitive deep compare. Never call on a row holding a Blob. */
export function recordsEqual(a: unknown, b: unknown): boolean;

/** Pure. Maps drain + pull results to the one result for the run. */
export function resolveSyncResult(
  drain: { outcome: 'ok' | 'stop' | 'signedOut'; pushed: number; applied: number },
  pull: { outcome: 'ok' | 'error' | 'signedOut'; applied: number } | null,
): SyncResult;

export interface SyncToastSpec {
  kind: 'success' | 'error';
  message: string;
}

/** Pure. The single source of truth for "should we toast, and with what". */
export function decideSyncToast(result: SyncResult): SyncToastSpec | null;
```

`'skipped'` is the explicit no-toast outcome: the ownership check returned `needsMigration`, or
the lock/lease was held elsewhere so nothing ran. Making it a real outcome rather than "we just
don't emit" is what makes the once-per-run invariant checkable.

`resolveSyncResult` precedence, in order:

1. `drain.outcome === 'signedOut'` → `signedOut`.
2. `pull === null` → `signedOut` if the drain said so, otherwise `error`; a missing pull result
   in any other situation means a caller forgot to produce one.
3. `pull.outcome === 'signedOut'` → `signedOut`. Signed-out beats error: re-authenticating is the
   only useful next action.
4. `pull.outcome === 'error' || drain.outcome === 'stop'` → `error`.
5. Otherwise → `ok`.

Counts are always `drain.pushed` and `drain.applied + (pull?.applied ?? 0)`, on **every** branch
including the failing ones. A run that pushed three ops then lost its session reports
`{ outcome: 'signedOut', pushed: 3 }`: the outcome suppresses the toast, the counts stay honest.

`decideSyncToast` rules, in order:

1. `outcome === 'error'` → `{ kind: 'error', message: "Couldn't sync" }`, **regardless of
   counts**. A partially successful run that ended in failure must not report success.
2. `outcome === 'offline' | 'signedOut' | 'skipped'` → `null`.
3. `outcome === 'ok'` → `pushed + applied > 0 ? { kind: 'success', message: 'Synced' } : null`.

**Exactly one `SyncResult` is emitted per `sync()` call that is not joined to an in-flight run**,
from a single `emitSyncFinished` call site in `sync()`. Never inside `runSyncInner`, never per
pull page, never per drain batch. `confirmMigration()` calls `runSyncInner` directly and therefore
emits nothing at all.

## Steps

### 1. [core] `recordsEqual`, material pull counting, and a non-throwing `pullAll`

In `src/lib/syncEngine.ts`.

**`recordsEqual(a, b)`** — new pure export. Deep compare that ignores key order and treats an
absent key and an `undefined` value as equal, so a Dexie row stored without an optional key
compares equal to a normalised row that omits it. Arrays compare by index and length (order is
significant — a reordered `checkedKeys` is a real change). Primitives compare with `===`, and
`null`, `undefined` and `0` stay distinct. Used only on plain recipe / chat / cookState records;
**never** on a `photos` row, which holds a `Blob`.

**`applyPullPage(changes)` → `Promise<number>`**, counting rows that materially changed, inside
the existing single transaction:

- recipes / chatMessages / cookState **put**: `get()` the existing row first (a read inside the
  already-open transaction), normalise as today, and count `+1` only when
  `!existing || !recordsEqual(existing, normalized)`. Always write, exactly as today — the
  comparison decides *counting*, never whether to write.
- recipes **tombstone**: count `+1` only when the local delete removed something. The existing
  code already reads the recipe and its messages to collect photo ids; **add** a
  `db.cookState.get(id)` and a `db.photos.bulkGet([...photoIds])` before deleting, so the
  condition is complete: the recipe row existed, or there was at least one message, or the
  cookState row existed, or at least one photo blob was present. Count once for the whole
  cascade, not once per child.
- chatMessages / cookState **tombstone**: `get()` before `delete()`, count only when the row
  existed.
- photos **live**: counts `0`. It only adds an id to the `remotePhotos` bookkeeping set; binary
  photo transfer is a later plan step and nothing user-visible changes.
- photos **tombstone**: count `+1` only when `db.photos.get(id)` found a blob to delete.

The extra reads are deliberate, replacing a "count every row" shortcut that would toast on
invisible no-ops. Cost is bounded: a page is at most 200 rows and these are primary-key reads in
a transaction that is already open.

**`pullAll()` → `Promise<{ outcome: 'ok' | 'error' | 'signedOut'; applied: number }>`, and it
never throws.** Wrap the **entire** function body — the initial `readSyncMeta(CURSOR_KEY)`, the
page loop, the cursor writes and the final `LAST_SYNCED_KEY` write — in one `try/catch`, with
`let applied = 0;` declared before the `try` so the `catch` can still report partial progress.

- Accumulate `applied += await applyPullPage(page.changes)` per page.
- The 401 branch keeps `invalidateSession()` and `setSnapshot({ status: 'signedOut' })`, then
  returns `{ outcome: 'signedOut', applied }` with whatever earlier pages applied.
- A non-401 `!response.ok`, a rejected `fetch`, and the cursor-did-not-advance case all
  `console.error` and return `{ outcome: 'error', applied }`. The cursor is still not advanced
  past a bad page, as today.
- Write `LAST_SYNCED_KEY` **only** after every page and every cursor write has succeeded, then
  return `{ outcome: 'ok', applied }`. A run that failed mid-way must not claim a fresh sync time.

In `runSyncInner`, declare the pull result **outside** any `try` so it stays in scope, and drop
the now-dead `try/catch` around `pullAll()`.

Verify: `npm run build` and `npm test` clean. Nothing consumes the counts yet.

### 2. [core] Count pushed ops and material push-conflict writes in `drainOutbox`

**`applyServerCurrent(kind, current)` → `Promise<boolean>`.** Return `true` only when it wrote a
row **and** that row materially differed (`recordsEqual` against the row read first). Return
`false` for every kind it does not handle — today `photo.delete`, `photo.put`, `recipe.delete`
and `chat.clearForRecipe`. Without this a `photo.delete` conflict increments `applied` while
nothing changes locally, which is exactly the invisible toast this feature must not produce.

**`drainOutbox()` → `Promise<{ outcome: 'ok' | 'stop' | 'signedOut'; pushed: number; applied:
number }>`.**

- Declare `let pushed = 0; let applied = 0;` **outside** the `while (true)` loop so counts
  accumulate across batches, and give **every** `return` the running totals. Do not trust a count
  of return sites quoted in a plan: open the function, give each `return` the totals, then re-read
  it to confirm none was missed. This is the highest-risk edit here.
- In the results loop: in the existing `shouldDropOutboxResult(result)` branch,
  `if (result.applied) { pushed++; }` before deleting the row — a row dropped for
  `reason: 'invalid'` or `'unknown'` has `applied: false` and must not count. In the existing
  `result.current` branch, count `applied++` **only if** `applyServerCurrent` returned `true`. The
  attempts/retry branch counts nothing.
- `photo.put` needs no handling: `splitDrainBatch` removes those rows before the request.

Update the call site in `runSyncInner` to destructure the object.

Verify: `npm run build` and `npm test` clean.

### 3. [core] `runSyncInner` returns a result; `sync()` emits once

**Listener isolation.** Wrap each listener call in `emitSyncFinished` in `try/catch` and
`console.error` the failure, so one throwing listener neither skips later listeners nor rejects
`sync()`. Do the same in `emit()` while there.

**Types.** Add `SyncOutcome`, `SyncResult`, `SyncFinishedListener` — type aliases and interfaces
only, no enums, no classes (`erasableSyntaxOnly`). Change `finishedListeners` to
`Set<SyncFinishedListener>` and `emitSyncFinished(result: SyncResult)`.

**`runSyncInner(sub)` → `Promise<SyncResult>`, and it never emits.** Delete the existing
`if (ok) { emitSyncFinished(); }`. Returns:

| Exit | Returns |
| --- | --- |
| `!navigator.onLine` | `{ outcome: 'offline', pushed: 0, applied: 0 }` |
| drain returned `signedOut` | `resolveSyncResult(drain, null)` |
| normal end | `resolveSyncResult(drain, pull)` |

Every `setSnapshot` on those paths stays as it is today, plus the step 1 fix: when
`pull.outcome === 'signedOut'`, leave the snapshot at `'signedOut'` and do **not** overwrite it
with `'idle'`.

**`confirmMigration()` keeps calling `runSyncInner` directly** and discards the returned result.
That is the whole migration guard: no emit, so no toast over the gate. Do **not** route it through
`sync()` — joining an in-flight run would skip the migration pull and leave `AccountGate` stuck.

Because it bypasses `sync()`, it also bypasses the catch-all below, so it needs its own. Wrap the
`runSyncInner` call in a `try/catch` that `console.error`s and moves the snapshot to a recoverable
`status: 'error'` with a refreshed `pendingCount` (that refresh in its own inner `try/catch` so it
cannot defeat the outer one), and **does not emit**. Without this, a throwing drain during the
migration leaves `status: 'syncing'` while `AccountGate` clears its `busy` flag and unmounts,
stranding the user with a permanently disabled "Sync now" and no gate.

**Validate the session `sub`.** Both `sync()` and `confirmMigration()` read
`localStorage['cook.session']`. Today they only guard against unparseable JSON, so a parseable
`{}` yields `sub === undefined` and proceeds into the ownership decision, which can claim or wipe
ownership for a non-existent user. Require `typeof sub === 'string' && sub !== ''`; otherwise
`sync()` sets `status: 'signedOut'`, returns a `signedOut` result and touches nothing, and
`confirmMigration()` returns without wiping.

**`sync()` owns the single emit — and its in-flight bookkeeping has to be fixed to do it.**

Split the two concerns. A new internal `runOnce(): Promise<SyncResult>` holds all of today's
`sync()` body except the `inFlight` handling, and **never rejects**:

- `let result: SyncResult = { outcome: 'skipped', pushed: 0, applied: 0 };`
- A `try` that assigns `result` from the branches: the signed-out / invalid-session branches give
  `{ outcome: 'signedOut', … }`; `needsMigration` leaves it `skipped`; otherwise
  `result = await runSyncInner(sub)`.
- A `catch` that `console.error`s, **sets the snapshot to a recoverable failed state** —
  `status: 'error'` plus a refreshed `pendingCount`, that refresh wrapped in its own inner
  `try/catch` so a failing `db.outbox.count()` cannot defeat the catch-all — and assigns
  `{ outcome: 'error', pushed: 0, applied: 0 }`. Without this a throw leaves `status: 'syncing'`
  forever and the Settings buttons stay disabled.
- `return result;` — no `finally`, and no reference to `inFlight` anywhere inside it.

`withLock` returning without running (lease held by another tab) leaves `result` as `'skipped'`,
which `decideSyncToast` maps to `null`.

Then `sync()` becomes a **non-`async`** function whose only job is the lifecycle:

```ts
export function sync(): Promise<void> {
  if (inFlight) {
    return inFlight;
  }
  const run = (async () => {
    const result = await runOnce();
    emitSyncFinished(result);
  })();
  inFlight = run;
  const clear = () => {
    if (inFlight === run) {
      inFlight = null;
    }
  };
  void run.then(clear, clear);
  return run;
}
```

Two defects in today's code are fixed by that shape, and neither may be "tidied" back:

1. **The `finally { inFlight = null; }` inside the IIFE is a latent wedge and must go.** An `async`
   function body runs synchronously until its first `await`. Today's signed-out and
   unparseable-session branches return **before any `await`**, so `inFlight = null` executes
   *before* the assignment `inFlight = (async () => …)()` completes. The assignment then stores an
   already-settled promise in `inFlight` forever, and every later `sync()` returns it immediately
   without running anything. A sync fired while signed out — an `online` or `visibilitychange`
   trigger — therefore wedges syncing for the rest of the page's life, including after a successful
   sign-in. In the shape above the IIFE's first statement is an `await`, so none of it can run
   before the assignment, and the `inFlight === run` identity check makes the cleanup correct even
   if that ever changes.
2. **`sync()` must not be `async`.** An `async` wrapper reintroduces the same class of problem by
   letting part of the lifecycle run synchronously before the assignment.

The emit is reached exactly once per run: it is the statement after the only `await` in the IIFE,
`runOnce()` cannot reject, and a second caller that joins `inFlight` receives the same promise and
does not emit again.

`SyncToast.tsx` still compiles at this point: a zero-argument callback is assignable to
`SyncFinishedListener`. It keeps its old (wrong) behaviour until step 5, so this step is
independently buildable.

Verify: `npm run build` and `npm test` clean.

### 4. [core] The pure helpers and their unit tests

Add `SyncToastSpec` and `decideSyncToast` next to the existing pure exports
(`syncOwnershipDecision`, `splitDrainBatch`, `shouldDropOutboxResult`, `mergePullCursor`). No I/O,
no `db`, no `fetch`, no React.

Add to `src/lib/syncEngine.test.ts`:

- **`recordsEqual`** — equal despite key order; an absent optional key equal to an explicit
  `undefined`; a nested `proposedRecipe` object compared deeply; `checkedKeys` arrays equal when
  identical and unequal when reordered or a different length; different scalar and extra key
  unequal; `null` vs `undefined` vs `0` distinguished.
- **`resolveSyncResult`** — drain `signedOut` with `pull: null` → `signedOut` keeping
  `drain.pushed`; pull `signedOut` after a page applied → `signedOut` with the summed count; pull
  `error` → `error` with summed counts; drain `stop` with pull `ok` → `error`; drain `stop` with
  pull `signedOut` → `signedOut`; all-`ok` → `ok` with summed counts; `pull: null` without a
  signed-out drain → `error`.
- **`decideSyncToast`** — `ok` `{pushed:1,applied:0}` → success "Synced"; `ok`
  `{pushed:0,applied:3}` → success; `ok` `{pushed:0,applied:0}` → `null` (the app-open case);
  `error` with zero counts → error "Couldn't sync"; `error` with non-zero counts → still error;
  `offline` → `null`; `signedOut` with `pushed: 1` → `null`; `skipped` → `null`.

These three are the whole risk surface that can be tested honestly. The repo has no
`fake-indexeddb` and no DOM testing library, and neither may be added, so do **not** attempt to
test `SyncToast.tsx`, `drainOutbox`, `applyPullPage` or `withLock`.

Verify: `npm test` passes with the new cases; `npm run build` clean.

### 5. [ui] Rewrite `SyncToast` behaviour: single slot, both kinds, auto-dismiss, a11y

Rewrite `src/components/SyncToast.tsx`. Behaviour only; styling is step 6.

- Subscribe in an effect: `useEffect(() => onSyncFinished(handle), [])`, where `handle(result)`
  calls `decideSyncToast(result)` and returns early on `null`.
- **Single slot, latest wins.** State is one nullable object
  `{ id: number; kind: 'success' | 'error'; message: string }`. On a new spec, set state with
  `prev => ({ id: (prev?.id ?? 0) + 1, ...spec })`. Never queue — a second sync finishing while a
  toast shows replaces the message and restarts the timer. A queue would let stale "Synced"
  messages pile up behind a live error.
- **Auto-dismiss** in an effect keyed on the toast's `id`: 2500 ms for success, 5000 ms for error
  (an error is worth reading), then clear to `null`. Always return a cleanup clearing the timers.
- **Never blocks, never steals focus.** No `autoFocus`, no `tabIndex`, no focus calls, no
  `role="dialog"`, no `aria-modal`, no backdrop. The fixed wrapper carries `pointer-events-none`
  so taps pass through.
- **Screen readers.** Keep the fixed wrapper **permanently mounted** — even with no toast —
  carrying `aria-live="polite"` and `aria-atomic="true"`, rendering the message element inside it
  conditionally. A live region inserted at the same moment as its text is unreliably announced; a
  pre-existing empty region is not. Give the inner element `key={toast.id}` so two consecutive
  identical "Synced" messages re-announce. Use `polite`, not `assertive`/`role="alert"`, even for
  the error: the toast is supplementary (Settings holds the durable error line).
- **AccountGate suppression (belt and braces).** Read `const { status } = useSyncStatus();` and
  render the wrapper with no message when `status === 'needsMigration'`. Step 3 already guarantees
  the migration sync emits nothing; this additionally hides a toast that was already on screen
  when the gate opened. Declare all hooks **before** any early return so the dismiss timers still
  run.
- **StrictMode double-mount needs no special handling, and the implementer must not add any:** the
  subscription effect's cleanup removes the listener from a `Set` before it is re-added, and the
  dismiss effect's cleanup clears its timers before they are re-created, so the toast still shows
  once for its full duration. `setupSyncTriggers()` and `triggerSyncAfterSession()` are called
  from `src/main.tsx` **outside** the React tree, so StrictMode does not double-fire a sync. Do
  not add a `useRef` mount guard.

Verify: `npm run build` clean. In `npm run dev`, a no-op sync on app open produces no toast — that
is the regression this feature is about.

### 6. [ui] Toast markup, styling, placement, animation, and mount order

Still `src/components/SyncToast.tsx`, plus a one-line move in `src/App.tsx`.

- **Mount order.** Move `<SyncToast />` **above** `<AccountGate />` in `App.tsx` and give the
  toast wrapper `z-30`, the same layer as the gate. At equal z-index the later element in the DOM
  paints on top, so `AccountGate` covers the toast even if the suppression in steps 3 and 5 is
  somehow wrong. Accepted trade-off: the Library bottom sheet is also `z-30` and sits inside
  `Routes`, so it will cover a toast while open. Transient and acceptable; being covered by the
  migration gate is not negotiable.
- **Placement.** Top-centre:
  `pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-30 flex justify-center px-4`.
  Top, not bottom: the bottom-right holds the Library "+" FAB (`fixed right-5 bottom-8`) and the
  RecipeView cook-mode FAB. `env(safe-area-inset-top)` is required in the offset even though
  `body` already has that padding, because a `fixed` element is positioned against the viewport.
- **Success pill**, matching the existing inverted-pill idiom:
  `rounded-full bg-ink px-4 py-2 text-sm font-medium text-page shadow-lg`. `bg-ink` / `text-page`
  invert correctly in both themes — no `dark:` variant needed.
- **Error pill**, reusing the danger fill from `dangerBtn`:
  `rounded-full bg-danger-fill px-4 py-2 text-sm font-medium text-white shadow-lg`.
  `--color-danger-fill` has no `html.dark` override, so it is identical in both themes and white
  text stays legible. Do **not** use `text-danger` on `bg-danger-bg`: in dark mode that is
  `#fca5a5` on `#450a0a`, which reads as a muted panel rather than an alert. Do not add tokens to
  `src/index.css` or exports to `src/lib/uiClasses.ts` — one component, two variants.
- **Animation.** Fade and slide in, fade out before unmount. Drive it from a local `shown` boolean
  toggled inside `requestAnimationFrame` after mount, set back to `false` ~200 ms before the state
  clears, applying `transition-all duration-200 motion-reduce:transition-none` with
  `opacity-0 -translate-y-2` / `opacity-100 translate-y-0`. Cancel the frame in the effect
  cleanup. Do **not** use Tailwind v4's `starting:` variant: `@starting-style` needs iOS Safari
  17.5+ and this phone-first app should not silently lose its animation on older devices.
- Add `max-w-full text-center` so the pill degrades gracefully at 320 px.

Verify: `npm run build` clean; the dark/light checks below.

### 7. [ui] Make manual sync in Settings feel responsive

In `src/screens/Settings.tsx`:

- Add **one** local `const [busy, setBusy] = useState(false)` shared by both controls, so "Resync
  from server" cannot be tapped while "Sync now" is running or vice versa.
- "Sync now": an async handler that sets `busy` true, awaits `sync()` inside a `try/catch` that
  `console.error`s (so a rejected `sync()` cannot become an unhandled rejection), and clears
  `busy` in a `finally` — the `finally` is what guarantees the button always recovers. Label:
  `busy ? 'Syncing…' : (syncStatus.status === 'error' ? 'Try again' : 'Sync now')`. Disabled when
  `busy || syncStatus.status === 'syncing'`.
- "Resync from server": the same treatment on the confirming (second) tap, label `'Resyncing…'`
  while busy, taps ignored while busy.
- Why this is needed: `runSyncInner` only sets `status: 'syncing'` **after** the lock is acquired,
  so between the tap and the lock the UI shows nothing. Under the lease fallback a sync skipped
  because another tab holds the lease never sets `'syncing'` at all — the local flag still
  resolves when the `sync()` promise settles.
- `sync()` returns the in-flight promise when one exists, so awaiting it is safe and never
  double-runs.
- Leave the existing inline offline / error / pending lines and `syncedLabel` untouched; the toast
  is additive.

Verify: `npm run build` clean; manual checks (e), (g) below.

## Verify

Automated, both must be clean:

```
npm test
npm run build
```

By hand. Start `npm run dev:api` (port 3001) and `npm run dev`, then open
http://localhost:5173 signed in with Google.

- **(a) The core case — silence for a no-op sync.** With nothing changed anywhere, reload. No
  toast. Switch to another tab, wait >30 s, switch back. No toast. Confirm in the Network panel
  that a pull actually ran, so you are verifying silence rather than absence.
- **(b) Success toast, both directions.** Open a second tab. In tab A edit a recipe title and save,
  then **tap "Sync now" in tab A** so the op actually reaches the server — the edit alone only
  fills the outbox. Tab A shows "Synced" for the push. Then in tab B switch away >30 s and back:
  tab B shows "Synced" and the title updates.
- **(c) Two tabs.** During (b), only the tab whose sync ran shows a toast; the other stays silent
  and still updates its list.
- **(d) Error toast.** Stop `npm run dev:api`, then tap "Sync now". The danger-styled "Couldn't
  sync" toast appears **and** the existing inline "Couldn't sync. Check your connection and try
  again." line is present. Restart the API and sync again to recover.
- **(e) Offline.** DevTools → Network → Offline, tap "Sync now". **No** toast; Settings shows the
  offline line; the button shows "Syncing…" briefly and re-enables.
- **(f) Resync, unchanged vs changed.** Tap "Resync from server" twice with nothing different on
  the server: everything is re-pulled, every row compares equal, so **no toast** appears and the
  button returns from "Resyncing…". Then change a recipe in the second tab, let that tab sync, and
  resync here: exactly **one** "Synced" toast for the whole multi-page pull, not one per page. (If
  a sync happens to be in flight when you tap, the cursor-deletion race noted under Deferred
  applies and the resync may not be full; that is pre-existing and out of scope here.)
- **(g) Manual responsiveness.** Throttle to Slow 3G and tap "Sync now": the button reads
  "Syncing…" immediately, "Resync from server" is disabled while it runs, and "Synced just now"
  appears afterwards.
- **(h) AccountGate.** Repro: sign out, run `localStorage.removeItem('cook.ownerUid')` in DevTools,
  create a recipe while signed out, then sign in. The gate appears. Tap "Export backup", then
  "Continue", and **while the migration pull runs switch tabs away and back** to fire a visibility
  sync. No toast is visible over the sheet at any point, from either sync.
- **(i) 401 mid-pull after a page applied.** With a library large enough to need more than one page
  (or `limit` temporarily lowered), start a sync and delete the `sous_session` cookie mid-pull.
  Expected: no "Synced" and no "Couldn't sync" toast, and Settings shows the signed-out account
  section. Before step 1 this reported a clean sync.
- **(j) A throw inside a sync is visible and recoverable.** Temporarily make `POST /api/sync/push`
  return HTTP 200 with the body `{}` (edit `server/sync.ts` and revert afterwards), then tap "Sync
  now". `{}` is the right shape to use because `body.results` is then `undefined` and indexing it
  throws; a body like `{"results":"nope"}` would **not** throw, since indexing a string is legal
  and just yields `undefined`, which the existing loop skips. Expected: the "Couldn't sync" toast
  appears, Settings shows
  its inline error line, the "Sync now" button is **re-enabled** rather than stuck disabled, and
  the outbox still holds its rows. Before step 3 this rejected silently and wedged the status at
  `syncing`.
- **(k) Themes.** Repeat (b) and (d) in both Dark and Light (Settings → Appearance). Success must
  be the inverted pill in both; the error pill legible white-on-red in both.
- **(l) Not blocking, focus, and overlap.** While a toast shows, tap the area directly under it (a
  recipe row, or the Library search field) — the tap lands on the page. Press Tab: focus order is
  unchanged and never lands on the toast. In DevTools → Elements → Accessibility, confirm the
  `aria-live="polite"` wrapper is in the DOM *before* any toast fires. Trigger two syncs in quick
  succession (tap "Sync now", then after ~1 s stop the API and tap again): exactly one toast on
  screen, the error replaces the success, the timer restarts, no stacking.

## Failure handling

- **Push fetch rejects or returns non-2xx** → `drainOutbox` returns `'stop'` with whatever it
  pushed first → `error` → danger toast. Rows keep their `attempts` increment and retry next sync.
- **Pull returns a non-401 error, or the cursor fails to advance** → `pullAll` returns
  `{ outcome: 'error', applied }` (it no longer throws) → `error` → danger toast, with the
  already-applied count preserved and `LAST_SYNCED_KEY` left alone. The cursor is not advanced
  past the bad page.
- **Partial success then failure** → error wins; never "Synced" for a run that ended in failure.
- **401 on push or on pull** → `invalidateSession()`, `outcome: 'signedOut'`, no toast; the session
  UI takes over. Ops pushed before the 401 stay in the reported counts.
- **Offline** → `outcome: 'offline'`, no toast, Settings inline line only.
- **Invalid or empty session `sub`** → `signedOut`, no toast, no ownership mutation.
- **`needsMigration`** → `sync()` returns `'skipped'` before `runSyncInner`; the component also
  suppresses while that status holds.
- **Migration** → `confirmMigration` calls `runSyncInner` directly, which no longer emits, so no
  toast is possible; mount order additionally keeps the gate above anything already visible.
- **Lock or lease held by another tab** → `withLock` returns without running, outcome `'skipped'`,
  no toast. The Settings busy flag still clears.
- **A listener throws** → caught per listener and logged; later listeners still run, `sync()` still
  resolves, the lock is released normally.
- **Anything else throws inside `sync()`** → caught centrally, logged, snapshot moved to `error`
  with a refreshed pending count, reported as `outcome: 'error'` → danger toast. A crash is a
  failed sync, not a silent one.

## Risks

- **Miscounting is the whole feature.** Over-count and the toast fires on every app open, which is
  worse than not shipping. The two highest-risk edits are step 2's many `return` sites and step 1's
  per-row comparison. Manual check (a) is the guard.
- **`recordsEqual` false negatives.** If normalisation and the stored row differ in a way the
  comparison calls material (a key present-but-`undefined`, a re-ordered array), every pull counts
  and the toast fires constantly. Its unit tests cover those shapes; check (a) catches it end to
  end.
- **Extra reads in the pull transaction.** A handful of primary-key `get()`s per pulled row,
  bounded by a 200-row page. Accepted for honest counting.
- **Cook-mode chatter.** `cookState.put` ops enqueued while cooking mean the next
  visibility-triggered sync legitimately pushes and toasts. Consistent with "data moved", and
  since sync does not poll it cannot fire repeatedly while the user watches the screen. Accepted.
- **Three pre-existing fixes ride along** (401-in-pull, the catch-all, listener isolation). Each is
  required for the toast to be truthful or visible, but they touch sign-out and failure paths, so
  checks (i) and (j) deserve real attention in review.
- **`z-30` under the Library sheet.** A toast is hidden while that sheet is open. Deliberate: the
  same mount-order rule is what guarantees AccountGate is never obscured.
- **Deferred hardening.** See the Deferred table; the largest residual is that two tabs on older
  WebKit can both toast for the same work.
- **The stale premise.** An implementer who believes no toast exists may create a second component
  or a second `<SyncToast />` mount. The file exists and is already mounted; step 6 only moves it.

## Status

- [x] 1. [core] `recordsEqual`, material pull counting, and a non-throwing `pullAll`
- [x] 2. [core] Count pushed ops and material push-conflict writes in `drainOutbox`
- [x] 3. [core] `runSyncInner` returns a result; `sync()` emits once
- [x] 4. [core] The pure helpers and their unit tests
- [x] 5. [ui] Rewrite `SyncToast` behaviour: single slot, both kinds, auto-dismiss, a11y
- [x] 6. [ui] Toast markup, styling, placement, animation, and mount order
- [x] 7. [ui] Make manual sync in Settings feel responsive

## Audit

- Round 1: REVISE — emit-once invariant missed exits and exceptions; partial pull counts lost on a
  throw; invisible no-op rows counted; `result.current` not proving a local change; migration
  bypassing the lock; listener exceptions unisolated; unowned lease refresh/delete; tests covering
  only presentation; Verify steps missing preconditions.
- Round 2: REVISE — routing `confirmMigration` through `sync()` (the round-1 fix) would let it join
  an unrelated in-flight run and skip the migration pull; the catch-all did not move the snapshot
  out of `syncing`; `sub` validation still only covered unparseable JSON; `pullAll`'s "never
  throws" excluded the cursor read and final write; recipe-tombstone counting needed reads the code
  does not do; malformed-200 push responses untested; `resyncFromServer` racing an in-flight pull.
- Round 4: REVISE, two narrow blockers, both fixed above — the `finally { inFlight = null; }`
  inside an `async` IIFE that can run before the assignment and permanently wedge `sync()` (a bug
  that exists in the code today, not just in the plan), and `confirmMigration()` bypassing the new
  catch-all so a throwing drain could leave `status: 'syncing'` after `AccountGate` unmounts. Also
  corrected Verify (j), whose malformed body would not actually have thrown.
- Round 3 (this revision): scope split at the user's direction. The toast keeps only what makes it
  truthful — material counting, a non-throwing `pullAll`, a central emit with a recoverable
  catch-all, `sub` validation, listener isolation — and `confirmMigration` keeps calling
  `runSyncInner` directly, which is what makes "migration never toasts" true by construction
  rather than by a flag. Lease ownership, the `resyncFromServer` cursor race, the detailed
  malformed-response policy, and migration/sync overlap moved to
  `docs/plans/sync-engine-hardening.md` with their residual risk recorded above.
