# Cook log (past cooks with photos, notes, lessons)

**Constitution:** [`docs/constitutions/cook-log.md`](../constitutions/cook-log.md)
(installed in step 0). It binds every step below. Where this plan and the
constitution disagree, the constitution wins; a deliberate break needs an
amendment in the same PR.

Branch: `cursor/cook-log-5615`, cut from `origin/main`.

Related: `docs/plans/constitution-skill.md` (on branch
`cursor/constitution-skill-plan-5615`, not in this branch) specifies the same `## Feature constitutions` section and
`scripts/constitutions.test.ts`. Step 0 follows that spec so the two merge
cleanly; its "second paragraph" (pointing at the skill) is written by that plan,
not this one.

## Goal

Log each time you cook a recipe: date, optional 1-5 rating, servings, notes
(how it went, substitutions), lessons (what to do next time), up to 8 photos.
Entries show on the recipe page ("Your cooks") and in a global journal at
`/cooks`. One tap appends a lesson to the recipe's Notes.

## Entity

```ts
export interface CookLog {
  id: string;            // UUID
  recipeId: string;      // parent; must be live on put
  cookedOn: string;      // 'YYYY-MM-DD', local calendar date
  rating?: number;       // integer 1-5
  servings?: number;     // finite, > 0, <= 1000
  notes?: string;        // <= 10_000 chars
  lessons?: string;      // <= 10_000 chars
  photoIds?: string[];   // <= 8 unique UUIDs
  createdAt: number;
  updatedAt: number;
}
```

Firestore: `users/{uid}/cookLogs/{id}`. Store kind `cookLogs`. Push ops
`cookLog.put` (payload: the `CookLog`) and `cookLog.delete`
(`{ id, updatedAt }`).

## Decisions

- New sibling entity; **no** fields on `Recipe`, `ChatMessage`, `CookStateRow`
  (constitution P1). `src/lib/recipeStore.test.ts` must not change.
- Optional keys are omitted when empty (blank trimmed strings, empty
  `photoIds`, missing rating/servings), like `compactRecipe`.
- `putDoc` parent check: `cookLogs` requires live `payload.recipeId`, like
  `chatMessages` (`server/store.ts` ~L526-541). Also inside that transaction:
  if the stored doc is live and `storedRaw.recipeId !== payload.recipeId`,
  return `{ applied: false, reason: 'invalid' }` (entries cannot move, P3).
- Photos: the UI re-encodes every picked file with `encodeImageForStorage`
  (`src/lib/image.ts`; server accepts JPEG/PNG ≤ 2 MB) before `photoStore.add`,
  copying `RecipeForm.submit` (~L474-511), including `photoStore.remove` of the
  new ids on failure. Then `postPhoto(id, log.recipeId, log.updatedAt, blob)`
  for each pending photo **before** `cookLog.put` (pattern:
  `uploadRecipePhotos` in `src/lib/recipeStore.ts`, `uploadMessagePhotos` in
  `src/lib/chatStore.ts`). After a successful put on edit, send `photo.delete`
  for photos removed from the entry and `dropPhoto` them (pattern:
  `deleteRemovedPhotos` in `recipeStore.ts`). Deleting an entry pushes one
  batch: `cookLog.delete` first, then `photo.delete` for each of its photos
  (a partial batch leaves only photos, which the recipe cascade still finds by
  `recipeId`).
