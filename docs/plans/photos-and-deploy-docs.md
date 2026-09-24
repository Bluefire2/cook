# Photos and deploy docs (parent steps 18–19)

Parent: `docs/plans/sous-oauth-db.md`. This file is the executable workback for
the two remaining **repo** steps before a production deploy. It does **not**
cover steps 20–22 (live deploy, consent Production, end-state check). Do not
run `scripts/deploy.sh` against production as part of this plan.

## Goal

Recipe and chat photos leave the device: they upload to a private GCS bucket
under `users/{uid}/{photoId}`, other signed-in devices fetch them lazily into
IndexedDB, and deletes actually remove the object. Then the deploy script, env
example, README, and legal pages describe the product that actually exists
(Google sign-in, Firestore, GCS) instead of the identity-only / app-password
story they still tell.

## Starting state (verified by reading the code)

- Firestore Native `(default)` is live in `europe-west1`. Recipe / chat /
  cookState sync already writes under `users/{uid}/…`. Photo **metadata**
  tombstones and `gcsDeletes` rows are written by `cascadeRecipeDelete` and
  `photo.delete`; **nothing drains `gcsDeletes`**, and **nothing writes GCS**.
- The photo bucket does **not** exist. Cloud Run SA IAM for `datastore.user` /
  `storage.objectAdmin` was deferred. `photoBucket()` in `server/env.ts` already
  returns `null` when `PHOTO_BUCKET` is unset.
- `scripts/server.ts` already has a prefix matcher for `/api/photos/:id` (one
  segment, no extra slash). It currently returns `null` → 404. Step 6 of the
  parent planned this; step 18 mounts the handler.
- `photoStore.add(blob)` is local-only. Parent stores enqueue `photo.put`
  `{ id, recipeId, updatedAt }`. `sweepUnreferenced` still enqueues nothing.
- `drainOutbox` uses `splitDrainBatch`, which **skips `photo.put`** and returns
  `'ok'` when the remaining queue is only photos. Parent step 18 **supersedes**
  that skip: once `/api/photos` exists, those rows POST. A 503 (bucket unset, or
  GCS down) leaves the row and **does not** increment `attempts` toward park.
- `getBlob` is called from `useLiveQuery` inside `usePhotoUrl`. It must stay a
  pure local read. `ensureLocal` is new and is called from an effect on
  `usePhotoUrl`, not from `getBlob`.
- Toast counting (`b4b43b6`): `SyncResult.pushed` currently never includes
  `photo.put` because they were skipped. After this plan, a successful photo
  POST counts as pushed and can fire "Synced". Accepted, not a blocker. Update
  the comment on `SyncResult.pushed`.
- `scripts/deploy.sh` still `resolve_secret`s `APP_PASSWORD` and writes only
  `GEMINI_API_KEY` + `APP_PASSWORD`. `--env-vars-file` **replaces the whole
  env map**, so leaving `APP_PASSWORD` off that list is what deletes it from
  the live service on the next deploy (step 20, not this plan).
- `.env.example` and README still describe the app password and "no account,
  no server database, and no sync". `public/privacy.html` / `terms.html` still
  say the library is device-only.
- `@google-cloud/storage` is already in `package.json`. No new dependencies.

## Workback

Read bottom-to-top to execute. Each line is blocked by everything under it.

```
19. README, .env.example, privacy/terms rewrite          [repo]
    └─ 18f. deploy.sh env map (APP_PASSWORD gone)        [repo]
        └─ 18e. ensureLocal + usePhotoUrl effect         [repo]
            └─ 18d. Drain photo.put (POST, 503 no-park)  [repo]
                └─ 18c. Mount GET|POST /api/photos/:id   [repo]
                    └─ 18b. server/photos.ts protocol    [repo]
                        └─ 18a. Bucket + runtime IAM     [operational]
```

18a is operational (`gcloud` as `chernyshov.k@gmail.com`). 18b–18f and 19 are
repo. Local drain/ensureLocal Verify needs the bucket **or** a set
`PHOTO_BUCKET` pointing at it; until 18a lands, `/api/photos/*` is 503 and
outbox rows stay, which is itself a Verify case.

## Assumptions

- Settled parent decisions are not re-opened: uid-derived object path, staged
  POST (intent → bytes → confirm), tombstone-wins-on-equal, `Cache-Control:
  private, no-store`, no signed URLs, `add(blob)` local-only, `getBlob` pure.
