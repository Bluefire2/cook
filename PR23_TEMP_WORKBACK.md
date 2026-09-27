# PR #23 remaining-review workback

> **TEMPORARY HANDOFF FILE — DO NOT KEEP.**
>
> Once the work below is complete and verified, delete this file from the
> working tree **without committing the deletion**. Do not treat this file as
> durable product documentation or add it to the `AGENTS.md` plans table.

Current reviewed head: `700678f` (`cursor/shared-collections-cdc9`).

## Scope already resolved

Do not reimplement these earlier comments:

- Shared recipe and photo documents are loaded with batched `getAll` calls.
- Shared pull and photo authorization make removed owners' grants inert.
- Foreign/legacy clone IDs are deterministic, so repeated imports overwrite
  the same clone instead of duplicating it.
- Shared pull emits only live photo metadata with a matching `recipeId`.
- Shared-pull failures intentionally publish owned-only state and remove
  shared rows. Changing this fail-closed behavior requires an explicit product
  decision.
- Viewer leave, orphan-chat cleanup, shared Ask attachments, and the
  add-by-email account-existence signal are documented product limitations,
  not accidental omissions.

## Workback

### 1. [core] Decide the remaining sync-latency tradeoff

The per-page recipe/photo N+1 was fixed, but a successful refresh still waits
for the complete shared pull before publishing the viewer's own updates. This
is intentional atomic publication: it prevents a shared recipe page from
briefly disappearing.

- Measure current latency with a maximum-size shared page and multiple shares.
- Inspect the two authorization-scope reads per page and sequential collection
  reads before changing publication semantics.
- Choose one behavior explicitly:
  - keep atomic publication and accept delayed owned updates; or
  - publish owned updates while preserving the previous complete shared
    snapshot until the replacement shared pull succeeds.
- Do **not** publish a transient owned-only snapshot during a successful pull.
- Add subscriber-sequence tests for whichever behavior is chosen.

Acceptance:

- No partial shared page is ever visible.
- A successful refresh does not unmount an open shared recipe or `ChatPanel`.
- A non-auth shared failure follows the documented fail-closed product choice
  unless that choice is deliberately changed.

### 2. [core] Bound shared-parent chat/cook write authorization

`sharedParentLive` currently reads the viewer's complete incoming-share query
inside the write transaction, then reads candidate collection and recipe
documents until it finds a match. This is snapshot-correct but can make every
cook-state checkbox write expensive and increase transaction contention.

- Record query/read counts for zero, first-match, last-match, and many-share
  cases with pure injected decision tests where possible.
- Design a server-verifiable lookup hint or reverse index keyed by
  `(viewerSub, recipeId)`; never trust an `ownerSub` supplied by the client.
- Keep the current full-chain authorization:
  live incoming share → live collection → listed recipe → live recipe.
- If a new reverse index is too invasive for this PR, document and explicitly
  defer it rather than adding a partial cache with weaker revocation behavior.

Acceptance:

- Chat/cook writes cannot cross account boundaries.
- Revocation is reflected within the documented bound.
- The common write path does not scan every incoming share.

### 3. [core] Remove dead client-memory sharing state

Fresh usage searches show:

- `mergeSharedFromPull` has no production caller.
- `grantCounts` / `setGrantCount` are still written by grant-list refreshes,
  but no UI reads the count after owner badges were removed.

Work:

- Re-run `rg` before deleting anything.
- Remove the dead merge helper, grant-count snapshot field, setters, clone
  handling, and tests that exist only for those APIs.
- Keep Share-sheet grant rows in component state; do not reintroduce Library
  prefetch or owner badges.
- Update sync/backup tests to use the atomic publisher or purpose-built setup
  helpers instead of dead production APIs.

Acceptance:

- Opening or mutating Share still displays the current grant list.
- Library mount performs zero grant-list requests.
- No dead state emits extra external-store notifications.

### 4. [core] Restore screen → store layering

Several screens/components now import `isSharedRecipe` or
`isSharedCollection` directly from `libraryMemory`.

- Expose origin/read-only selectors through `recipeStore` and
  `collectionStore` (or focused hooks) and migrate:
  `SaveToCollectionSheet`, `ImportScreen`, `Library`, `RecipeEdit`, and
  `RecipeView`.
- Keep `libraryMemory` as the in-memory implementation detail beneath stores.
- Do not add fields to `Recipe`, `ChatMessage`, or `CookStateRow`.