- Cascade: `cascadeRecipeDelete` (`server/store.ts` ~L633) queries
  `cookLogs where recipeId ==`, tombstones live entries, collects their
  `photoIds` into the existing photo tombstone set. Cook-log jobs and **every
  photo job** in the cascade tombstone at `Math.max(at, stored.updatedAt)`
  instead of skipping when the child is newer (same pattern as
  `collectionsToScrub` L285). Every photo in the set belongs to the recipe
  being deleted, and the photos route refuses uploads for a dead recipe, so
  forcing is safe; it also catches leftover photos from a partial entry delete.
  Chat and cookState jobs keep plain LWW. Pure exported helper
  `forcedTombstoneAt(at, stored)`: returns `null` when `stored` is already a
  tombstone (skip, do not re-queue `gcsDeletes`), else
  `Math.max(at, stored?.updatedAt ?? 0)`. Compute it from the doc read inside
  the chunk transaction. Build the child job list (kind, id, forced) with a
  pure function and test that cook logs and photos are forced while chat and
  cookState are not. `removeRecipeLocal`
  (`src/lib/libraryMemory.ts` L110) drops entries for the recipe and their
  photo ids from `pendingBlobs`/`remotePhotoIds`.
- No per-recipe entry cap. Server caps as in the entity comments; payload JSON
  must be under 200k like other validators.
- Compatibility: `cookLogs` optional in client `PullChanges` (like
  `collections`); unknown cursor keys are already ignored server-side.
- Backup: export `version: 4` with `cookLogs`. Import accepts 1-4.
  `attributePhotos` also walks `cookLogs[].photoIds` → `log.recipeId`. Restore
  pushes `cookLog.put` after `recipe.put`s. Filter with `isUsableCookLog` and
  `compactCookLog`.
- `appendLessonToNotes(notes, lesson)`: trims lesson; empty lesson → notes
  unchanged; if notes already contain the trimmed lesson → unchanged; else
  `notes ? notes.trimEnd() + '\n\n' + lesson : lesson`.   `lessonInNotes(notes,
  lesson)` is the derived "In notes" check. Promotion reads the latest recipe
  with `getRecipe(id)` and saves via `recipeStore.save` (bumps `updatedAt`,
  resets cook progress — accepted, P7).
- `recipeStore.remove` must roll back cook logs too on a failed delete:
  capture the recipe's cook logs before `removeRecipeLocal` and re-upsert them
  on failure, alongside what it already restores. Do not use a full
  `restoreSnapshot` (it would revert unrelated concurrent changes). Add a
  failed-delete case to `src/lib/recipeStore.remove.test.ts`.
- Accepted: a tombstone carries no `recipeId`, so a newer put could in theory
  revive a deleted entry under another live recipe. The client never sends
  that; recorded in constitution P3.
- Un-delete via a newer put can revive an entry whose photos are gone;
  `CookLogCard` must render a missing photo as nothing (no broken image).
- Known pre-existing limitation, not fixed here: backup import uploads photos
  before `recipe.put`, so into an empty account the photos route returns 409.
  Do not claim the v4 photo restore is verified end to end.
- Journal and recipe section share one `CookLogCard`. Screens never `fetch`.

## Constraints for every step

- Read root `AGENTS.md` and the constitution first.
- `erasableSyntaxOnly`: no enums, no constructor parameter properties.
- Tests are pure (Vitest, node env). No emulator, GCS mock, fake-indexeddb, or
  DOM testing library.
- Comments only for constraints the code cannot show; match surrounding style.
- Node ≥ 22.18: `export PATH=/home/ubuntu/.nvm/versions/node/v22.22.2/bin:$PATH`
  before `npm` commands (the default `node` on this VM is 22.14).
- Do not touch: Gemini request shape, `app: 'cook'`, `cook-backup-` filenames,
  `vercel.json`, Dockerfile.

## Steps

### 0. [core] Install the constitution and its index

- Copy `/opt/cursor/artifacts/plans/cook_log_constitution.md` verbatim to
  `docs/constitutions/cook-log.md`.