- Firestore database id stays `(default)`; do **not** write
  `FIRESTORE_DATABASE_ID` into deploy.sh or `.env.example`.
- Bucket name `sous-photos-cooking-assistant-508423` unless create fails
  because the global name is taken — then append `-1` and carry the new name
  through this file, `.env.example`, deploy.sh, and the parent Deploy record.
- Cloud Run SA: confirm with `serviceAccountName` before binding. Empty means
  `62867274312-compute@developer.gserviceaccount.com`.
- `erasableSyntaxOnly`: no enums, no constructor parameter properties.
- Dexie name stays `cook`. Do not edit v1/v2/v3 `stores()`. Do not add fields
  to `Recipe` / `ChatMessage` / `CookStateRow`. Photo Dexie rows stay
  `{ id, blob, createdAt }`.
- Do not change `vercel.json`, Dockerfile pin/stages/CMD, or the
  `/api/sync/pull` and `/api/sync/push` JSON contracts.
- Do not add fake-indexeddb, a GCS mock, or a DOM testing library. Pure helpers
  only.
- Local ADC (`gcloud auth application-default login` + quota project
  `cooking-assistant-508423`) is how `npm run dev:api` talks to Firestore and
  GCS. Unset `PHOTO_BUCKET` is the opt-out that keeps photo sync off.

## Files to change

| File | Change |
| --- | --- |
| (gcloud, not a file) | Create bucket; IAM on Cloud Run SA; fill parent Deploy record rows for bucket / SA / roles. |
| `server/photos.ts` | **New.** Staged POST, streaming GET, `gcsDeletes` drain, stale-`uploading` sweep. |
| `server/photos.test.ts` | **New.** Pure: UUID path gate, photo LWW vs live/tombstone, 413/400 header rules as pure predicates. |
| `scripts/server.ts` | Mount `GET` and `POST` `/api/photos/:id` on the existing prefix matcher. |
| `src/lib/syncEngine.ts` | Stop skipping `photo.put`; POST with headers; concurrency 2; largest last; 503/unset no park; missing blob drop. Update `SyncResult.pushed` comment. Call GCS drain is **server-side** (after photo mutations and after push) — not from the client. |
| `src/lib/syncEngine.test.ts` | Replace skip-forever tests with ordering / no-park helpers. |
| `src/lib/photoStore.ts` | `ensureLocal`; `usePhotoUrl` effect. `add` / `getBlob` / `sweepUnreferenced` unchanged in contract. |
| `scripts/deploy.sh` | New env map; `APP_PASSWORD` gone; `SESSION_SECRET` generate-only-if-describe-succeeded. |
| `.env.example` | Ten-variable table from the parent Names section; no `APP_PASSWORD`. |
| `README.md` | Identity + sync + photos; env table; local ADC; Sync subsection. |
| `public/privacy.html` | Storage / retention rewrite from parent step 19. |
| `public/terms.html` | Drop "stored on the device you are using" as the whole story. |
| `docs/plans/sous-oauth-db.md` | Fill Deploy record after 18a; tick 18 and 19 only after Verify. |

No changes to `src/lib/db.ts` stores, `src/lib/types.ts`, `src/lib/outbox.ts`
op union (already has `photo.put` / `photo.delete`), `src/index.css`, or
`src/lib/uiClasses.ts`. `CardThumb` / `PhotoThumb` already render an empty box
when the URL is missing — do not restyle them.

## Steps

### 1. [core] Photo bucket and runtime IAM *(operational; before 18b Verify against GCS)*

Run as `chernyshov.k@gmail.com`. Firestore already exists; do **not** create
another database.

```powershell
$gcloud = "C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$P = 'cooking-assistant-508423'

& $gcloud config get account
& $gcloud storage buckets create gs://sous-photos-cooking-assistant-508423 --location=europe-west1 --uniform-bucket-level-access --public-access-prevention --project=$P

& $gcloud run services describe sous --region=europe-west1 --project=$P --format="value(spec.template.spec.serviceAccountName)"
& $gcloud projects describe $P --format="value(projectNumber)"
```

Use the printed SA (empty → `62867274312-compute@developer.gserviceaccount.com`):

```powershell
$SA = '62867274312-compute@developer.gserviceaccount.com'   # confirm first
& $gcloud projects add-iam-policy-binding $P --member="serviceAccount:$SA" --role="roles/datastore.user" --condition=None
& $gcloud storage buckets add-iam-policy-binding gs://sous-photos-cooking-assistant-508423 --member="serviceAccount:$SA" --role="roles/storage.objectAdmin" --project=$P
```

