# Sharing workback

Handoff for the next agent. Written 2026-09-27 from `main` at `cdf6d07`
(Ask photo copy, #35, is on `main`). Do the tasks in the order below.
Do not start a later task because an earlier one looks small.

This file is the plan. Do not implement from the chat that produced it.
Each task says whether it is an ops run, a small code change, or a feature
that still needs a confirm from the owner before code.

## How to work

- Ops tasks (1, 2, 9): run them, record the revision or the script totals
  in this file’s Status log, and stop. Do not “improve” the script or the
  deploy workflow while you are there.
- Code tasks: branch off current `main` with `cursor/<slug>-01d2`. One
  task, one PR. Do not batch 4 with 5.
- Feature tasks 5–8: the Decisions blocks are **proposed defaults**, not
  locked product law. Before writing code, restate those defaults to the
  owner in one message and wait. If they change one, edit this file first.
- Do not deploy unless the task says to. Deploy is
  `.github/workflows/deploy.yml` (`workflow_dispatch` only) and replaces
  production `https://sous.kyrylo.lol`.
- Do not add fields to `Recipe`, `ChatMessage`, or `CookStateRow`.
  `src/lib/recipeStore.test.ts` is a schema lock.
- `syncEngine` and `remote` stay the only client modules that `fetch`
  library data.
- Unit tests only. No Firestore emulator in CI, no DOM testing library,
  no GCS mock.

## Priority table

| # | Task | Priority | Planning | Build | Validation beyond unit tests | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Deploy #35 (Ask photo copy) and check it | P0 | Low | Low | Manual: one shared recipe, Save as a new recipe, cover and gallery survive | On `main` as `cdf6d07`. Confirm Cloud Run is that commit or later before calling this done. |
| 2 | `emailLower` backfill | P0 | Low | Low | Dry run, then `--apply`, against production Firestore | Script exists. Same Google account writes the real user library. |
| 3 | `AGENTS.md` plan-table statuses | P1 | Low | Low | Read the table against the plan files; no product test | Do after 1 and 2 so the table can name the revision and the backfill. |
| 4 | Uploaded photos with no recipe row | P1 | Medium | Medium | Emulator: kill the recipe push after the photo POST and confirm a tombstone | Bytes can land in the owner’s GCS bucket with no live recipe. |
| 5 | Editor role | P1 | High | High | Two browsers on the emulator: editor saves, viewer cannot, admin deletes | Proposed defaults below. Confirm before code. |
| 6 | Shareable collection link | P2 | High | High | Emulator: member redeems; stranger does not get the library; revoked link 404s | Different from app invite links. Confirm before code. |
| 7 | Viewer leaves a collection | P2 | Medium | Medium | Emulator: leave, refresh, collection stays gone | Owner revoke already works. This is the viewer’s own action. |
| 8 | Sharing screen pass | P2 | Medium | Medium | Click through share, pending, revoke, leave, link copy on phone width and desktop | After 5–7, one pass, not three. |
| 9 | Streaming check and unreleased import/extension | P3 | Low | Low | The curl oracle in `docs/plans/sous-subdomain.md`; extension only if the owner asks to ship it | Do not deploy the extension while doing the streaming check. |
| 10 | Other open plans | P3 | — | — | — | Pointer only. Do not start these from this handoff. |

---

## 1. Deploy Ask photo copy and check it

**Kind:** ops. **Code:** none, unless production misbehaves.

### Current state

`recipeStore.createFromAsk` copies the parent cover and gallery onto new
photo ids, then creates a recipe the saver owns. Shared parents are read
with `GET /api/photos/:id?owner=`. A missing photo is skipped. A 5xx or
network failure aborts the save. Shipped on `main` as `cdf6d07`.

### Steps

1. `gh run list --workflow=deploy.yml --limit 5` and
   `gcloud run services describe sous --project=cooking-assistant-508423 --region=europe-west1 --format='value(status.latestReadyRevisionName,spec.template.spec.containers[0].image)'`.
   If the live revision was built from `cdf6d07` or a later `main` commit,
   write that revision in the Status log and go to step 3.
2. Otherwise run the **Deploy** workflow (`workflow_dispatch`,
   `disable_resend` left false). Record the previous revision first.
   Wait until the new revision is Ready. Do not run `scripts/deploy.sh`
   from a laptop unless the owner asks; Actions is the path.
3. Manual check, signed in as a member who is **not** the recipe owner:
   - Open a shared recipe that has a cover and at least one gallery photo.
   - Ask for a small change. Save as a new recipe.
   - The new recipe is in the saver’s default collection, editable, and
     shows the same cover and gallery.
   - Airplane-mode (or devtools offline) during Save shows
     “Couldn't copy the photos. Try again.” and does not create a recipe.
4. Write the revision and the check result in the Status log.

---

## 2. `emailLower` backfill

**Kind:** ops. **Code:** none.

### Why

Add-by-email looks up `users.emailLower`, then falls back to an exact
lowercase `users.email`. Profiles written before that field existed, with
a mixed-case `email`, are invisible until the next sign-in or this script.
`scripts/backfill-email-lower.ts` is idempotent. Dry run is the default.

### Steps

1. Local ADC must be the project `cooking-assistant-508423`
   (`gcloud auth application-default print-access-token` succeeds, quota
   project is that project). `FIRESTORE_EMULATOR_HOST` must be unset.
   This writes **production**.
2. Dry run:
   `node --env-file=.env.local scripts/backfill-email-lower.ts`
   Record `scanned` and `pending`. Do not print emails or document ids
   into git; the script already logs ids — keep that output off the PR
   and out of this file. A count is enough.
3. If `pending` is 0, say so in the Status log and stop.
4. Apply:
   `node --env-file=.env.local scripts/backfill-email-lower.ts --apply`
   Run the dry run once more. `pending` must be 0.
5. Spot-check in the app: share a collection with an address that
   previously 404’d only because of case. Expect 200 and a row on the
   share list.

---

## 3. Bring `AGENTS.md` plan statuses in line

**Kind:** docs. Do this after 1 and 2.

### What is stale

The plan table still says invitation-flow, invite-links, ask-voice-stt,
recipe-gallery, and bulk-import are in progress. Several of those landed.
`docs/plans/shared-recipes.md` is the sharing spec and is done for view-only.
This workback is the open sharing list.

### Steps

1. `[core]` For each row, open the plan’s Status section and `git log`
   on `main` for the feature. Set the row to Done with the PR number, or
   leave it open with the branch that actually contains the work. Do not
   mark a plan done because its file exists.
2. `[core]` Add this file as the open sharing follow-up. Point task 1 at
   the Cloud Run revision from the Status log, and task 2 at “backfill
   applied” or “pending was already 0”.
3. `[core]` Do not rewrite Sharing, Auth, or Do not touch. Those sections
   match the view-only product. Editor and links do not go there until
   the feature PRs land.

---

## 4. Photos uploaded with no recipe row

**Kind:** code. Branch `cursor/orphan-photo-cleanup-01d2`.

### What goes wrong

`recipeStore.create` calls `uploadRecipePhotos` (POST `/api/photos/:id`)
and then `pushOps` for `recipe.put`. If the push fails, the client drops
the local recipe and the pending blob, and tells the user the recipe was
not saved. The server can already have a live photo document and a GCS
object. Nothing points at that photo. A later recipe delete does not see
it, so the cascade never runs.

The same window exists for a new photo on `save` when `uploadRecipePhotos`
succeeds and the recipe push fails, except the recipe row usually already
existed. Limit this task to **create** (including `createFromAsk`, which
calls `create`). Do not build a bucket crawler.

### Decisions

- Cleanup is a client `photo.delete` for the ids this create uploaded,
  best-effort, after the recipe push fails.
- If the delete push also fails, leave the photos. Do not retry in a loop
  and do not add a sweeper in this PR.
- Do not change photo authorization. Deletes still require an owned photo
  whose parent recipe is absent or not live — confirm that in
  `server/store.ts` before calling delete. If delete is rejected while
  the recipe row was never written, that is the bug to fix on the server:
  an owned photo with **no** parent recipe must be deletable by that owner.
  An owned photo whose parent recipe **is** live must stay protected.

### Steps

1. `[core]` In `recipeStore.create`, remember the ids
   `uploadRecipePhotos` actually stored. On recipe-push failure, push
   `photo.delete` for those ids, then `removeRecipeLocal` as today.
   A sign-out (`RemoteAuthError`) still clears the library and does not
   need the extra delete.
2. `[core]` Server: if `photo.delete` of an owned photo 404s or 409s
   because no live parent recipe exists, allow the tombstone. Keep the
   “parent recipe is live and not yours” rejection. Add a unit test on
   the pure decision if one exists; otherwise a focused test around the
   helper that answers “may this owner tombstone this photo”.
3. `[core]` Unit test the client path with mocked `remote`: photo POST
   resolves, recipe push rejects, photo delete is pushed, and the
   in-memory recipe is absent.
4. Manual, emulator only (`FIRESTORE_EMULATOR_HOST`, `PHOTO_BUCKET`
   unset or the dev bucket the owner already uses — do not point this
   experiment at production). Create a recipe with a photo, force the
   recipe push to fail (devtools block `sync/push` after the photo POST),
   confirm the UI says it did not save, then confirm a second attempt
   works and the failed attempt did not leave a library row.

---

## 5. Editor role

**Kind:** feature. **Stop and confirm the defaults in this section before
any code.** Branch `cursor/collection-editor-role-01d2` only after a yes.
Spec to extend: `docs/plans/shared-recipes.md` (view-only is D17–D23).
Do not reopen view-only behavior while adding the role.

### Proposed defaults

- Three roles. **Admin** is the collection owner: the Google `sub` on
  `users/{sub}/collections/{id}`. There is one. It is not stored as a
  grant, not transferable, not demotable.
- **Viewer** is today’s grant. Pull, read, own chat, own cook state.
  No recipe write, no photo write, no collection write, no grants.
- **Editor** may `recipe.put` on a recipe **listed in that live
  collection**. Editor may not `recipe.delete`, may not change which
  recipes are in the collection, may not rename or delete the collection,
  may not grant or revoke.
- Editor recipe writes **do not change `photoId` or `galleryPhotoIds`**.
  The server rejects a put from a non-owner that adds, removes, or
  swaps a photo id. Ask camera and gallery upload stay hidden. This
  avoids writing the editor’s bytes into the owner’s bucket.
- Admin remains the only delete. Deleting the recipe still tombstones
  it for everyone and removes it from the owner’s collections.
- A person who is editor on one collection and viewer on another follows
  the **stronger** role for a recipe that appears in both.
- Existing grants stay viewers. No backfill. New grants send
  `{ email, role }` with `role` `viewer` or `editor`. Omitted role on
  old clients means `viewer`.
- Cap stays 20 live grants, both roles counted.

### Steps (after confirm)

1. `[core]` Grant document gains `role: 'viewer' | 'editor'`. Missing
   `role` reads as `viewer`. Reverse index
   `incomingShares/{viewer}/items/{owner}_{collection}` copies `role`
   so the viewer pull does not need a second read. Revoke and collection
   delete stay as they are.
2. `[core]` `POST /api/collections/:id/grants` accepts `role`.
   `POST /api/collections/:id/grants/role` with `{ sub, role }` changes
   it, owner of the collection only, 404 for everyone else, 400 for a
   bad role. Do not invent a third route shape if a single patch fits
   the existing grant module; keep cookies-only auth.
3. `[core]` `recipe.put` authorization: owner of the recipe, **or**
   editor via the same live chain used for shared chat (incoming share
   → live collection → `recipeIds` contains id → live recipe). Reject
   photo-id changes when the writer is not the owner. `recipe.delete`
   stays owner-only. Never trust `ownerSub` or `role` from the body.
4. `[core]` Shared pull includes `role` on each shared collection.
   Client `LibraryCollection` may grow `access: 'owner' | 'editor' | 'viewer'`
   as a **memory field set at publish time**, not a new `Recipe` field.
   Confirm it is not persisted through `compactRecipe`.
5. `[ui]` Share list: each row is Viewer or Editor, with a way to switch
   and to revoke. Copy stays the existing sentences. No new settings page.
6. `[ui]` Recipe screen for an editor: show the edit path for title,
   ingredients, steps, notes. Hide delete, hide photo add/remove, hide
   “add to collection” that would rewrite the owner’s membership.
   Viewer UI stays as it is today (no edit). Ask Apply on a shared recipe
   stays hidden for viewers. For editors, Apply may call `recipe.put`
   only when the draft does not touch photos; if that is awkward, hide
   Apply for editors in this PR and say so in the PR — do not half-enable it.
7. `[core]` Tests: missing role ⇒ viewer; editor put allowed; editor
   delete rejected; editor photo-id change rejected; viewer put rejected;
   owner delete still allowed; role change round-trips.

### Validation

Emulator, two browsers (or one browser and a second profile):

- Owner shares as editor. Editor changes a step. Owner’s next refresh
  shows it. A third member shared as viewer never sees an edit control.
- Editor cannot delete. Admin can. After delete, editor and viewer
  refresh and the recipe is gone.
- Editor cannot add a gallery photo (control absent; a hand-built push
  is rejected).

---

## 6. Shareable collection link

**Kind:** feature. **Confirm before code.** This is not
`docs/plans/invite-links.md`. Those links admit someone to the **app**.
These links attach an **already admitted** member to a collection.

### Proposed defaults

- Owner mints `{origin}/c/<token>` from the collection’s share UI.
  Role is chosen at mint: viewer (default) or editor, same roles as
  task 5. If task 5 has not shipped, mint viewer only and do not add
  the editor choice.
- Firestore stores `sha256(token)` only. The raw token is shown once.
- Multi-use until the owner revokes it or `expiresAt`. TTL 7 days,
  matching app invites. Cap 20 live links per collection.
- Redeem: signed-in **active member or owner** only. The server writes
  the same forward grant + `incomingShares` row as add-by-email, with
  the link’s role. Already granted → 200, link not consumed (it is
  multi-use).
- Signed-out visitor: send them through the normal Google sign-in with
  a short hop cookie (new name, do not reuse `sous_invite` or
  `sous_oauth`’s access-request version). After consent, if they are
  already admitted, redeem. If they are not admitted, do **not** create
  a member and do **not** create a grant. Show the existing
  invitation-only page. The link stays valid for someone who is a member.
- Revoked, expired, or unknown token: the same generic page. Do not say
  which of the three it was.
- No email field, no Resend, no new Google scope, no new env var.

### Steps (after confirm)

1. `[core]` Collection-scoped link documents, hash as id, mint/list/revoke
   routes under `/api/collections/:id/links`, owner of the collection,
   404 otherwise. Cookie session only.
2. `[core]` Redeem route. Membership check is `requireMember` **after**
   sign-in. Failed admission does not write a grant.
3. `[ui]` One “Copy link” action on the share UI, role choice only if
   editors exist, and a list of live links with revoke. Show the URL
   once, then only “revoke”.
4. `[core]` Tests for hash storage (raw token absent), expired link,
   non-member redeem writes nothing, member redeem writes one grant,
   second redeem stays idempotent.

### Validation

Emulator: member opens the link and sees the collection; a Google
account that is not a member sees the invitation page and a later
member can still use the same link; owner revoke makes the link fail;
the collection itself remains.

---

## 7. Viewer leaves a collection

**Kind:** feature, smaller than 5 or 6. Can ship before either, and
should if 5 or 6 slips. Branch `cursor/leave-shared-collection-01d2`.

### Decisions (safe to treat as locked)

- Only the signed-in grantee can leave. Body does not carry `sub`.
- Leaving tombstones that grantee’s forward grant and the matching
  `incomingShares` item, same shape as owner revoke.
- The collection and the other grantees stay.
- An editor (once that role exists) uses the same leave. Do not add a
  second endpoint later; name it leave, not “viewer leave”.
- Personal chat and cook rows for those recipes may remain, as they do
  after owner revoke today. Do not add a cleanup job.

### Steps

1. `[core]` `POST /api/shared/leave` with `{ ownerSub, collectionId }`.
   `requireMember`. 404 if there is no live grant for this session.
   200 `{ ok: true }` if this call tombstones it. A second call is 404
   (already gone), and the client treats that as success.
2. `[ui]` On a shared collection, a Leave action with a confirm. Then
   `refreshSharedLibrary` (or the existing full refresh). The collection
   disappears. Owned collections gain no Leave control.
3. `[core]` Unit test: leave writes both tombstones; leave of someone
   else’s grant 404s; owner revoke and leave cannot resurrect each other.

### Validation

Emulator, two users: B leaves, B refreshes, the collection is gone; A
still sees it and no longer sees B in the grantee list.

---

## 8. Sharing screen pass

**Kind:** UI. Start only after the feature tasks you actually shipped
(5, 6, 7). Branch `cursor/sharing-screen-pass-01d2`. One PR.

### What to improve

The data model can stay. The screen should answer, without a paragraph
of help text:

- who has access and as what (viewer / editor / owner);
- pending versus saved (the row does not pretend the server accepted);
- copy link, if links shipped;
- leave, if leave shipped;
- empty state when you have shared nothing and nothing is shared with you.

### Steps

1. `[ui]` Walk the current share UI and write a short before-note in the
   PR: the three confusing spots you are changing. Do not restyle the
   rest of the app.
2. `[ui]` Grantee rows show role, email, and revoke. Role switch is a
   control on the row if task 5 shipped.
3. `[ui]` Disable the add control while the request is in flight, and
   show the server error on the dialog (unknown email, cap, offline).
4. `[ui]` Phone width and desktop. Shared recipe page, collections list,
   and the share dialog. Confirm a viewer still has no edit or delete.

### Validation

Click through as owner, as editor (if shipped), and as viewer. Refresh
mid-dialog does not leave a ghost row. This is manual; do not add a
browser test harness.

---

## 9. Streaming check and unreleased import work

**Kind:** ops, then stop.

### Streaming

After the next production deploy (task 1 if it deployed, otherwise the
next one the owner runs), run the curl oracle in
`docs/plans/sous-subdomain.md` step 2 against Cloud Run with a
`sous_session` cookie. Pass means `/api/chat` does not grow
`Content-Length` or `Content-Encoding`. Record pass/fail in the Status
log. Do not change the `0x1E` framing.

### Import / extension

These are built and not fully rolled out. Do not deploy them as a side
effect of task 1.

| Plan | What the next agent should know |
| --- | --- |
| `docs/plans/chrome-extension-import.md` | Unpacked MV3 extension plus `POST /api/extension/import`. Header session only. Privacy/terms must describe HTML-to-Gemini before anyone but the owner is offered the extension. |
| `docs/plans/import-blocked-fetch.md` | Empty extension HTML is 422. Website URL import stays paste-fallback. No proxy. |
| `docs/plans/recipe-import-module.md` | Import implementation lives in `server/recipeImport.ts`. `api/import.ts` on Vercel is a 401 stub on purpose. |
| `docs/plans/bulk-import.md` | Opt-in bulk URL import. Confirm on `main` before assuming it is unshipped. |

Ship any of these only when the owner asks, in its own PR.

---

## 10. Other open plans (do not start)

| Plan | Why it is not in 1–9 |
| --- | --- |
| `docs/plans/ask-voice-stt.md` | Dictation. Separate from sharing. |
| `docs/plans/sync-engine-hardening.md` | Findings, not an approved plan. The delete flicker fix already shipped (`epoch` / `openWrites`). |
| iOS standalone sign-in | If it jumps to Safari and stays signed out, stop and use the GIS `id_token` fallback from the parent oauth plan. Do not invent a new OAuth flow. |

Known product quirk, not a task: opening a recipe resets the cook
checkbox. `CookMode` calls `ensureState`, which writes `step: 0` whenever
the saved step is `<= 0`. Leave it unless the owner asks for a resume
position.

---

## Status log

The agent who finishes a task appends one line.

| Date | Task | Result |
| --- | --- | --- |
| 2026-09-27 | — | Workback written. #35 is `cdf6d07` on `main`. Deploy and backfill not run in this session. |