- In root `AGENTS.md`, immediately before `## Plans`, add:

  ```md
  ## Feature constitutions

  A constitution records a feature's principles and why each exists. The index
  below lists every constitution by name and description only. Before planning
  or editing, check your change against these descriptions. If one plausibly
  applies, read that constitution in full before you write code; when unsure,
  read it. Its frontmatter `scope` lists the exact files and concepts it covers.
  You may break a principle only by amending the constitution in the same PR:
  rewrite the principle, add an amendment-log entry saying why the break is
  worth it, and flag it in the PR description. An unacknowledged break is a
  defect. Plans, audits, and verifications name the constitutions they applied.

  A new constitution goes in `docs/constitutions/<slug>.md` with `name`,
  `description`, `status` (`draft` or `ratified`), and `scope` frontmatter,
  plus a matching index line here. `scripts/constitutions.test.ts` checks that
  this index matches each file's frontmatter.

  - **Cook log** (`docs/constitutions/cook-log.md`): <description copied verbatim from the frontmatter>
  ```

- Add `scripts/constitutions.test.ts` (pure Vitest; picked up by the default
  include; `tsconfig.node.json` includes `scripts` so `tsc -b` checks it):
  - `parseFrontmatter(text)`: leading `---` block, `key: value` lines, and
    `scope:` followed by `  - item` lines. Returns fields or a list of errors.
  - For each `docs/constitutions/*.md` (missing directory = zero): frontmatter
    parses; `name`, `description`, `status`, `scope` present; `status` is
    `draft` or `ratified`; `scope` non-empty.
  - Parse index lines (`- **<name>** (\`<path>\`): <description>`) inside the
    `## Feature constitutions` section of `AGENTS.md`. Fail if a constitution
    has no index line, an index line points to a missing file, or name or
    description differs by even one character.
  - Zero constitutions with "None yet." passes.
  - Negative fixtures: frontmatter missing `description` is reported; a
    one-character description mismatch is reported.
- Add a row to the Plans table in `AGENTS.md`:
  ``| `docs/plans/cook-log.md` | Implementing on `cursor/cook-log-5615`. Cook log entries + `/cooks` journal; constitution `docs/constitutions/cook-log.md`. |``

### 1. [core] Types, compaction, pure helpers

- `CookLog` in `src/lib/types.ts`.
- New `src/lib/cookLogShape.ts`: `MAX_COOK_LOG_PHOTOS = 8`,
  `MAX_COOK_LOG_TEXT = 10_000`, `MAX_COOK_LOG_SERVINGS = 1000`,
  `isCookedOn(s)` (regex plus real calendar date), `todayCookedOn(date?)`
  (local date), `compactCookLog(log)` (fixed key order, drops unknown keys and
  empty optionals, dedupes photoIds and caps at 8), `isUsableCookLog(raw)`,
  `sortCookLogs(logs)` (`cookedOn` desc, then `createdAt` desc, then `id`),
  `appendLessonToNotes`, `lessonInNotes`. `isUsableCookLog` enforces exactly
  the server rules (step 2); keep one fixture table of valid/invalid entries
  and run it against both `isUsableCookLog` and `validateCookLogPut` (in the
  server test) so the two cannot drift.
- `src/lib/cookLogShape.test.ts`: exact key-set lock with the failure message
  "Growing CookLog keys amends Principle 6 of docs/constitutions/cook-log.md";
  compaction, date validation (rejects `2026-02-30`), sorting, append/idempotence.

### 2. [core] Server store

In `server/store.ts`:
- `'cookLogs'` in `StoreKind` and the `decodePullCursor` allowlist.
- `compactCookLogFields`, `validateCookLogPut`, `validateCookLogDelete`.
  `validateCookLogPut` requires finite `createdAt` and `updatedAt` (like
  `validateRecipePut` ~L867) and a real calendar `cookedOn` (same rule as the
  client's `isCookedOn`; duplicate the small check server-side, since `server/`
  must not import `src/`).
- `cookLog.put` / `cookLog.delete` in `PushOpKind`, `validatePushOp`,
  `isKnownPushKind`.
- `putDoc` parent check and immutable `recipeId` for `cookLogs`.
- `cascadeRecipeDelete`: tombstone the recipe's live cook logs and collect
  their photo ids (count batch cost like chat messages), using the forced
  tombstone time described in Decisions.