Describe and read the output, then fill the parent Deploy record:

| What | Value to write |
| --- | --- |
| Photo bucket name | whatever `buckets describe` prints |
| Runtime service account | the `$SA` actually bound |
| Roles granted to it | `roles/datastore.user`, `roles/storage.objectAdmin` |

Local ADC (if not already):

```powershell
& $gcloud auth application-default login
& $gcloud auth application-default set-quota-project $P
```

Add `PHOTO_BUCKET=sous-photos-cooking-assistant-508423` to **local**
`.env.local` (gitignored). Restart `npm run dev:api` after.

Failure handling:

- **Bucket name taken** → append `-1`, update `PHOTO_BUCKET` everywhere in this
  plan and later files, record the real name.
- **`add-iam-policy-binding` denied** → active account needs Owner or
  `roles/resourcemanager.projectIamAdmin`.
- **API not enabled** → `storage.googleapis.com` was enabled with Firestore;
  wait a minute and retry once.

**Verify:** `buckets describe` shows `uniformBucketLevelAccess.enabled: true`
and `publicAccessPrevention: enforced`; `location` is `EUROPE-WEST1`. The SA
role table includes `roles/datastore.user`. The binding on the **bucket**
includes `roles/storage.objectAdmin` for that SA.

### 2. [core] `server/photos.ts` — staged upload, GET, GCS drain

**New file.** One GCS `Storage` client per process, lazy like Firestore, from
`photoBucket()`. If `photoBucket()` is `null`, every handler returns **503**
before touching Firestore or GCS.

Object name is **`users/{uid}/{photoId}`** with `uid` from `sessionFrom(req)`
only. `photoId` must pass `isUuid` from `server/store.ts`; anything else is
**400**. That is the only place a `../` in an id would matter.

Export a pure `assertPhotoId(id: string): boolean` (or reuse `isUuid`) and a
pure `photoUploadDecision(stored, clientUpdatedAt)` that is `compareMutation`
for `'put'` — do not duplicate LWW.

**`POST /api/photos/:id`**

Session required; else 401. Required headers: `x-photo-updated-at` (finite ms)
and `x-recipe-id` (`isUuid`); missing or unparseable ⇒ **400**. `Content-Type`
must be `image/jpeg` or `image/png`; else **400**. Body cap **2 MB**:

- If `Content-Length` is present and `> 2_000_000` ⇒ **413** *before* the
  intent transaction (do not write `uploading`).
- If `Content-Length` is absent, count bytes while streaming to GCS and abort
  with 413 if the count exceeds 2 MB. Do not buffer the whole body.

Staged protocol — each stage is retry-safe; **never** wrap GCS in
`runTransaction`:

1. **Intent (Firestore transaction).** Read `users/{uid}/recipes/{recipeId}`
   and `users/{uid}/photos/{id}`. If the recipe is missing or tombstoned →
   **409** `{ error: 'recipe-deleted' }`, no GCS. Run LWW with
   tombstone-wins-on-equal (`compareMutation(..., 'put')`). If stored photo is
   **live** → **200** and stop (idempotent replay; do not touch GCS). If a
   tombstone wins → **409**, no GCS. If the put should apply: write metadata
   `{ id, recipeId, status: 'uploading', updatedAt, contentType, size,
   serverUpdatedAt }` with `deletedAt` cleared. `size` from `Content-Length`
   when present, else omit until confirm.
2. **Bytes (GCS, outside any transaction).** Upload to
   `users/{uid}/{photoId}`. If metadata `status` is `uploading`, overwrite is
   allowed (retry of a crashed step 2). If `ifGenerationMatch: 0` fails because
   the object already exists, continue. On GCS failure: leave metadata
   `uploading`, return **503**.
3. **Confirm (Firestore transaction).** Re-read recipe and photo metadata. If
   the recipe is now tombstoned, or photo metadata is now a tombstone: write
   `gcsDeletes/{id}`, tombstone the photo if not already, return **409**
   `recipe-deleted`. If metadata is still `uploading` or live: set
   `status: 'live'`, `deletedAt` cleared, `recipeId`, `contentType`, `size`,
   `serverUpdatedAt`, return **200**.
4. Concurrent delete vs upload is covered by parent step 13: recipe tombstone
   first. A POST that passed intent then loses is caught at confirm.