Acceptance:

- Screens do not import `libraryMemory`.
- Existing read-only guards remain enforced in both UI and stores.

### 5. [ui] Resolve the remaining sharing UX choices

Handle these as explicit product/copy decisions:

- **Proposal copy:** decide whether owners keep “Save as variant” while shared
  viewers see “Save as a new recipe”, or whether the new copy is intentional
  for everyone.
- **Sharer identity:** two incoming collections named “Dinners” are currently
  indistinguishable except for the same shared icon. Decide whether to expose
  `ownerEmail` (already stored on the incoming share) or another display label
  in the shared pull and collection switcher.

If sharer identity is added:

- Treat it as sidecar/origin metadata, not a `Collection` schema field.
- Avoid exposing more owner identity than the product intends.
- Test duplicate collection names from two owners.

### 6. [core] Backfill normalized profile email

New sign-ins write `users/{sub}.emailLower`, but existing mixed-case profiles
remain undiscoverable until another Google OAuth sign-in.

- Choose a migration path:
  - one-time admin/backfill script over existing user profiles; or
  - safe lazy repair from a verified current session/profile.
- Keep `emailLower` server-derived.
- Preserve the current 404/503 membership semantics.
- Do not broaden the fallback into an unindexed case-insensitive scan.

Acceptance:

- An already-admitted mixed-case Workspace address can be shared with without
  waiting up to the 90-day session lifetime.
- Query/store failures remain `503`, not a false `404`.

### 7. [core] Authenticate revoke before parsing its body

`collectionGrantsRevokePost` currently parses and validates the request body
before `requireOwnedLiveCollection`.

- Move the membership/owned-live-collection check before body parsing.
- Preserve malformed authenticated request → `400`.
- Preserve missing grant → generic `404`, repeated revoke → idempotent `200`,
  and membership unknown → `503`.
- Add handler-order tests without a Firestore emulator.

Acceptance:

- An unauthenticated malformed request follows the protected-route auth
  response rather than returning body-validation details first.

### 8. [core] Clean up review documentation

- Decide whether completed review plans should be listed in `AGENTS.md` or
  consolidated under `docs/plans/shared-recipes.md`; avoid leaving several
  large plans undiscoverable.
- Keep the PR body test count synchronized with the final suite.
- Reword the `array-contains` warning: Native Firestore normally creates the
  single-field array index automatically; the deploy check should confirm no
  exemption/misconfiguration and exercise the real delete path.
- Update the “behind main” statement after the final merge.

### 9. [core] Reconcile with current `main`

At review time the PR was five commits behind `main`.

- Merge current `main` into `cursor/shared-collections-cdc9`.
- Resolve conflicts without dropping sharing authorization or newer import
  behavior.
- Re-run all focused sharing tests after the merge.

### 10. [ui] Complete the required two-account browser pass

Use Vite plus `dev:api` at `http://localhost:5173` with two admitted accounts.
This is required before marking the draft ready.

Exercise:

1. Owner shares a named collection with a viewer.
2. Viewer with an otherwise empty library sees the collection and recipes.
3. Cover and gallery photos load; an unrelated/chat photo remains 404.
4. Ask text and cook-state writes work; Edit, Apply, camera, move, delete, and
   import-into-shared remain unavailable.
5. Owner updates a shared recipe; viewer Refresh sees it.
6. Revoke access; viewer Refresh drops the collection and photo access without
   signing out.
7. Remove the owner from admission; existing grants become inert within the
   documented bound.
8. Re-admit the owner; confirm the documented grant-restoration behavior.
9. Exercise duplicate shared collection names if sharer identity is changed.

Record a short successful walkthrough and update the PR verification section.

### 11. [core] Final merge gate

Run:

```bash
npm test
npm run build
```

Then confirm:

- no screen-level library `fetch`;
- no client-trusted `ownerSub`;
- no `Recipe`, `ChatMessage`, or `CookStateRow` schema change;
- shared cursor restart tests still pass;
- owner-removal, photo authorization, backup re-import, revoke, and collection
  delete-cascade tests still pass;
- CI and Vercel are green;
- the PR is no longer draft only after the browser pass succeeds.

## Deferred product work

Do not silently fold these into cleanup commits:

- viewer leave flow;
- automatic deletion of orphan viewer chat/cook after revoke;
- photo attachments in Ask on shared recipes;
- changing the invite-only account-existence signal;
- retaining stale shared rows after a shared-pull failure.