- Tests in `server/store.test.ts`: valid put; each rejected field (bad UUID,
  bad or impossible `cookedOn` like `2026-02-30`, missing `updatedAt`, rating
  0/6/2.5, servings 0/1001, text too long, 9 photos, duplicate photo ids);
  delete validation; cursor decode keeps `cookLogs`; `forcedTombstoneAt`
  cases. If the `recipeId` guard is not reachable from a pure test, factor
  the comparison into a pure helper and test that.

### 3. [core] Server sync

In `server/sync.ts`: `cookLogs` in `STORE_KINDS` and the `changes` initializer;
`docToChange` returns `compactCookLogFields` for live docs; `applyPushOp` cases
(`cookLog.put` → `putDoc(uid, 'cookLogs', id, compact, updatedAt)`;
`cookLog.delete` → `tombstoneDoc(uid, 'cookLogs', id, updatedAt)`). Extend
`server/sync.test.ts` where it enumerates kinds/ops.

### 4. [core] Client sync

- `src/lib/pushOps.ts`: `cookLog.put` / `cookLog.delete` variants.
- `src/lib/remote.ts`: `cookLogs` in `PullCursor` and optional in
  `PullChanges`; `normalizeCookLogChange` (tombstone or `compactCookLog` of a
  usable row; an unusable live row is treated as a delete from the map);
  `applyPullChanges` updates a `cookLogs` map.
- `src/lib/libraryMemory.ts`: `cookLogs` map in the snapshot, `empty`,
  `cloneMaps`, `replaceFromPull`; `upsertCookLog`, `removeCookLogLocal`,
  `getCookLog`, `listCookLogs(recipeId?)` (sorted with `sortCookLogs`);
  `removeRecipeLocal` drops the recipe's entries and their photo ids.
- `src/lib/syncEngine.ts`: `pullAll` accumulator carries `cookLogs`.
- Extend `src/lib/syncEngine.test.ts` (put, tombstone, missing key from an old
  server). Update its `acc` literals (~L18-24, L76-82) so `tsc -b` passes.
- `src/lib/recipeStore.ts` `remove`: re-upsert the captured cook logs on a
  failed delete (see Decisions); test in `recipeStore.remove.test.ts`.

### 5. [core] Store and hooks

New `src/lib/cookLogStore.ts`:
- `create(input)`: builds a `CookLog` with new id and timestamps, compacts,
  optimistic `upsertCookLog`, uploads pending photos, pushes `cookLog.put`;
  on failure removes locally and rethrows a user-facing error.
- `save(log)`: bumps `updatedAt`, same flow, rolls back to previous on
  failure. Only after a successful put, deletes photos removed from the entry.
- `remove(id)`: optimistic remove; pushes one batch, `cookLog.delete` first
  then `photo.delete` for its photos; restores on failure; `dropPhoto` on
  success.
- `promoteLesson(recipeId, log)`: reads `getRecipe(recipeId)` (latest), then
  `recipeStore.save({ ...recipe, notes: appendLessonToNotes(recipe.notes,
  log.lessons) })`; no-op if already in notes; throws "This recipe is no
  longer in your library." if `getRecipe` is undefined.
- The store takes photo ids that are already in `photoStore` (encoding happens
  in the form, step 8).
- Hooks: `useCookLogs(recipeId?)` (`undefined` while not loaded) and
  `useCookLog(id)`.