**`GET /api/photos/:id`**

Session required. **404** unless the metadata document exists, is not
tombstoned, `status === 'live'`, and is under **this** `uid`. Stream the object
through — do not buffer. `Content-Type` from metadata.
`Cache-Control: private, no-store`. No signed URLs.

**GCS drain**, invoked at the end of photo mutations **and** from `syncPush`
after applying ops (import a `drainGcsDeletes(uid)` from `photos.ts` into
`server/sync.ts` — a one-line call, not a second copy of the loop):

- Query `users/{uid}/gcsDeletes`. For each row: delete the GCS object
  (`users/{uid}/{photoId}`); a missing object is success. Then delete the
  `gcsDeletes` row.
- Also treat photo metadata with `status: 'uploading'` and `serverUpdatedAt`
  older than **15 minutes** as failed: enqueue `gcsDeletes`, tombstone the
  metadata. GET 404s unless live.

Reuse `col` / `userRoot` path builders in `store.ts` rather than concatenating
collection strings in `photos.ts`. If a helper is missing, add a narrow export
(`photoRef`, `gcsDeletesRef` already module-private — export
`drain-needed` accessors or move drain next to them). Do not invent a second
`users/{uid}` layout.

**`server/photos.test.ts`:** UUID rejection; LWW live-replay vs tombstone-wins;
`Content-Type` allow-list predicate; 2 MB predicate. No GCS.

**Verify:** `npm test` and `npm run build` clean. Hand checks wait until step 4
so there is a client; 503-without-bucket can be probed as soon as the route is
mounted.

### 3. [core] Mount `GET|POST /api/photos/:id`

In `scripts/server.ts`, the prefix matcher currently returns `null` for a
single-segment rest. Change that branch to dispatch on method:

- `POST` → `photosPost(req)` (id from the rest segment)
- `GET` / `HEAD` → `photosGet(req)`
- other methods → `'wrongMethod'` (existing 405)
- empty rest or extra `/` → leave as 404 (already)

Pass the Request through; handlers read the id from `new URL(req.url).pathname`.
Do not parse the id from the body.

**Verify:**

```
no cookie GET /api/photos/<uuid> → 401
no cookie POST → 401
GET /api/photos/not-a-uuid (with cookie) → 400
GET /api/photos/ → 404
GET /api/photos/a/b → 404
PHOTO_BUCKET unset → 503
```

Restart `npm run dev:api` after the mount.

### 4. [core] Drain `photo.put`: POST, concurrency 2, 503 does not park

Replace the skip-forever behaviour.

**`splitDrainBatch`** still separates `photo.put` from sync ops so a leading
photo cannot stall `recipe.put` (that bug was already fixed). It no longer
means "leave photos forever". After the sync-op batch is pushed (or if there
are none left except photos), drain photos.

Pure helpers to export and unit-test:

- `orderPhotoPutsLargestLast(rows, sizeById: Map<string, number>): OutboxRow[]`
  — missing size sorts as 0 (upload first). "Largest last" so a 2 MB body does
  not occupy both concurrency slots at the start of the queue.
- `shouldParkPhotoPut(status: number, attempts: number): boolean` — **false**
  for 503 (and for network throw that looks like "bucket/GCS unavailable").
  **false** for 409 `recipe-deleted` / already-deleted — those **drop** the row
  (terminal) rather than park. **true** only follows the existing
  `attempts > 5` path for other 4xx/5xx that are not 503.

**POST** `/api/photos/:id` with:

- `credentials: 'same-origin'`
- `Content-Type` from the blob (`image/jpeg` or `image/png`; if the blob type
  is empty, sniff or default `image/jpeg` — if it is neither jpeg nor png,
  drop the op as invalid rather than 400-loop)
- `x-photo-updated-at`: payload `updatedAt`
- `x-recipe-id`: payload `recipeId`
- body: the blob from `db.photos.get(id)` at drain time

**Missing local blob** → delete the outbox row, do not retry, do not increment
`pushed`. The file is gone; a retry cannot grow it back.

**Concurrency 2** across in-flight photo POSTs. Flush any pending sync-op
batch **before** starting photo POSTs so a `recipe.put` in the same outbox
lands first (parent enqueue order is recipe then photo).

Status handling:

| Response | Outbox | `pushed` | `attempts` |
| --- | --- | --- | --- |
| 200 | delete row | +1 | — |
| 409 recipe-deleted / already-deleted | delete row | no | — |
| 401 | stop drain, `invalidateSession`, `signedOut` | keep rows | no |
| 503 | keep row | no | **do not** increment toward park |
| 413 / 400 | increment `attempts`; park after 5 | no | yes |
| network throw | same as 503 if the message is unavailable; otherwise increment and `stop` | no | see 503 |

Update `SyncResult.pushed` comment: photo POSTs that return 200 **are**
included.

Keep `splitDrainBatch` tests that later sync ops still drain when photos lead.
Replace "skip without counting toward the batch" as the *end state* — photos
are a separate drain phase, not a skip.

After a successful push batch, the **server** already calls `drainGcsDeletes`
(step 2). The client does not.

**Verify:** `npm test` / `npm run build`. With `PHOTO_BUCKET` unset: attach a
photo, confirm the `photo.put` row stays and `attempts` stays 0 across Sync
now. With the bucket set: see step 8.

### 5. [core] `ensureLocal` and the `usePhotoUrl` effect

In `src/lib/photoStore.ts`:

- `ensureLocal(id: string): Promise<void>` — if `db.photos` already has the
  id, return. Else `GET /api/photos/:id` with `credentials: 'same-origin'`. On
  200, `put` `{ id, blob, createdAt: Date.now() }` (or `createdAt` from the
  response if you add none — Dexie `createdAt` is local cache metadata, not
  synced). Deduplicate with a module-scope `Map<string, Promise<void>>` so
  twelve cards with the same id fire **one** GET. A 404, 401, 503, or network
  failure **resolves quietly** — never throw, never `console.error` in the
  hot path (a missing thumb is the empty box).
- `getBlob` stays a pure local read. Do not fetch inside it.
- `usePhotoUrl(id)`: keep the `useLiveQuery(getBlob)`. Add
  `useEffect(() => { if (id) void photoStore.ensureLocal(id); }, [id])`.
  When the blob lands, the live query re-renders.

`CardThumb` / `PhotoThumb` / `useObjectUrl` stay as they are.

**Verify:** `npm run build`. A recipe whose photo is not uploaded yet still
shows the empty box, no console error, no broken-image icon.

### 6. [core] `scripts/deploy.sh` env map

Keep the script's shape: `resolve_secret`'s env → deployed service → prompt,
`strip_controls`, `JSON.stringify` `--env-vars-file` writer, `to_native_path`,
the `gcloud run deploy` flags. Change **only** the env map and the
`SESSION_SECRET` / `APP_PASSWORD` rules.

- `resolve_secret` for `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`,
  `ALLOWED_EMAILS` (not secret; same stickiness so a redeploy cannot lock
  everyone out), `GEMINI_API_KEY`.
- **Remove `APP_PASSWORD`** from `resolve_secret`, from the YAML key list, and
  from closing `info` lines. Comment that `--env-vars-file` replaces the whole
  map, so dropping the key is what deletes it from the service on the next
  deploy.
- **`SESSION_SECRET`:** environment, then deployed service, then generate 32
  random bytes **only** when `gcloud run services describe` **succeeded** and
  the var was absent. If describe failed (network, wrong project, expired
  creds), `die` with: could not read `SESSION_SECRET` off the service; refusing
  to generate a new one because it would sign every device out.
  `read_deployed_env` currently `return 0` on both "no service" and "call
  failed". Split them: describe failure (non-zero, or empty stdout when the
  service **does** exist) is fatal for this variable; a missing service on a
  first deploy is the generate path. Implement the distinction explicitly —
  do not guess from empty string alone if describe's exit code was non-zero.
- Non-secret keys in the same YAML: `PUBLIC_ORIGIN=https://sous.kyrylo.lol`,
  `GOOGLE_CLOUD_PROJECT=cooking-assistant-508423`,
  `PHOTO_BUCKET=sous-photos-cooking-assistant-508423`. **No**
  `FIRESTORE_DATABASE_ID`.
- Never put a secret on a `gcloud` command line. Never go back to
  `--set-env-vars`.
- Closing `info`: replace "set the app password in Settings" with: after this
  deploy (step 20), fill consent-screen Branding URLs and publish (step 21).
  Domain-mapping paragraphs can stay as history; the mapping already exists.

Update the file header comment that still says `APP_PASSWORD` cannot be changed
by accident.

**Verify:** `bash -n scripts/deploy.sh` parses. `shellcheck` if available (not
a gate).
`Select-String -Path scripts/deploy.sh -Pattern 'APP_PASSWORD|x-app-password'`
returns nothing.

Do **not** run the script.

### 7. [core] `.env.example` and `README.md`

**`.env.example`**, the parent Names table, no `APP_PASSWORD`:

- `GEMINI_API_KEY`
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`
- `SESSION_SECRET` — comment: must not change or everyone is signed out
- `ALLOWED_EMAILS` — comment: empty means nobody can sign in (fail-closed)
- `PUBLIC_ORIGIN=http://localhost:5173` — must match the OAuth client's
  redirect URI
- `GOOGLE_CLOUD_PROJECT=cooking-assistant-508423`
- `PHOTO_BUCKET=sous-photos-cooking-assistant-508423` — comment: unset turns
  photo sync off (503, outbox kept)
- optional `CHAT_MODEL`
- Keep the existing `VITE_` warning **verbatim**

**`README.md`**, only what Phase 2 made false:

- Intro: sign in with Google; recipes, chat, progress and photos live in the
  account (Firestore + Cloud Storage, region `europe-west1` per the Deploy
  record) and are cached on each device so the app works offline. Drop "There
  is no account, no server database, and no sync".
- Install: Settings → **Sign in with Google**, not the app password. Keep the
  Vercel-origin export/import note; add that chat and import on that origin
  now return 401 by design.
- Stack: `google-auth-library`, `@google-cloud/firestore`,
  `@google-cloud/storage`, and `server/` next to `api/` — new routes live in
  `server/` because `api/` cannot import siblings on Vercel.
- Env table: the new set; `APP_PASSWORD` gone; `ALLOWED_EMAILS` fail-closed;
  `SESSION_SECRET` stickiness.
- Local development: `gcloud auth application-default login`; dev talks to the
  **real** Firestore and bucket by default; opt-outs are
  `FIRESTORE_EMULATOR_HOST` and unset `PHOTO_BUCKET`.
- "How it's put together": `server/` in the tree; UI → stores; stores and
  `syncEngine` are the only things that touch `db`.
- Short **Sync** subsection: server is source of truth, IndexedDB is a cache,
  LWW on `updatedAt`, tombstones, outbox, lazy photos, Export→Import
  migration.
- "Your data" must not contradict the rewritten privacy page.
- `npm test` line currently says "Vitest once over `src/`" — it also covers
  `server/`. Fix that.
- Deployment: `bash scripts/deploy.sh` with the new variables. Keep
  domain-mapping / certificate paragraphs as history, unchanged.

**Verify:**
`Select-String -Path .env.example,README.md -Pattern 'APP_PASSWORD|x-app-password'`
is empty. "No account" / "no sync" / "enter the app password" do not survive.
Re-read every changed README claim against the tree.

### 8. [core] Privacy and terms rewrite

`public/privacy.html` and `public/terms.html`. Use the Deploy record
`locationId` (`europe-west1`) — do **not** write "stored in the EU" as an
unconditional fact. Google's reviewer will read this before step 21.

Privacy, storage and retention sections:

- **What is stored:** Google `sub`, email, display name; recipes, chat
  messages, cooking progress, and attached photos in Google Cloud (Firestore
  and Cloud Storage) in `europe-west1`; a copy cached in IndexedDB per device.
  No password, no Google refresh token.
- **What it is used for:** showing your own recipe library across devices, and
  answering cooking questions. Not sold, not shared, not used for advertising.
- **Retention and deletion:** deleting a recipe deletes its chat thread,
  progress and photos. To delete the whole account's stored data, email
  **chernyshov.k@gmail.com** from the signed-in address (no in-app
  delete-account button). Revoking Google access signs you out but does **not**
  by itself delete stored recipes.

Terms: drop "the recipe library is stored on the device you are using" as the
whole story. The library syncs, with an on-device cache. Keep the AI-accuracy
and liability sections.

Bump "Last updated" to the day this lands. Do not deploy (20) or fill Branding
URLs (21) until this rewrite is in `dist/` (`npm run build` copies `public/`).

**Verify:** `npm run build`; open `/privacy` and `/terms` on the Vite origin
and confirm they match the bullets. No leftover "no server-side library yet".

## Verify (end to end)

Automated, both clean:

```
npm test
npm run build
```

```
bash -n scripts/deploy.sh
Select-String -Path scripts/deploy.sh,.env.example,README.md -Pattern 'APP_PASSWORD|x-app-password'
```