- Error copy follows existing stores ("Please sign in again — your session
  expired." / "Couldn't save the cook log.").

### 6. [core] Backup

`src/lib/backup.ts`: `version: 1 | 2 | 3 | 4`, export 4 with `cookLogs`
(`listCookLogs()`); `attributePhotos` includes entries; import filters with
`isUsableCookLog` + `compactCookLog`, upserts locally, pushes `cookLog.put`
after recipes. `src/lib/backup.test.ts`: v4 import pushes `cookLog.put` and
uploads its photo with the entry's `recipeId`; v3 file still imports.

### 7. [ui] Shared photo picker

Move `GalleryField` from `src/components/RecipeForm.tsx` into
`src/components/PhotoPickerField.tsx` with props `label`, `hint`, `max`, and
a generic remove label ("Remove photo"; the recipe form passes its current
"Remove gallery photo" so its markup and copy stay the same, including the hint
"Extra photos shown at the end of the recipe."). Encoding stays in the forms'
submit handlers.

### 8. [ui] Log form

New `src/screens/CookLogEdit.tsx`, routes `/recipe/:id/cooks/new` and
`/recipe/:id/cooks/:logId/edit` in `src/App.tsx`. Fields: date (`<input
type="date">`, defaults to `todayCookedOn()`), rating (5 star buttons, tap the
selected star again to clear), servings (prefilled from `useCookState(recipe)`
on new), Notes (placeholder "How it went, what you swapped or changed"),
Lessons (placeholder "What to do differently next time"), photos via
`PhotoPickerField` (max 8). Submit copies `RecipeForm.submit`: encode every
newly picked file with `encodeImageForStorage`, `photoStore.add` each, call
`cookLogStore.create`/`save`, and `photoStore.remove` the new ids if that
throws; show "That photo couldn't be read — it may not be a real image." when
encoding fails (same copy as `ChatPanel`). Save → back to
`/recipe/:id`. Edit screen has
Delete with a confirm step. Inline error text on failure, matching
`RecipeEdit`. Unknown recipe or entry → the same "not found" treatment as
`RecipeView`.

### 9. [ui] Recipe page

`src/screens/RecipeView.tsx`: under "Done — enjoy!" add a "Log this cook" link
to `/recipe/:id/cooks/new`. After the gallery and before the source line add
"Your cooks" (heading with count) listing `CookLogCard`s and a "Log a cook"
link (shown even with zero entries). New `src/components/CookLogCard.tsx`:
date (formatted from `cookedOn` without timezone shifts), stars, servings,
notes, lessons with "Add to recipe notes" button or "In notes" label, photo
grid via `usePhotoUrl` (a photo with no URL renders nothing), Edit link.
Optional `recipeTitle` prop for the journal. Also add `whitespace-pre-line` to
the recipe Notes paragraph (~L247) so promoted lessons show as separate
paragraphs; use the same class for entry notes and lessons.

### 10. [ui] Journal

New `src/screens/CookJournal.tsx` at `/cooks`. Library header gets a "Cooks"
link beside Settings (`src/screens/Library.tsx` ~L240). List all entries
newest first via `useCookLogs()`, each a `CookLogCard` with its recipe title
linking to the recipe; skip entries whose recipe is not in memory. Loading,
empty ("No cooks logged yet. Open a recipe and tap Log a cook."), and signed-out
states follow Library's copy style. Back link to Library.

### 11. [ui] Copy

- Library delete dialog: "This also deletes its chat history and cook log.
  There is no undo."
- `public/privacy.html`: add cook log entries (dates, ratings, notes, lessons,
  photos) to what is stored, and to what recipe deletion and account wipe
  remove.

### 12. [core] Docs

- `docs/workstreams/CONTEXT.md` domain model: add `CookLog`.
- `AGENTS.md` Plans row status updated to reflect completion.
- Constitution: if implementation deviated, record an amendment. Keep
  `status: draft` until merge.

## Verification

- `npm test` and `npm run build` pass.
- Browser (Vite + `dev:api`, signed in at `http://localhost:5173`), on a
  throwaway recipe (dev writes to the real library):
  create an entry with 2 photos from "Done"; edit it and remove a photo;
  promote a lesson (Notes update, card shows "In notes"); `/cooks` lists it;
  Settings → Refresh keeps it; delete the recipe → entry gone from `/cooks`.
- Verifier checks the diff against each of the 12 constitution principles
  (pass/fail each). An unamended break is FAIL.