must print nothing.

By hand. `PHOTO_BUCKET` set, both dev servers, signed in at
http://localhost:5173.

1. Attach a photo to a recipe and to a chat message. Outbox drains to empty
   (including `photo.put`).  
   `gcloud storage ls gs://sous-photos-cooking-assistant-508423/users/<your-sub>/ --project=cooking-assistant-508423`  
   lists both objects. Firestore shows two live photo metadata docs under
   `users/{sub}/photos`.
2. Second browser profile, same Google account: Library thumbnail and chat
   photo both render. Network shows exactly **one** `GET /api/photos/<id>` per
   photo, not one per card render.
3. `GET /api/photos/<id>` with no cookie → 401; with a cookie for a different
   account → **404**; non-UUID id → 400.
4. Delete the recipe: object disappears from the bucket; metadata is
   tombstoned; second profile loses the thumbnail on its next pull.
5. A recipe whose photo is not yet uploaded shows the empty thumbnail box, no
   console error, no broken-image icon.
6. `POST /api/photos/<id>` with a 3 MB body → 413.
7. Unset `PHOTO_BUCKET`, restart API, attach a photo, Sync now: row stays,
   `attempts` stays 0, Settings pending count stays non-zero, no park, no
   error toast from a 503-kept row (a 503 is not `outcome: 'error'` if drain
   continues; if the rest of the sync succeeded, do not toast an error solely
   because photos waited). Restore `PHOTO_BUCKET` and the next sync uploads.
8. `cp .env.example .env.local` is **not** a live test (it would wipe secrets).
   Instead diff `.env.example` against the keys in the current `.env.local`
   (without printing values) and confirm both servers still boot from the
   existing `.env.local` after the new keys are documented.

Tick parent status 18 and 19 only after this list is done. Do not tick 20–22.

## Failure handling

- **Every photo 404s on a new device** → `ensureLocal` not wired, or the first
  device never POSTed (parked / skipped `photo.put`).
- **Photo from the wrong account** → object path not uid-derived. Impossible by
  construction if path uses `session.sub` only.
- **Memory spike on upload** → body buffered; stream it.
- **`storage.objects.create` denied** → step 1 bucket IAM missing. 503, row
  kept, no park.
- **Silent regeneration of `SESSION_SECRET`** → describe-failed path must
  `die`. This is the most dangerous line in `deploy.sh`.
- **Next production deploy wipes OAuth env** → if step 6's YAML omits a key
  that is currently on the service. The map must include every key the
  container needs (`AUTH_*`, `SESSION_SECRET`, `ALLOWED_EMAILS`,
  `PUBLIC_ORIGIN`, `GOOGLE_CLOUD_PROJECT`, `PHOTO_BUCKET`, `GEMINI_API_KEY`).

## Risks

- **Skip-without-park leftover.** An implementer who leaves `splitDrainBatch`
  as "photos never POST" ships 18's server with a client that never uploads.
- **Intent written, GCS never confirmed.** Stale-`uploading` sweep at 15
  minutes plus POST retry is the recovery; GET must 404 until `live`.
- **`--env-vars-file` replaces the whole map.** A partial YAML signs everyone
  out or disables Gemini. List the keys in the Verify grep / a comment in the
  script.
- **Legal pages vs README drift.** Step 7 and 8 must agree; Google's reviewer
  reads `/privacy` and `/terms`, not the README.
- **Toast on photo upload.** After this, a visibility sync that POSTs a photo
  can show "Synced". Consistent with "data moved".
- **Hardening doc is still out of scope.** `resyncFromServer` cursor race,
  Dexie lease ownership, malformed-200 push bodies remain in
  `docs/plans/sync-engine-hardening.md`.

## Status

- [x] 1. [core] Photo bucket and runtime IAM *(operational)*
- [x] 2. [core] `server/photos.ts` — staged upload, GET, GCS drain
- [x] 3. [core] Mount `GET|POST /api/photos/:id`
- [x] 4. [core] Drain `photo.put`: POST, concurrency 2, 503 does not park
- [x] 5. [core] `ensureLocal` and the `usePhotoUrl` effect
- [x] 6. [core] `scripts/deploy.sh` env map
- [x] 7. [core] `.env.example` and `README.md`
- [x] 8. [core] Privacy and terms rewrite

## Open questions

None blocking. Bucket name collision is handled in step 1's failure path.
