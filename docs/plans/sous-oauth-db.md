# Sous Phase 2 — Google sign-in and per-user server storage

Phase 1 put the app on `https://sous.kyrylo.lol` with the same shared-password,
device-only data model it always had. Phase 2 gives Sous **accounts**: sign in
with Google, and the recipes, chat threads, cook progress and photos belong to
that Google account on the server, with IndexedDB demoted to a cache so the
library still opens on a plane. The shared `APP_PASSWORD` goes away.

This is a **workback**: the end state comes first, then every prerequisite that
must already be true before it. It does not re-open anything settled in
[`docs/plans/sous-subdomain.md`](sous-subdomain.md) (region, domain mapping,
Dockerfile Node pin, the Dexie database name, the `0x1E` chat protocol).

## Goal

- `https://sous.kyrylo.lol` shows **Sign in with Google**. One Google account
  (`sub`) = one recipe library. Signing in on a phone and on a desktop shows
  the same library.
- The server is the source of truth per user. IndexedDB (`cook`, unrenamed) is
  a **cache**: recipes, chat and cook progress open with no network, and
  changes made offline push when the network returns.
- `POST /api/chat` and `POST /api/import` are gated by the **session cookie**.
  No cookie, no cookie signature, or a signer that does not match ⇒ **401**.
  `APP_PASSWORD` and the `x-app-password` header no longer exist.
- `/api/chat` still streams: plain text, `0x1E`, proposal JSON, `0x1E`, nothing
  buffered anywhere. Cookies ride along on the same-origin fetch.
- Photos live in a private GCS bucket, fetched lazily per photo and cached in
  IndexedDB.
- `https://sous.kyrylo.lol/privacy` and `/terms` are **real HTML documents**
  served by the Node server (not an SPA shell), which is what lets the Google
  consent screen carry those URLs and be published to **Production**.
- Every mutation is keyed by the session's `sub`. No endpoint accepts a user id
  from the client.
- The Vercel deployment is not reconfigured. Its chat/import endpoints start
  returning 401 (it has no `SESSION_SECRET`), which is the intended fail-closed
  behaviour; its SPA and its own IndexedDB keep working.

## Why this is not "add a login button"

Three separate things are tangled together and each one can sink the others:

1. **There is no server database at all today.** `src/lib/db.ts` is the whole
   persistence story: Dexie tables `recipes`, `chatMessages`, `photos`,
   `cookState` in a per-origin IndexedDB. The only server code is two stateless
   Gemini proxies. So this is a new storage design — schema, sync protocol,
   conflict rule, tombstones, migration — not a partition of existing rows.
2. **The auth library has to fit a Vite SPA served by a hand-written Node
   server.** The OAuth runbook's sample is NextAuth on Next.js. There is no
   Next.js here, no framework router, no `app/api/[...nextauth]/route.ts`.
   Copying it means adopting Next.js.
3. **`api/chat.ts` and `api/import.ts` cannot import a sibling helper.** Both
   files say so at the top, and `RECIPE_SCHEMA` is duplicated between them for
   exactly that reason: Vercel transpiles each `api/` entrypoint in isolation.
   The session check cannot live in a shared module those two files import.

The substance of this plan is: a small, explicit OAuth code flow plus a signed
cookie; a Firestore/GCS data layer reachable only through the existing store
modules; and a sync engine that keeps the offline-first behaviour the app is
built around.

## Assumptions

Verified by reading the tree, not assumed:

- `api/chat.ts` and `api/import.ts` each export `POST(req: Request)` plus
  `maxDuration = 60`, and each gates on
  `process.env.APP_PASSWORD` vs the `x-app-password` header, failing closed when
  the env var is unset or blank. Both have a "Duplicated in the other file …
  cannot import sibling helper files" comment above `RECIPE_SCHEMA`.
- `scripts/server.ts` owns routing. Its route table is
  `Record<string, (req: Request) => Promise<Response>>` keyed on pathname and
  **POST-only** (`handleApi` 405s any other method), it 404s unknown `/api/*`,
  serves `dist/` for GET/HEAD, and falls back to `index.html` only when the
  last path segment has no `.`. `scripts/dev-api-server.ts` is a 6-line wrapper
  calling `createRequestListener({ staticRoot: null })` on port 3001.
- `src/lib/chatApi.ts` and `src/lib/importApi.ts` fetch **relative** URLs and
  send `'x-app-password': settings.getPassword()`. Neither sets `credentials`.
  `chatApi` throws `'Wrong or missing app password — set it in Settings.'` on
  401.
- The three stores are the only things that touch `db`:
  `recipeStore.{list,get,save,applyDraft,create,remove}`,
  `chatStore.{listForRecipe,append,clearForRecipe}`,
  `photoStore.{add,getBlob,remove,sweepUnreferenced}`, plus the
  `cookStateStore` private to `src/lib/useCookState.ts` and the direct
  `db.*.bulkPut` calls in `src/lib/backup.ts`. `db.ts`'s export comment states
  the boundary exists "so a future migration to server storage [is] contained
  to the stores" — this plan honours that and extends the boundary to a new
  `syncEngine` sibling.
- `src/lib/backup.ts` writes `app: 'cook'`, `version: 2`, and
  `importLibrary` bypasses the stores with `db.recipes.bulkPut(...)` etc. inside
  one transaction. Its marker check and the `cook-backup-…json` filename in
  `Settings.tsx` must agree, so neither changes.
- `seedIfEmpty()` runs from `src/main.tsx` on every boot, keyed on
  `localStorage['cook.hasSeeded']` and `db.recipes.count() > 0`.
- Photos are downscaled to 1280px on the long edge at JPEG q0.8 before storage
  (`src/lib/image.ts`), i.e. **roughly 150–400 KB each**, and `exportLibrary`
  base64s every one of them into a single JSON blob.
- `Recipe` already carries `updatedAt` (ms). `ChatMessage` carries `createdAt`
  and is append-only. `CookStateRow` has **no** `updatedAt` (only
  `recipeUpdatedAt`, which is the recipe version the progress was taken
  against).
- Tests run under `vitest` with `environment: 'node'` — **no jsdom, no
  fake-indexeddb**. Only pure functions are covered today
  (`compactRecipe`, `formatQuantity`, `extractRecipeSource`, `recipeShape`,
  theme settings, and `streamChatReply` with a stubbed `fetch` and a hand-rolled
  `globalThis.localStorage`). Anything Dexie-backed is untestable in this setup
  and stays that way in this plan.
- `tsconfig.node.json` already includes `scripts` and sets
  `erasableSyntaxOnly`; `tsconfig.api.json` covers `api` with `types: ["node"]`.
  Neither sets `types` in a way that blocks adding a `server` directory to the
  node project.
- `vite.config.ts` uses `VitePWA({ registerType: 'autoUpdate' })` with **no
  `workbox` block**, so the generated service worker takes vite-plugin-pwa's
  defaults — including an `index.html` navigate fallback with no denylist.
- `scripts/deploy.sh` resolves `GEMINI_API_KEY` and `APP_PASSWORD` in the order
  env → deployed service → silent prompt, strips C0 controls from prompted
  values, writes a `--env-vars-file` YAML with `JSON.stringify`, and deploys
  with `--allow-unauthenticated --port=8080 --cpu=1 --memory=512Mi
  --min-instances=0 --max-instances=4`.
- `vercel.json` is one rewrite: everything not under `api/` → `/index.html`.
- Project number is **62867274312** (recorded in the Phase 1 deploy record), so
  the default Cloud Run runtime identity is
  `62867274312-compute@developer.gserviceaccount.com` unless the service
  overrides it. Step 1 verifies rather than assumes.
- `gcloud` is **not on PATH**: it is
  `C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`,
  and the machine's default project is `match-cal-507107`, so every command
  passes `--project=cooking-assistant-508423` explicitly. Docker is not
  installed locally.
- `kyrylo.lol` is verified in Search Console as a **Domain** property under
  `chernyshov.k@gmail.com`; `sous.kyrylo.lol` already has a Google-managed
  certificate and is live.
- Historical plans and `AUDIT.md` are snapshots and are not rewritten.

## Names

| Placeholder | Value |
|---|---|
| domain | `sous.kyrylo.lol` |
| GCP project | `cooking-assistant-508423` (project number `62867274312`) |
| region / Firestore location | `europe-west1` |
| Cloud Run service | `sous` |
| Firestore database | `(default)`, Native mode — or `sous` if `(default)` is Datastore mode (step 1) |
| photo bucket | `gs://sous-photos-cooking-assistant-508423` |
| runtime service account | `62867274312-compute@developer.gserviceaccount.com` (confirm in step 1) |
| OAuth client name | `sous-web` (Web application) |
| production redirect URI | `https://sous.kyrylo.lol/api/auth/callback/google` |
| local redirect URI | `http://localhost:5173/api/auth/callback/google` |
| session cookie | `sous_session` |
| OAuth transaction cookie | `sous_oauth` |
| gcloud account | `chernyshov.k@gmail.com` |
| gcloud path | `C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd` |

Server environment variables after this phase:

| Variable | Secret | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes | unchanged |
| `CHAT_MODEL` | no | unchanged, optional |
| `AUTH_GOOGLE_ID` | no (but treat as private) | OAuth client id |
| `AUTH_GOOGLE_SECRET` | yes | OAuth client secret |
| `SESSION_SECRET` | yes | HMAC key for `sous_session`; **never rotate casually** |
| `ALLOWED_EMAILS` | no | comma-separated allowlist; **unset ⇒ nobody may sign in** |
| `PUBLIC_ORIGIN` | no | `https://sous.kyrylo.lol`; the redirect URI is built from it |
| `GOOGLE_CLOUD_PROJECT` | no | `cooking-assistant-508423` |
| `FIRESTORE_DATABASE_ID` | no | omit for `(default)`; set to `sous` if step 1 needed a named DB |
| `PHOTO_BUCKET` | no | `sous-photos-cooking-assistant-508423`; unset ⇒ photo sync off |
| ~~`APP_PASSWORD`~~ | — | **removed** |

## Decisions (settled — do not re-open)

- **Identity only. No Google API scopes, no offline access, no refresh token,
  no Cloud KMS.** Scopes are exactly `openid`,
  `https://www.googleapis.com/auth/userinfo.email`,
  `https://www.googleapis.com/auth/userinfo.profile` — all non-sensitive, so the
  app publishes to Production with no review. `access_type=offline` and
  `prompt=consent` are deliberately **absent**: nothing here calls a Google API
  while the user is away, so there is no refresh token to store or encrypt. The
  whole token-encryption half of match-cal does not exist in this app.
- **`google-auth-library` + our own signed cookie. Not Auth.js, not NextAuth.**
  Auth.js's `@auth/core` is a framework-adapter core whose route shape, cookie
  set and `AUTH_URL` semantics all assume an adapter we would have to write;
  its `/api/auth/callback/google` default is a Next.js convention, not a law.
  What this app needs is one provider, one flow, no refresh tokens. Google's own
  `OAuth2Client` covers the two parts that must not be hand-rolled — the code
  exchange and ID-token verification (JWKS fetch and cache, `iss`/`aud`/`exp`
  checks) — and everything else is `node:crypto`. The redirect path stays
  `/api/auth/callback/google` anyway, because it matches the runbook, keeps the
  console entry recognisable, and sits under the `/api/` prefix that both
  `scripts/server.ts` and `vercel.json` already treat as non-SPA.
- **Session = stateless HMAC cookie.** `sous_session` =
  `base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, SESSION_SECRET))`,
  payload `{ v: 1, sub, email, iat, exp }`. `HttpOnly`, `SameSite=Lax`,
  `Path=/`, `Secure` when `PUBLIC_ORIGIN` is https, `Max-Age` 90 days, re-issued
  on use when older than a day. No server-side session store (nothing to
  garbage-collect, works across Cloud Run instances and cold starts). The cost
  is no per-cookie kill switch: rotating `SESSION_SECRET` signs *everyone*
  out. **Removing an email from `ALLOWED_EMAILS` must still take effect on the
  next request**, not at cookie expiry. Every protected endpoint (auth session
  refresh, sync, photos, and the duplicated gates in `api/chat.ts` /
  `api/import.ts`) re-runs `isAllowed` on the verified cookie's email after
  HMAC success. Fail ⇒ 401, no `Set-Cookie` refresh. The allowlist is the
  billing/access control; HMAC only proves the cookie was issued by us.
- **The session check is duplicated inline in `api/chat.ts` and
  `api/import.ts`.** Same constraint and same precedent as `RECIPE_SCHEMA`:
  those two files cannot import a sibling. Each gets a ~40-line
  `sessionSub(req)` using only `node:crypto` that (1) verifies the HMAC and
  (2) re-parses `ALLOWED_EMAILS` and denies if the cookie email is no longer
  listed — same fail-closed rules as `server/allowlist.ts`, copied inline,
  with a "NOTE: duplicated in … `server/session.ts` and `server/allowlist.ts`;
  keep in sync" comment on all copies. HMAC success without an allowlist
  re-check would leave a removed user chatting for up to 90 days. **The alternative was rejected on purpose:** having
  `scripts/server.ts` verify the cookie and inject an `x-sous-user` header
  would leave the Vercel-hosted copies of those handlers accepting a
  client-supplied header, i.e. an open Gemini proxy on the origin this plan is
  forbidden to touch. Verifying a signature the client cannot forge is what
  makes "leave Vercel alone" safe.
- **No `APP_PASSWORD`, and no second gate.** A shared password fights per-user
  auth: it would have to be distributed to every allowed user and would keep
  working after a user is removed from the allowlist. It is removed from the
  handlers, from `settings.ts`, from the Settings screen, from `.env.example`,
  from the README and from `scripts/deploy.sh`'s env map. The localStorage key
  `cook.appPassword` is **not renamed and not deleted** — it is simply orphaned
  on devices that have it, which is the do-no-harm option.
- **Vercel degrades, deliberately.** The repo is one tree; whatever builds
  `sous.kyrylo.lol` also builds `cook-seven-mu.vercel.app`. Without
  `SESSION_SECRET` there, both handlers 401 — chat and import stop working on
  the Vercel origin while its library, search and recipe views keep working
  offline-first as before. No `vercel.json` change, no env change, no
  teardown, no redirect, and **no pausing of deploys** (that is a Vercel config
  change). Anyone still using that origin migrates with Export → Import.
- **New routes are Cloud Run only, and live in `server/`.** Only
  `api/chat.ts` and `api/import.ts` remain `api/` entrypoints, because they are
  the Vercel contract. Everything new — auth, sync, photos, the Firestore
  layer — is a module under a new `server/` directory imported by
  `scripts/server.ts`, which Vercel never builds. That sidesteps the
  sibling-import constraint entirely for all new code and keeps
  `@google-cloud/*` out of any Vercel function bundle.
- **Firestore (Native) for documents, GCS for photo bytes.** Justification,
  because this is the decision most worth being able to defend:
  - The data is already document-shaped. A `Recipe` is nested JSON —
    `ingredientSections[].items[]`, `steps[]`, `tags[]`. In Postgres that is
    either five tables and joins on every read, or one `jsonb` column, which is
    a document store with extra steps.
  - Operationally there is nothing to run. Cloud SQL means an instance billed
    around the clock plus a connector or socket for Cloud Run; Firestore is an
    API call authenticated by the service account's ADC, which is exactly how
    match-cal already talks to Firestore from Cloud Run in this same user's
    world. One user, a few hundred documents, tiny reads — comfortably inside
    the free daily quota.
  - **Photos must not go in the database.** Firestore's hard limit is 1 MiB per
    document, and a stored photo is 150–400 KB of JPEG that becomes ~1.33× that
    as base64 — technically under the limit, but it would make every recipe read
    drag its image along and bill document egress for blob traffic. They go to
    `gs://sous-photos-…` as `users/{uid}/{photoId}`, with a Firestore metadata
    doc, fetched lazily one at a time through the app's own endpoint.
  - No Firestore security rules are needed or written: nothing client-side
    talks to Firestore. The only credential is the Cloud Run service account,
    and every query is scoped to `users/{uid}` derived from the cookie. **No
    Firebase client SDK enters the bundle.**
- **Schema: one document subtree per user.**

  ```
  users/{uid}                        { email, name, createdAt, lastSeenAt }
  users/{uid}/recipes/{recipeId}     Recipe + serverUpdatedAt, deletedAt?
  users/{uid}/chatMessages/{id}      ChatMessage + serverUpdatedAt, deletedAt?
  users/{uid}/cookState/{recipeId}   CookStateRow + updatedAt, serverUpdatedAt
  users/{uid}/photos/{photoId}       { contentType, size, createdAt, serverUpdatedAt, deletedAt? }
  ```

  `uid` is the Google `sub` (opaque, stable, never reused — email is not, and
  is not a key). Deletes are **tombstones**: the doc stays. `deletedAt` is set
  and **payload fields other than identity/conflict metadata are stripped**.
  **Always keep** `id`, `updatedAt` (the client mutation time that won LWW),
  `deletedAt`, and `serverUpdatedAt`. A tombstone with no `updatedAt` cannot
  participate in LWW and an old offline put would resurrect it. `serverUpdatedAt`
  is `Date.now()` **on the server**, and is the pull cursor.
- **Conflict rule: last write wins per document, on `updatedAt`, and tombstones
  use the same comparison.** `putDoc` and `tombstone` both read the stored
  document first. Let `storedAt` be the stored `updatedAt` (or `0` if none).
  The incoming mutation carries `clientUpdatedAt`. If `storedAt > clientUpdatedAt`,
  reject and return `{ applied: false, current }` — this covers stale puts
  **and** stale deletes. If the stored row is a tombstone and the put is
  newer, un-delete and write the payload (`deletedAt` cleared). If the stored
  row is live and the delete is newer, tombstone it. Equal timestamps: treat as
  an idempotent replay (apply). `chatMessages` are immutable and id-keyed, so
  LWW is a no-op except for deletes. `cookState` gets an `updatedAt` **stamped
  by the client at enqueue time and carried on the outbox row and on the
  Firestore document**, not added to the Dexie `CookStateRow` — the local row
  shape and therefore every existing v2 backup file stay valid. Two devices
  editing the same recipe offline means one edit is silently lost; for a
  single-user app that is the right trade against a merge UI, and it is in the
  Risks. Client clocks can dominate LWW across devices; that is accepted and
  listed next to the server-clock risk. Recipe cascades stamp **one** `at` on
  the recipe tombstone and every cascaded child so they share a mutation time.
- **Wire DTOs are not Dexie rows.** Pull/push JSON is a `SyncChange` per kind.
  `syncEngine` **never** `bulkPut`s a Firestore document into `recipes` /
  `chatMessages` / `cookState` / `photos`. Per kind, after LWW apply:
  - `recipes` / `chatMessages`: if `deletedAt` → delete the local Dexie row
    (and cascade locally for a recipe); else write only the fields in
    `Recipe` / `ChatMessage` (`compactRecipe` on recipes). Strip
    `serverUpdatedAt` / `deletedAt`.
  - `cookState`: if deleted → delete the Dexie row; else write
    `{ recipeId, servings, currentStep, checkedKeys, recipeUpdatedAt }`
    only (`CookStateRow`) — never `updatedAt` or `serverUpdatedAt` onto the
    Dexie row. There is no `checkedIngredients` field.
  - `chatMessages` live rows include optional `photoIds` and `proposedRecipe`;
    there is no `images` field.
  - `photos`: if `deletedAt` → delete any local blob for that id; if live →
    **do not** insert a `Photo` row (it requires a `blob`). Record the id in
    `syncMeta['remotePhotos']` (a string array) so `ensureLocal` knows it
    exists remotely. `db.photos` is blobs only, as today.
- **Sync is pull-cursor + push-outbox, inside the data layer.** Dexie goes to
  **version 3**, adding exactly two tables: `outbox: '++seq'` and
  `syncMeta: 'key'`. The name `cook` and the v1/v2 declarations are untouched.
  Every mutating store method enqueues an outbox row **in its existing
  transaction** (so a rollback loses the op too), and a new
  `src/lib/syncEngine.ts` drains the outbox and applies pulls. `syncEngine` is
  the *only* module besides the stores and `backup.ts` allowed to import `db` —
  it is inside the boundary `db.ts` describes, not a caller of it. **No screen
  gains a `fetch`.**
- **Migration is Export → Import, never a silent scrape.** On first sign-in
  with unclaimed local rows, the app blocks with a one-time screen: *this device
  has N recipes that are not in your account; export a backup, then continue and
  the local copy is replaced by your account's library*. Continue ⇒ wipe the
  cache, set `cook.ownerUid`, full pull. **Import backup** while signed in goes
  through the stores, so it enqueues outbox rows and uploads — that is the
  migration path, and it needs no new code beyond routing `importLibrary`
  through the outbox.   `cook.hasSeeded` behaviour is unchanged, so the sample
  recipe does not come back after an import. **Seeding is sequenced after
  session resolution**, not kicked off in parallel with `fetchSession()`:
  `main.tsx` still renders immediately, but `seedIfEmpty()` runs only after
  `fetchSession()` returns a **definitive signed-out** result (`200` and
  `{ user: null }`). If a cached `cook.session` exists, or `cook.ownerUid` is
  set, or the session endpoint failed/offline, **do not seed** — a second
  device with a valid HttpOnly cookie and a cold localStorage must not create
  Spaghetti al Pomodoro before the cookie is read. Network failure is
  conservative: skip seed, open the cache, retry session on `online`.
- **Cache ownership is explicit, and it lands in the identity slice.**
  `localStorage['cook.ownerUid']` records whose cache this is. The identity
  slice (step 10) already claims or wipes on a definitive signed-in session —
  otherwise a second allowlisted user on the same device would read the previous
  user's IndexedDB library before step 16 exists. Decision table **during
  identity-only** (no server library yet):

  | `cook.ownerUid` | rows | action |
  |---|---|---|
  | equals `sub` | any | proceed |
  | set, differs from `sub` | any | wipe Dexie user tables, clear `cook.hasSeeded`, set `ownerUid` to `sub` — **no prompt** |
  | absent | any | **claim**: set `ownerUid` to `sub`, do not wipe |

  Claiming on "absent + rows" is correct here because there is nothing to pull
  and the allowlist is a single person; wiping would destroy the pre-Phase-2
  library. **Once sync exists (step 16)** the "absent + rows" case changes to
  `needsMigration` (export, then wipe, then pull) because a silent claim would
  then push a device library into a possibly already-populated account. Sign-out
  leaves the cache alone so the library still opens offline. A second
  `ALLOWED_EMAILS` entry is not added until step 16's cross-account verify.
- **Identity-only product copy.** Until step 13 writes to Firestore, Settings
  must not say recipes sync to an account, and `/privacy` must not say recipes
  are stored in Google Cloud. Those claims become true at the identity-only
  checkpoint only as *intent*; stating them as fact is a product lie. Step 7
  writes identity-accurate legal pages; step 12 writes identity-accurate
  Settings copy; step 17/19 replace both when storage is real and before
  production deploy.
- **OAuth callback always clears `sous_oauth`.** `getToken` / `verifyIdToken`
  throw. The process-level handler in `scripts/server.ts` would otherwise return
  500 with the transaction cookie still set. The callback catches every
  exchange/verification failure itself and every response — 302, 400, 403, 500
  — includes `Set-Cookie` Max-Age=0 for `sous_oauth`. Missing `code` is 400,
  same as a bad state.
- **`returnTo` is origin-resolved, not prefix-matched.** Accept only after
  rejecting control characters and backslashes, resolving against
  `PUBLIC_ORIGIN`, requiring an identical origin, and requiring a path that
  starts with exactly one `/`. `//evil.example` and `/\evil.example` become
  `/`.
- **`readSession` distinguishes absent vs presented-but-unusable.** HMAC
  failure, expiry, malformation, and allowlist miss are all `unusable` and
  **clear** `sous_session`. No cookie is `absent` and does not send `Set-Cookie`.
  `/api/auth/session` uses this so a revoked email actually drops the cookie
  instead of leaving a zombie that looks signed-out but still 401s chat. Protected
  endpoints may keep using `sessionFrom(req)` as `readSession` → session or
  `null`.
- **Steps 10 and 11 are one implementation pass.** The client must not drop
  `x-app-password` before the server gate exists, and the server must not
  require a cookie while the client still only sends a password. Implement the
  server `sessionSub` first, then the client fetch/session changes, then run
  **one** combined verify. Do not commit or consider either step done until
  both pass that verify.
- **Starting two OAuth flows in two tabs** overwrites the single `sous_oauth`
  cookie. The earlier tab's callback 400s (state mismatch) and the later tab
  wins. Restart from Sign in. No state-keyed cookies in this phase.
- **Sign-out is best-effort on the server.** `signOut()` always
  `invalidateSession()` locally, even when `POST /api/auth/signout` fails or
  the device is offline. The HttpOnly cookie may remain until expiry or the
  next successful sign-out; the UI is signed out. That is accepted.
- **`/privacy` and `/terms` are static HTML, not React routes.** `public/`
  files (`privacy.html`, `terms.html`) copied by Vite into `dist/`, served by
  `scripts/server.ts` for the extensionless paths. Google's reviewer, and any
  crawler, gets a complete document with real text on the first response — an
  SPA shell would give it an empty `<div id="root">`. They are linked with plain
  `<a href>`, never React Router `<Link>`.
- **The service worker must not swallow those paths or `/api/`.**
  `vite.config.ts` gains
  `workbox: { navigateFallbackDenylist: [/^\/api\//, /^\/privacy$/, /^\/terms$/] }`.
  Without it the installed PWA answers a navigation to `/api/auth/start` or
  `/privacy` with `index.html` from cache, and sign-in dead-ends on a blank
  route with no network request to look at.
- **Allowlist, fail closed.** Publishing to Production means any Google account
  on earth can complete the OAuth flow. `ALLOWED_EMAILS` is the only thing
  between the internet and the `GEMINI_API_KEY` bill, so an email that is not on
  the list (or a `email_verified: false` token, or an unset/blank
  `ALLOWED_EMAILS`) gets **403 and no session cookie**, with the attempt logged
  as `sign-in refused: <email>`. Comparison is lowercased and trimmed.
  `scripts/deploy.sh` always writes the variable, so it cannot be forgotten.
- **Redirect flow first; GIS is the documented fallback.** A top-level redirect
  to `accounts.google.com` and back needs no third-party script in the PWA. The
  one place it may genuinely break is an **installed iOS standalone PWA**, where
  an out-of-scope navigation can be handed to a browser view whose cookie jar is
  not the app's. If step 22 finds that, the fallback is Google Identity
  Services' popup returning an `id_token`, POSTed to a new
  `/api/auth/google/id-token` route that verifies it with the *same*
  `OAuth2Client.verifyIdToken` and nonce and issues the same cookie — which also
  requires adding `https://sous.kyrylo.lol` to **Authorized JavaScript
  origins** on the client. Do not build it pre-emptively.
- **Do not touch:** the Dexie database name `cook` or its v1/v2 stores, the
  `cook.theme` / `cook.hasSeeded` / `cook.appPassword` localStorage keys, the
  `app: 'cook'` backup marker or the `cook-backup-` filename, `vercel.json`,
  `package.json`'s `name`, the `0x1E` framing, the Gemini request shape, the
  `maxDuration = 60` exports, the Dockerfile's Node pin, the region, or the
  domain mapping.

## Files to change

**New**

- `server/env.ts` — reads and validates the environment once; explains what is
  missing rather than throwing `undefined`
- `server/session.ts` — sign/verify `sous_session`, cookie serialisation
- `server/allowlist.ts` — parse `ALLOWED_EMAILS`, decide admission
- `server/auth.ts` — `/api/auth/start`, `/api/auth/callback/google`,
  `/api/auth/session`, `/api/auth/signout`
- `server/store.ts` — Firestore client, collection paths, document shapes,
  ownership-scoped reads and writes
- `server/sync.ts` — `GET /api/sync/pull`, `POST /api/sync/push`
- `server/photos.ts` — `POST /api/photos/:id`, `GET /api/photos/:id`
- `server/session.test.ts`, `server/allowlist.test.ts`, `server/sync.test.ts`
  (pure logic only: signing, tamper/expiry, admission, LWW and cursor rules)
- `public/privacy.html`, `public/terms.html`
- `src/lib/session.ts` — client session state (`useSession`), cached profile
- `src/lib/cacheOwner.ts` — IndexedDB ownership claim/wipe for a signed-in `sub`
- `api/sessionGate.test.ts` — vector tests against both duplicated `sessionSub`s
- `src/lib/syncEngine.ts` — outbox drain, pull, apply, ownership rules
- `src/lib/outbox.ts` — op types and enqueue helper used by the stores
- `src/components/AccountGate.tsx` — first-sign-in migration screen
- `src/lib/syncEngine.test.ts` — pure merge/cursor helpers only

**Changed**

- `package.json`, `package-lock.json` — `google-auth-library` in step 4;
  `@google-cloud/firestore` and `@google-cloud/storage` in step 13
- `tsconfig.node.json` — add `server` to `include`
- `Dockerfile` — one line: `COPY server ./server` in the runtime stage. Nothing
  else about the image changes (same Node pin, same stages, same `CMD`)
- `scripts/server.ts` — method-aware route table, prefix routes,
  `/privacy` + `/terms`, mount the `server/` handlers
- `vite.config.ts` — `workbox.navigateFallbackDenylist`
- `api/chat.ts`, `api/import.ts` — inline `sessionSub` replaces the password
  gate; both **export** `sessionSub` so `api/sessionGate.test.ts` can test the
  copies (Vercel still invokes `POST`)
- `src/lib/chatApi.ts`, `src/lib/importApi.ts` — drop the password header, set
  `credentials: 'same-origin'`, 401 copy, call `invalidateSession()` on 401
- `src/lib/settings.ts`, `src/lib/settings.test.ts`, `src/lib/chatApi.test.ts` —
  password accessors and expectations removed
- `src/main.tsx` — session bootstrap, cache ownership, sync engine start
- `src/screens/Settings.tsx` — account section (identity-only copy in step 12;
  sync copy in step 17); legal links
- `src/lib/db.ts` — version 3 with `outbox` + `syncMeta`; boundary comment
  extended to name `syncEngine`
- `src/lib/recipeStore.ts`, `src/lib/chatStore.ts`, `src/lib/useCookState.ts`,
  `src/lib/backup.ts` — enqueue outbox ops, including `photo.put` with
  `recipeId` (not from `photoStore.add`)
- `src/lib/photoStore.ts` — `add(blob)` stays local-only; `ensureLocal` in step 18
- `src/lib/seed.ts` — do not seed when a session exists
- `src/App.tsx` — mount `AccountGate`
- `scripts/deploy.sh` — new env map, sticky `SESSION_SECRET`, `APP_PASSWORD` gone
- `.env.example`, `README.md`
- `public/privacy.html` — storage/retention rewritten in step 19

**Do not change:** `vercel.json`, `.dockerignore`, `.gcloudignore`,
the Dockerfile's Node pin / stages / `CMD`, `.github/workflows/ci.yml`,
`vitest.config.ts`,
`src/lib/types.ts`'s existing fields, `src/lib/image.ts`, `src/lib/quantity.ts`,
`src/lib/recipeShape.ts`, `docs/plans/*` (other than this file), `AUDIT.md`.

## Workback

Read bottom-to-top to execute. Each line is blocked by everything under it.

```
22. Two devices, one library; iOS PWA sign-in; streaming chat; offline read
    └─ 21. Consent screen Branding URLs filled + published In production
        └─ 20. Revision live on sous.kyrylo.lol, session + sync + photos verified
            └─ 19. deploy.sh env map, .env.example, README, privacy rewrite [repo]
                └─ 18. Photos: GCS staged upload + lazy fetch        [repo]
                    └─ 17. Sync status + migration screen            [repo/ui]
                        └─ 16. syncEngine: drain, pull, apply, wipe  [repo]
                            └─ 15. Dexie v3 outbox + stores enqueue  [repo]
                                └─ 14. /api/sync/pull + /api/sync/push [repo]
                                    └─ 13. server/store.ts Firestore layer [repo]
                                        └─ 1. Firestore + bucket + IAM   [operational]
Identity slice (localhost only; do not deploy):
12. Account UI in Settings (identity-only copy)     [repo/ui]
    └─ 10+11. client session AND api session gate, one pass [repo]
        └─ 9. server/auth.ts sign-in routes         [repo]
            ├─ 8. workbox denylist                  [repo]
            ├─ 7. /privacy + /terms (identity-accurate) [repo/ui]
            ├─ 6. server.ts router only             [repo]
            ├─ 5. server/session.ts + tests         [repo]
            └─ 4. google-auth-library + env + tsconfig [repo]
                └─ 3. Web OAuth client + SESSION_SECRET
                    └─ 2. Consent screen (no URLs yet)
```

Steps 2–3 are **operational** (browser or authenticated `gcloud`; no subagent
can do them) and are the start of the **identity slice**. Steps 4–12 are the
identity **repo** work. Step 1 is operational storage prep and is **not** a
prerequisite of sign-in; do it before step 13, not before step 2. Steps 13–19
are storage/sync **repo**. Steps 20–22 are operational again. Do step 1 before
any Firestore code: it is the only one that can surface a hard blocker (a
`(default)` database already in Datastore mode) hours before it matters.

**Identity-only checkpoint (after step 12, before 13).** This is a real,
shippable-to-localhost slice, not a half-done Phase 2. After step 12:

- Sign-in, session cookie, Settings account UI, and session-gated chat/import
  work locally. Recipes, chat, photos and cook progress still live only in
  IndexedDB. There is no Firestore write, no photo bucket traffic, no production
  deploy (step 20 is forbidden until 13–19 land).
- `ALLOWED_EMAILS` stays a **single** address
  (`chernyshov.k@gmail.com`). A second identity is not enabled until step 16's
  cross-account verify. Cache-ownership code still runs (defense in depth).
- Settings and `/privacy`/`/terms` describe **this** checkpoint, not the
  finished sync product. Step 17 updates Settings copy; step 19 rewrites the
  storage/retention sections of the legal pages before any public URL is filled
  in on the consent screen.
- Step 9's `users/{sub}` upsert is a no-op until step 13. Do not invent a
  stub store.

Every `gcloud` invocation below assumes:

```powershell
$gcloud = "C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$P = 'cooking-assistant-508423'
```

`gcloud` is a native executable, so a non-zero exit does **not** stop a
PowerShell session and `$ErrorActionPreference` has no effect on it. Run these
one at a time and check `$LASTEXITCODE` is `0` before moving on.

## Steps

### 1. [core] Firestore database, photo bucket, runtime IAM

**Operational.** Run as `chernyshov.k@gmail.com`.

```powershell
& $gcloud config get account
& $gcloud services enable firestore.googleapis.com storage.googleapis.com --project=$P
& $gcloud firestore databases list --project=$P
```

Read that list **before creating anything**. Then, only if there is no
`(default)`:

```powershell
& $gcloud firestore databases create --location=europe-west1 --type=firestore-native --project=$P
```

Bucket and IAM:

```powershell
& $gcloud storage buckets create gs://sous-photos-cooking-assistant-508423 --location=europe-west1 --uniform-bucket-level-access --public-access-prevention --project=$P

# Whose identity does the running service actually use?
& $gcloud run services describe sous --region=europe-west1 --project=$P --format="value(spec.template.spec.serviceAccountName)"
& $gcloud projects describe $P --format="value(projectNumber)"
```

An **empty** `serviceAccountName` means the default compute service account,
i.e. `<projectNumber>-compute@developer.gserviceaccount.com`. Use whatever those
two commands actually print, not the value in the Names table:

```powershell
$SA = '62867274312-compute@developer.gserviceaccount.com'   # confirm first
& $gcloud projects add-iam-policy-binding $P --member="serviceAccount:$SA" --role="roles/datastore.user" --condition=None
& $gcloud storage buckets add-iam-policy-binding gs://sous-photos-cooking-assistant-508423 --member="serviceAccount:$SA" --role="roles/storage.objectAdmin" --project=$P
```

Local development uses your own credentials, not the service account:

```powershell
& $gcloud auth application-default login
& $gcloud auth application-default set-quota-project $P
```

Failure handling:

- **`(default)` exists in `DATASTORE_MODE`.** This is the one hard blocker here
  and it cannot be converted. Do **not** delete it — something in this project
  may be using it. Create a named database instead and carry
  `FIRESTORE_DATABASE_ID=sous` through every later step:

  ```powershell
  & $gcloud firestore databases create --database=sous --location=europe-west1 --type=firestore-native --project=$P
  ```

  Record which shape landed in the Deploy record at the bottom of this file.
- **`databases create` fails with "already exists"** → fine; `describe` it and
  confirm `type: FIRESTORE_NATIVE` and `locationId: europe-west1`.
- **Location is not `europe-west1`** on an existing database → a Firestore
  location is permanent. Do not try to move it; use it as it is (cross-region
  latency to Cloud Run is tens of milliseconds, not a reason to redesign) and
  note it in the Deploy record.
- **Bucket name taken** (it is a global namespace) → append `-1` and update
  `PHOTO_BUCKET` everywhere in this plan's later steps.
- **`add-iam-policy-binding` denied** → the active account needs
  `roles/resourcemanager.projectIamAdmin` or Owner. The default compute SA often
  already has project Editor, which covers both roles — granting explicitly is
  still correct, because Editor on the default SA is a default that may be
  tightened later.
- **API enablement propagates asynchronously.** A `create` seconds after
  `services enable` can fail as if the API were off. Wait a minute and retry
  once before treating it as permissions.

**Verify:**

After create-or-reuse, set `$DbId` to the id that actually exists (`'(default)'`
or `'sous'`) and write it into the Deploy record. **Every later describe,
client config, and `FIRESTORE_DATABASE_ID` instruction uses `$DbId`, not a
hardcoded `(default)`.**

```powershell
& $gcloud firestore databases describe --database=$DbId --project=$P --format="yaml(name,type,locationId)"
& $gcloud storage buckets describe gs://sous-photos-cooking-assistant-508423 --project=$P --format="yaml(name,location,iamConfiguration)"
& $gcloud projects get-iam-policy $P --flatten="bindings[].members" --filter="bindings.members:$SA" --format="table(bindings.role)"
```

Expect `FIRESTORE_NATIVE` / `europe-west1`; the bucket with
`uniformBucketLevelAccess.enabled: true` and
`publicAccessPrevention: enforced`; and `roles/datastore.user` in the role
table. Nothing here is verified by "the command printed no error" — read the
values.

### 2. [core] Consent screen: Branding, Data Access, Audience

**Operational**, in the browser at
<https://console.cloud.google.com/auth/overview> with project
`cooking-assistant-508423` selected. This is the app's **own** project — do not
add a client to match-cal's project, or users signing in to Sous would see
"match-cal" on the consent dialog.

- **Branding:** App name `Sous`; user support email and developer contact your
  Gmail; **Authorized domains:** `kyrylo.lol`. **Leave Homepage / Privacy /
  Terms blank** — they are filled in step 21, once they resolve over HTTPS.
  **Skip the logo**: uploading one triggers a separate brand review this app
  does not otherwise need.
- **Data Access → Add or remove scopes:** add exactly `openid`,
  `.../auth/userinfo.email`, `.../auth/userinfo.profile`. Save, then **read the
  tier off the page**: all three must appear under *non-sensitive*. Add nothing
  else — no Calendar, no Drive, no Gemini-adjacent scope.
- **Audience:** confirm **External** (a personal Gmail account has no Workspace
  org, so Internal is not offered and the choice is often not even shown).
  **Add `chernyshov.k@gmail.com` as a Test user** on that same Audience page.
  While the app is in Testing, Google will refuse anyone who is not on that
  list — including you — with `access_denied` before our allowlist ever runs.
  **Do not publish yet** — step 21 does that, after the branding URLs are live.

Failure handling:

- **A scope shows as sensitive or restricted** → you added something beyond the
  three above. Remove it. This app needs no API scope, and a sensitive scope
  costs weeks of verification plus a demo video.
- **Authorized domain rejected** → the account in the console is not the
  Search Console verifier of `kyrylo.lol`. Sign in as
  `chernyshov.k@gmail.com`, or add the current account as an owner of the
  Domain property in Search Console. Verification belongs to the **account**,
  not the project.

**Verify:** the Data Access page lists exactly the three identity scopes, all
under non-sensitive; Branding shows app name `Sous` and authorized domain
`kyrylo.lol` with the three URL fields empty; Audience shows **External**,
**Testing**, and `chernyshov.k@gmail.com` under Test users.

### 3. [core] Web OAuth client and the session secret

**Operational.** Console → **Clients → Create client**.

- **Application type: Web application** (not Desktop — a Desktop client cannot
  serve a web callback).
- **Name:** `sous-web`.
- **Authorized JavaScript origins:** leave **empty**. The server-side code flow
  does not use them. (They are only needed if step 22 forces the GIS fallback.)
- **Authorized redirect URIs**, exactly these two, no trailing slash:

  ```
  https://sous.kyrylo.lol/api/auth/callback/google
  http://localhost:5173/api/auth/callback/google
  ```

  The local one is port **5173**, not 3001: the browser only ever talks to Vite,
  which proxies `/api` to 3001 (`vite.config.ts`). Google must be told the
  origin the browser will actually be redirected back to. Do **not** add the
  `run.app` URL — the domain is already live, so there is nothing to test
  pre-DNS.

Then, in PowerShell, capture the credentials and mint the session secret. Use
`Read-Host` so the values never reach `ConsoleHost_history.txt`:

```powershell
$env:AUTH_GOOGLE_ID = Read-Host 'Client ID'
$env:AUTH_GOOGLE_SECRET = Read-Host 'Client secret'
$b = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$env:SESSION_SECRET = [Convert]::ToBase64String($b)
$env:SESSION_SECRET   # copy this into the password manager NOW
```

**`SESSION_SECRET` must be saved in the password manager before you close that
window.** It is not derivable from anything, and changing it later signs every
device out. Put the client id and secret there too.

Write `.env.local` for development (it is gitignored; step 19 updates
`.env.example` to match):

```
GEMINI_API_KEY=…
AUTH_GOOGLE_ID=…
AUTH_GOOGLE_SECRET=…
SESSION_SECRET=…
ALLOWED_EMAILS=chernyshov.k@gmail.com
PUBLIC_ORIGIN=http://localhost:5173
GOOGLE_CLOUD_PROJECT=cooking-assistant-508423
# FIRESTORE_DATABASE_ID=sous   # only if step 1 created a named database
PHOTO_BUCKET=sous-photos-cooking-assistant-508423
```

Note that `APP_PASSWORD` is **not** in that list, and that local development
therefore reads and writes the **real** Firestore database and the **real**
bucket under your real `sub`. That is deliberate for a single-user app — it
means "does sync work" can be answered without a second environment. The
documented opt-out is the Firestore emulator
(`FIRESTORE_EMULATOR_HOST=localhost:8080`, honoured by
`@google-cloud/firestore`); leaving `PHOTO_BUCKET` unset turns photo sync off
locally without breaking anything else.

Failure handling:

- **You navigated away without copying the secret** → the client secret can be
  reset from the client's page (old value stops working), and a new
  `SESSION_SECRET` can be generated at the cost of signing everyone out. Both
  are recoverable; neither is free.
- **Only one redirect URI saved** → sign-in works in exactly one environment and
  fails in the other with `redirect_uri_mismatch`. Re-open the client and add
  the missing one; edits take effect in seconds to minutes.

**Verify:** the client page lists both redirect URIs character-for-character as
above (no trailing slash, `http` for localhost, `https` for production); the
password manager holds three new entries; `.env.local` exists and
`node --env-file=.env.local -e "for (const k of ['AUTH_GOOGLE_ID','AUTH_GOOGLE_SECRET','SESSION_SECRET','ALLOWED_EMAILS','PUBLIC_ORIGIN','GOOGLE_CLOUD_PROJECT']) console.log(k, Boolean(process.env[k]))"`
prints `true` six times.

### 4. [core] Dependencies, the `server/` directory, the env module

**Repo.** Files: `package.json`, `package-lock.json`, `tsconfig.node.json`,
`Dockerfile`, `server/env.ts` (new). **Identity slice: install only the auth
library.** Firestore and Storage clients wait until step 13 — they are unused
until then and must not be a reason to block sign-in.

```powershell
npm install google-auth-library
```

It is a **runtime** dependency (the runtime image installs with
`npm ci --omit=dev`). It is imported only from `server/`, so no Vercel
function bundle grows and no byte of it reaches the browser bundle — assert
that in the verify block rather than assuming it.

`tsconfig.node.json`: add `"server"` to `include` (it already has `scripts` and
sets `allowImportingTsExtensions`, `erasableSyntaxOnly`, `strict`,
`noUnusedLocals`). No new tsconfig project.

`Dockerfile`: add `COPY server ./server` to the **runtime** stage, beside the
existing `COPY api ./api` and `COPY scripts ./scripts`. The image currently
copies only `node_modules`, `dist`, `api`, `scripts` and `package.json`, so
without this line every route added by this plan dies at startup with
`Cannot find module '../server/…'` — and it will not show up until step 20,
because local runs read the source tree directly. Nothing else in the image
changes.

`server/env.ts` exports one function that reads `process.env` **once per call
site at startup**, not lazily scattered:

- `publicOrigin()` — `PUBLIC_ORIGIN`, trailing slash trimmed; throws a named
  error if unset. `redirectUri()` = `${publicOrigin()}/api/auth/callback/google`.
- `googleClient()` — `{ id, secret }`; throws if either is missing.
- `sessionSecret()` — returns `string | null`. **Null must be a 401, never a
  crash and never a bypass.**
- `allowedEmails()` — the raw string, or `''`.
- `firestoreConfig()` — `{ projectId, databaseId? }` from
  `GOOGLE_CLOUD_PROJECT` / `FIRESTORE_DATABASE_ID`.
- `photoBucket()` — `string | null`; null means photo sync is off, which is a
  documented degradation, not an error.
- `isSecureOrigin()` — whether `publicOrigin()` is `https:`, which decides the
  cookie `Secure` attribute.

Every throw names the variable and what sets it ("set `PUBLIC_ORIGIN` in
`.env.local` for dev, or via `scripts/deploy.sh` on Cloud Run"). A Cloud Run
container that starts and then 500s on every request with `undefined` is the
failure mode this module exists to prevent.

Failure handling:

- **`tsc -b` fails on the new project member** with `Request`/`ReadableStream`
  unresolved → `tsconfig.node.json` sets `lib: ["ES2023"]` and no `types`, which
  means all of `node_modules/@types` (including `@types/node`) is included and
  the DOM-ish globals come from there. If a global is genuinely missing, add
  `"types": ["node"]` to that project rather than widening `lib`.
- **`erasableSyntaxOnly` errors** in the new files (enum, namespace,
  constructor parameter property) → rewrite them as plain
  `const`/`type`/assignment. Node strips types, it does not compile, so this
  guard is the only thing standing between a non-erasable construct and a
  container that dies at startup.

**Verify:** `npm run build` and `npm test` clean.
`Select-String -Path Dockerfile -Pattern 'COPY server'` prints the new line.
`node -e "const p=require('./package.json'); console.log('google-auth-library', p.dependencies['google-auth-library']??'MISSING')"`
prints a version. `Select-String -Path (Get-ChildItem dist/assets/*.js) -Pattern 'google-auth-library'`
after a build prints **nothing** (no server SDK in the client bundle). `git diff
--stat` touches `package.json`, `package-lock.json`, `tsconfig.node.json`,
`Dockerfile`, and `server/env.ts`.

### 5. [core] `server/session.ts` — sign and verify `sous_session`

**Repo.** Files: `server/session.ts`, `server/session.test.ts`,
`server/allowlist.ts`, `server/allowlist.test.ts` (new).

`server/session.ts`, using only `node:crypto`:

- `signSession({ sub, email }, now)` → `payload.signature`, where `payload` is
  `base64url(JSON.stringify({ v: 1, sub, email, iat, exp }))`, `exp = iat + 90d`,
  and `signature` is `base64url(HMAC-SHA256(payload, SESSION_SECRET))`.
- `verifySession(token, now)` → `{ sub, email, iat, exp } | null`. Returns
  `null` — never throws — for: a missing or non-string token; a token without
  exactly one `.`; a signature of the wrong length; a signature mismatch
  (compare with `crypto.timingSafeEqual` over equal-length buffers only);
  malformed base64 or JSON; `v !== 1`; a missing `sub`; `exp <= now`.
- `readCookie(req, name)` → parse the `Cookie` header, handling multiple
  cookies, surrounding spaces, and a missing header.
- `sessionCookie(token, { secure })` and `clearedSessionCookie({ secure })` →
  `Set-Cookie` strings. `HttpOnly; Path=/; SameSite=Lax; Max-Age=7776000` plus
  `Secure` when `secure`. The cleared form is `Max-Age=0` with an empty value.
- `sessionFrom(req)` → convenience: if `readSession(req)` is `{ status: 'ok',
  session }` return `session`, else `null`. Protected handlers (sync, photos)
  that only need 401-or-proceed use this.
- `readSession(req)` →
  `{ status: 'ok', session } | { status: 'absent' } | { status: 'unusable' }`.
  **absent**: no `sous_session` cookie. **unusable**: a cookie was presented
  and HMAC failed, the token was expired/malformed/`v !== 1`,
  `sessionSecret()` is null, **or** HMAC succeeded but `isAllowed` is false.
  **ok**: HMAC and allowlist both passed. Never throws.
  `/api/auth/session` **clears** `sous_session` on `unusable` and does **not**
  send `Set-Cookie` on `absent`. This is how removing an email from
  `ALLOWED_EMAILS` drops the browser cookie on the next session probe instead
  of leaving a zombie cookie that looks signed-out.
- `shouldRefresh(session, now)` → true when `now - iat > 24h`, so an active
  device's 90-day window keeps sliding.
- `safeReturnTo(raw, publicOrigin)` — the origin-resolved `returnTo` helper
  specified in step 9. Exported from this file so step 9 does not grow a
  second URL parser.

`server/allowlist.ts`:

- `parseAllowedEmails(raw)` → lowercased, trimmed, empties dropped, as a `Set`.
- `isAllowed(email, emailVerified, raw)` → `false` when `raw` is blank, when
  `emailVerified` is not `true`, when `email` is missing, or when the lowercased
  email is not in the set. There is **no** "empty list means allow all" branch,
  and the tests assert that explicitly.

Tests (node environment, no DOM needed — set `process.env.SESSION_SECRET`
inside the test file):

- round-trip: sign then verify returns the same `sub` and `email`;
- a flipped character in the payload ⇒ `null`;
- a flipped character in the signature ⇒ `null`;
- a signature from a *different* secret ⇒ `null`;
- `exp` in the past ⇒ `null`; `v: 2` ⇒ `null`; `''`, `'a'`, `'a.b.c'` ⇒ `null`;
- `sessionSecret()` unset ⇒ `readSession` is `unusable` if a cookie is present,
  `absent` if not; `sessionFrom` is `null` even for a token that would
  otherwise verify;
- `readSession`: missing header → `absent`; garbage/expired/allowlist-miss
  cookie → `unusable`; valid allowlisted cookie → `ok`;
- cookie header parsing: absent header, single cookie, three cookies with
  spaces, a cookie whose value contains `=`;
- `sessionCookie` includes `Secure` only when asked, and always `HttpOnly`,
  `SameSite=Lax`, `Path=/`;
- `safeReturnTo`: `/settings` kept; `//evil.example`, `/\evil.example`,
  `/%5Cevil.example`, `/%5cevil.example`, `https://evil.example/`, a
  backslash, and a string containing `\n` all become `/`;
- allowlist: blank ⇒ deny; case and whitespace insensitivity; unverified email
  ⇒ deny; an email not on the list ⇒ deny.

Failure handling: if `timingSafeEqual` throws on length mismatch, that is the
point — compare lengths first and return `null`, do not `try/catch` around a
comparison and fall through to success.

**Verify:** `npm test` shows the new suites passing and `npm run build` is
clean. Then prove the verifier rejects a forgery from outside the test harness:

```powershell
node --env-file=.env.local --input-type=module -e "import {signSession, verifySession} from './server/session.ts'; const t=signSession({sub:'123',email:'a@b.c'},Date.now()); console.log('ok', Boolean(verifySession(t,Date.now()))); const [p,s]=t.split('.'); console.log('tampered', verifySession(p+'x.'+s,Date.now())); console.log('expired', verifySession(t, Date.now()+100*24*3600*1000));"
```

Expect `ok true`, `tampered null`, `expired null`.

### 6. [core] `scripts/server.ts`: method-aware routes, prefix routes, legal pages

**Repo.** Files: `scripts/server.ts`.

Today's table is `Record<pathname, POST handler>` and `handleApi` 405s anything
that is not POST. It needs to carry GET routes, one dynamic segment, and two
extensionless static documents — without disturbing the streaming path.

- **Route table becomes method-aware**: entries keyed by `` `${method} ${path}` ``
  or a `{ method, path, handler }` list. `POST /api/chat` and `POST /api/import`
  keep pointing at the untouched `api/` handlers.
- **Prefix matcher** for one dynamic segment (`"/api/photos/"` plus a single
  remaining segment with no `/`). Implement the matcher now so later mounts
  are one-liners. Until step 18 mounts a handler, `/api/photos/:id` is still
  unknown `/api/*` ⇒ **404**.
- **Do not mount auth, sync, or photo handlers in this step.** Those modules
  do not exist yet (steps 9, 14, 18). This step only changes the router.
- **`/privacy` and `/terms` mapping only:** for GET/HEAD, map the extensionless
  path to `dist/privacy.html` / `dist/terms.html` through the **existing**
  `resolveContained` + `sendFile` path, with `Cache-Control: no-cache`,
  **before** the SPA fallback. Until step 7 writes the HTML, both paths 404 —
  that is expected. Do not invent a second file-serving path.
- **Do not touch** the streaming behaviour: handler `Response` headers copied
  minus `content-length`, `flushHeaders()` before the first byte,
  `pipeline(Readable.fromWeb(...), nodeRes)`, no compression, no
  `arrayBuffer()`. Auth adds a 401 *before* the stream starts, which is the
  existing pre-response 500/401 path, so nothing about framing changes.
- Multiple `Set-Cookie` headers must survive. `response.headers.forEach` folds
  repeated `Set-Cookie` values into one comma-joined string, which browsers
  mis-parse. Read them with `response.headers.getSetCookie()` and set them as an
  **array** via `nodeRes.setHeader('Set-Cookie', [...])`, skipping `set-cookie`
  in the general header copy. The callback sets two cookies (clear `sous_oauth`,
  set `sous_session`), so this is load-bearing, not hypothetical.
- Keep `staticRoot: null` (dev) behaving as today: API routes work, everything
  else 404s. `/privacy` in dev therefore 404s on :3001 and is served by Vite
  from `public/` on :5173 — note it in the doc comment so nobody "fixes" it.

Failure handling:

- **A 405 where a 404 belongs (or vice versa)** → keep today's contract: unknown
  `/api/*` path ⇒ 404; known path, wrong method ⇒ 405.
- **`/privacy` returns the SPA shell** → the legal-page branch is running after
  the fallback. Move it before.
- **Cookies arrive doubled or ignored** → the `getSetCookie()` array path above
  is missing.

**Verify:** `npm run build` clean, then with a real `.env.local`:

```powershell
npm run build
$env:PORT='8080'; node --env-file=.env.local scripts/server.ts
```

In a second terminal:

```powershell
node -e "for (const p of ['/','/settings','/privacy','/terms','/api/nope','/api/photos/x','/api/photos/','/api/photos/a/b','/assets/nope.js']) fetch('http://127.0.0.1:8080'+p).then(r=>console.log(p, r.status, r.headers.get('content-type')))"
node -e "fetch('http://127.0.0.1:8080/privacy').then(async r=>{const t=await r.text(); console.log('privacy', r.status, t.includes('id=\"root\"'))})"
node -e "fetch('http://127.0.0.1:8080/api/chat',{method:'GET'}).then(r=>console.log('GET chat',r.status))"
node -e "fetch('http://127.0.0.1:8080/api/auth/session').then(r=>console.log('unmounted session',r.status))"
```

Expect `/` and `/settings` → 200 SPA; `/privacy` and `/terms` → **404** (files
are written in step 7) and **not** the SPA shell (`id="root"` absent — a 404
body is fine, serving `index.html` is not); `/api/nope`, `/api/photos/x`,
`/api/photos/`, `/api/photos/a/b` → 404; `/assets/nope.js` → 404;
`GET /api/chat` → 405; `GET /api/auth/session` → 404 (handler not mounted yet).
Re-run the **path-traversal probe block from `docs/plans/sous-subdomain.md`
step 2** unchanged — containment must not have regressed.

### 7. [ui] `/privacy` and `/terms`, written for this app

**Repo.** Files: `public/privacy.html`, `public/terms.html` (new).

Two self-contained HTML documents. They are the first thing a Google reviewer
reads and the only legal text this app has, so they are hand-written about what
Sous actually does — not a template.

Shape of each file: `<!doctype html>`, `<html lang="en">`, a `<title>`
(`Privacy — Sous` / `Terms — Sous`), `<meta name="viewport">`, a **small inline
`<style>`** block (a readable max-width column, system font stack, generous line
height, and colours that work in a light *and* dark browser context — these
pages cannot use the app's Tailwind build, which is hashed and code-split, and
must not depend on it), a `<h1>`, the sections below, and a footer link back to
`https://sous.kyrylo.lol` plus a link to the sibling document. Plain `<a href>`
only. No script, no external font, no analytics, no image.

**`privacy.html`** — accurate to the **identity-only checkpoint**. Step 19
rewrites the storage and retention sections once Firestore/GCS exist, using
the Deploy record's region, **before** any production deploy or consent-screen
URL is filled in. Do not write the Phase 2 end-state as if it were already
true.

- *Last updated* date.
- **What is stored:** a signed session cookie holding your Google account id
  (`sub`), email address, and (when Google sends it) display name. The cookie
  is HttpOnly and is not readable by page scripts. **Recipes, chat messages,
  cooking progress and photos stay in this browser's storage (IndexedDB) on
  each device.** They are not uploaded to a Sous server in this slice. **No
  password and no Google refresh token is stored**, because the app only ever
  asks Google who you are.
- **What it is used for:** knowing which Google account is signed in, so chat
  and recipe import can run as you, and so a later release can attach a
  per-account library. Not sold, not shared, not used for advertising or
  profiling.
- **What it can reach in your Google account:** the sign-in scopes `openid`,
  `userinfo.email`, `userinfo.profile` — your name, email and account id, and
  nothing else. The app **cannot** read your Gmail, Drive, Calendar, contacts or
  photos.
- **Third parties:** recipe text, your chat messages and any photo you send the
  assistant are passed to **Google's Gemini API** at request time to produce a
  reply; recipe import fetches the URL you paste. Hosting is Google Cloud.
  Nothing else.
- **Retention and deletion:** sign out to drop the session cookie. Clearing
  this site's browser data deletes the on-device library. You can also revoke
  the app's access at any time from your Google account permissions page. There
  is no in-app "delete my account" button in this slice because there is no
  server-side library yet.
- **Access:** the app is invitation-only — only allow-listed email addresses can
  sign in.
- **Contact:** chernyshov.k@gmail.com for questions.

**`terms.html`**:

- What Sous is: a personal recipe book with an AI cooking assistant, free,
  invitation-only, with no availability guarantee. In this slice the recipe
  library is stored on the device you are using.
- **Accuracy limits:** the assistant and the importer are AI and can be wrong,
  including about cooking times, substitutions, quantities and food safety. Use
  your own judgement; check anything that matters.
- Acceptable use: your own recipes and normal personal use; do not try to break
  it or use it to generate abuse.
- Ending it: sign out or revoke access at any time; the service may change or
  stop.
- Liability: provided "as is", no warranty.

Read both over before step 21 — they are yours to sign off, and a draft is not
legal advice.

**Verify:** `npm run build` puts `privacy.html` and `terms.html` in `dist/`
(`Get-ChildItem dist/*.html`). With the server from step 6 running,
`http://127.0.0.1:8080/privacy` and `/terms` now return **200** `text/html`
with a real `<h1>` and **no** `id="root"` (this is the check that was
deliberately *not* in step 6). They render as readable documents in a browser
at phone width **and** desktop width, both with `prefers-color-scheme` forced
dark and light (DevTools → Rendering). `curl.exe -s http://127.0.0.1:8080/privacy`
contains the actual section headings — the text must be in the first response
body, not injected by script. Every internal link resolves (no `/privacy.html`
vs `/privacy` mismatch, no `<Link>`, no relative path that breaks at
`/privacy`).

### 8. [core] Keep the service worker out of `/api/` and the legal pages

**Repo.** Files: `vite.config.ts`.

Add to the `VitePWA({...})` options:

```ts
workbox: {
  navigateFallbackDenylist: [/^\/api\//, /^\/privacy$/, /^\/terms$/],
},
```

Nothing else in the PWA config changes: `registerType: 'autoUpdate'`, the
manifest `name`/`short_name` `Sous`, `start_url`, the two icons and both colours
stay exactly as they are.

Why this is its own step: vite-plugin-pwa's generated service worker registers
an `index.html` navigate fallback. Inside the installed PWA, a top-level
navigation to `/api/auth/start` or `/privacy` would then be answered from the
precache with the SPA shell — sign-in would appear to do nothing, with **no
network request in the log to explain it**, and `/privacy` would show a blank
route. This is the single most likely way to lose an afternoon in this phase.

Failure handling: if the built `sw.js` does not contain the denylist, the option
is in the wrong place (it belongs under `workbox`, not at the top level of the
plugin options, and not under `manifest`).

**Verify:** `npm run build`. Then a **functional** check, not a string search
in minified `sw.js`: serve `dist/` with the step-6 server and, in a browser
with the generated service worker registered,

```powershell
# After npm run build + node scripts/server.ts on 8080:
# DevTools → Application → Service Workers should show sw.js controlling.
# Navigate to /privacy (full URL) — Network: document request is network, 404
# until step 7, then 200 HTML, never a cached index.html.
# Navigate to /api/auth/session — Network: the XHR/document hits the server
# (404 until step 9), never index.html.
```

`Select-String` on `dist/sw.js` for `denylist` is **not** authoritative
(minifiers drop the identifier). The installed-PWA check in step 20 is the
real one: tapping Sign in produces a network request to `/api/auth/start`.

### 9. [core] `server/auth.ts` — the Google sign-in routes

**Repo.** Files: `server/auth.ts` (new), `scripts/server.ts` (**mount the four
handlers here** — they were not mounted in step 6).

Construct **one** `OAuth2Client` with
`new OAuth2Client(AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, redirectUri)` where
`redirectUri` is `${PUBLIC_ORIGIN}/api/auth/callback/google` with no trailing
slash. Do not call `generateAuthUrl` / `getToken` on a client that was
constructed without the redirect URI.

The `sous_oauth` cookie is **not** a session. Define
`signOauthTx({ state, nonce, verifier, returnTo }, now)` /
`verifyOauthTx(token, now)` in `server/session.ts`: same HMAC framing as
`signSession`, payload `{ v: 'oauth', state, nonce, verifier, returnTo, iat,
exp }` with `exp = iat + 10min`. Do not reuse `signSession`'s `{ v:1, sub,
email }` shape.

Four handlers, all web-standard `(req: Request) => Promise<Response>`:

**`GET /api/auth/start`**
- Build `state` (32 random bytes, base64url), `nonce` (same), and a PKCE
  `code_verifier` + S256 `code_challenge`.
- Store `{ state, nonce, verifier, returnTo }` in the **`sous_oauth` cookie**,
  signed with the same HMAC helper as the session (reuse `signSession`'s
  primitives, not a second crypto implementation), `HttpOnly`, `SameSite=Lax`,
  `Path=/`, `Max-Age=600`, `Secure` per origin. `SameSite=Lax` is required and
  sufficient: the callback is a **top-level GET navigation**, which Lax allows.
  Never `SameSite=None`.
- `returnTo` comes from `?returnTo=`. Run it through `safeReturnTo(raw,
  publicOrigin())` **exported from `server/session.ts` and unit-tested**:
  1. missing/empty → `/`;
  2. if it contains a C0 control, DEL, a backslash (`\`), or the substring
     `%5c` / `%5C` (percent-encoded backslash, any case) → `/`;
  3. if it does not start with `/` or starts with `//` → `/`;
  4. `new URL(raw, publicOrigin())` — catch → `/`;
  5. resolved origin must equal `new URL(publicOrigin()).origin`;
  6. resolved pathname must start with exactly one `/` (reject `//`).
  Return `pathname + search` (no hash). Tests must include `/settings`,
  `//evil.example`, `/\evil.example`, `https://evil.example/`,
  `/%5Cevil.example`, and a newline-prefixed value — all but the first become
  `/`. A prefix check alone is not enough: browsers normalise `/\evil` into a
  scheme-relative URL.
- Redirect (302) to `OAuth2Client.generateAuthUrl({ scope: [openid, email,
  profile], state, nonce, code_challenge, code_challenge_method: 'S256',
  include_granted_scopes: false })`. **No `access_type: 'offline'`, no
  `prompt: 'consent'`** — see Decisions.

**`GET /api/auth/callback/google`**

Structure the handler so **every** `Response` is built in one place that
always attaches a cleared `sous_oauth` cookie. `getToken` and `verifyIdToken`
throw; if that throw reaches `scripts/server.ts`'s generic catcher the client
gets a 500 **and keeps** the transaction cookie. That is a replay window.

```
async function callback(req: Request): Promise<Response> {
  const clearOauth = clearedOauthCookie({ secure: isSecureOrigin() });
  const respond = (res: Response) => {
    res.headers.append('Set-Cookie', clearOauth);
    return res;
  };
  try {
    // ... outcomes below, each `return respond(...)`
  } catch {
    return respond(new Response('Sign-in failed', { status: 400 }));
  }
}
```

Outcomes, all via `respond`:

- Read `sous_oauth`. Missing, bad HMAC, or expired → 400 plain text, no
  session cookie.
- If `?error=` is present (user pressed Cancel) → 302
  `/settings?signin=cancelled`. Not a 500.
- Compare `state` from the query with the cookie's **constant-time**. Mismatch
  or missing → 400 plain text, no session cookie.
- Missing `code` query param → 400 plain text, no session cookie. Do not call
  `getToken` without a code.
- `getToken({ code, codeVerifier })`, then
  `verifyIdToken({ idToken, audience: AUTH_GOOGLE_ID })`. Require
  `payload.nonce === cookie.nonce`, a non-empty `sub`, and
  `email_verified === true`. Any throw, missing id token, or failed check →
  400 plain text, no session cookie.
- `isAllowed(email, email_verified, ALLOWED_EMAILS)` ⇒ if false, log
  `sign-in refused: <email>` and return **403** with a short HTML body that says
  the app is invitation-only and links `/privacy`. **No session cookie.**
- Upsert `users/{sub}` (`email`, `name`, `createdAt` on first write,
  `lastSeenAt` always) — merge, never overwrite. (Before step 13 lands this is a
  no-op TODO; wire it when `server/store.ts` exists. Do not throw if the store
  is absent.)
- 302 to the cookie's `returnTo` (already validated at start), with a second
  `Set-Cookie`: a fresh `sous_session`. `respond` still clears `sous_oauth`.

**`GET /api/auth/session`**
- `readSession(req)`. 200, `Cache-Control: no-store`, never 401:
  - `absent` → `{ user: null }`, **no** `Set-Cookie`;
  - `unusable` → `{ user: null }`, **cleared** `sous_session` (covers both
    HMAC failure and allowlist revocation);
  - `ok` → `{ user: { sub, email, name? } }`, and when `shouldRefresh`, a
    re-issued `sous_session`.
  "Not signed in" is a normal answer this endpoint must give offline-tolerant
  clients. `name` is optional; identity-only has no user profile store, so omit
  it until step 13's upsert is wired.

**`POST /api/auth/signout`**
- 204 with a cleared `sous_session`. No CSRF token needed given
  `SameSite=Lax` + `POST` + no cross-origin credentialed access, and the worst
  a forged sign-out achieves is signing the user out.

Everything logs at most `sub` and `email` — **never** a token, a code, a
verifier or a cookie value.

Failure handling:

- **`redirect_uri_mismatch`** → `PUBLIC_ORIGIN` does not match the console
  entry. Print the computed redirect URI in the startup log once and compare
  character by character (scheme, port, no trailing slash).
- **`invalid_grant`** on `getToken` → a re-used or expired code (often a
  refreshed callback URL). Start again from `/api/auth/start`.
- **`Nonce mismatch`** → the `sous_oauth` cookie did not come back; on localhost
  that is usually `Secure` set on an `http` origin. Check `isSecureOrigin()`.
- **`access_denied`** → the scope is missing from Data Access, or the app is
  still in Testing and the account is not a test user. Add yourself as a test
  user for local work, or finish step 21.
- **403 for your own email** → `ALLOWED_EMAILS` is unset or misspelled. It is
  fail-closed by design; fix the variable, do not add a bypass.

**Verify:** local end-to-end, which is the real test of this step.

```powershell
npm run dev        # terminal 1, Vite on 5173
npm run dev:api    # terminal 2, API on 3001
```

Browse to `http://localhost:5173/api/auth/start`. Expect: Google's consent
screen showing **Sous** and only "name, email address, profile"; then a redirect
back to `http://localhost:5173/`; then
`http://localhost:5173/api/auth/session` returns your `sub` and email. In
DevTools → Application → Cookies: `sous_session` present, `HttpOnly` ✓,
`SameSite=Lax`, `Secure` **unchecked** (http origin), and `sous_oauth`
**gone**. Then:

- tamper with one character of `sous_session` in DevTools ⇒ `/api/auth/session`
  returns `{"user":null}` **and** a `Set-Cookie` that clears `sous_session`;
- delete the cookie entirely ⇒ `/api/auth/session` returns `{"user":null}` with
  **no** `Set-Cookie`;
- `POST /api/auth/signout` (`node -e "fetch('http://localhost:5173/api/auth/signout',{method:'POST'}).then(r=>console.log(r.status))"`)
  ⇒ 204 and the cookie is gone;
- temporarily set `ALLOWED_EMAILS=nobody@example.com` in `.env.local`, restart
  `dev:api`, sign in again ⇒ **403**, no session cookie, oauth cookie cleared,
  and the server log line `sign-in refused: …`. Put your email back.
- hand-edit the `state` in the callback URL and replay it ⇒ 400, no session
  cookie, oauth cookie cleared.
- replay a callback URL with `code` removed ⇒ 400, oauth cookie cleared.
- `node --env-file=.env.local --input-type=module -e "import {safeReturnTo} from './server/session.ts'; const o='http://localhost:5173'; for (const v of ['/settings','//evil.example','/\\\\evil.example','https://evil.example/']) console.log(JSON.stringify(v), safeReturnTo(v,o))"`
  prints `/settings` for the first and `/` for the rest.

### 10. [core] Client session state and the fetch layer

**Atomic with step 11.** Implement step 11's server `sessionSub` **first** in
this same pass, then the client changes in this step, then run the combined
verify at the end of step 11. Do not consider this step done, and do not run
its chat/import verify, until the server gate is in place.

**Repo.** Files: `src/lib/session.ts` (new), `src/lib/cacheOwner.ts` (new),
`src/lib/chatApi.ts`, `src/lib/importApi.ts`, `src/lib/settings.ts`,
`src/lib/settings.test.ts`, `src/lib/chatApi.test.ts`, `src/main.tsx`.

`src/lib/session.ts`:

- `type SessionUser = { sub: string; email: string; name?: string }`.
- `invalidateSession()` — **the one shared path**: delete
  `localStorage['cook.session']`, set module cache to signed-out. Does **not**
  touch the Dexie outbox (unsynced edits survive a 401; they drain after the
  next sign-in). `signOut()`, a `{ user: null }` session response, and a 401
  from chat/import/sync all call this.
- `fetchSession()` → `GET /api/auth/session` with
  `credentials: 'same-origin'` and `cache: 'no-store'`. Outcomes:
  - **200** `{ user: { sub, email, name? } }` → cache in
    `localStorage['cook.session']` (a **new** key) and return it.
  - **200** `{ user: null }` → `invalidateSession()`, return null.
    Authoritative "not signed in".
  - **401 / 403** → `invalidateSession()`, return null.
  - **5xx or network failure** → return the **cached** value tagged
    `offline: true` if any; otherwise `{ user: null, offline: true }` **without**
    clearing `cook.session`. Never block rendering. Never seed from this
    branch (see Decisions).
- `signInHref(returnTo)` → `/api/auth/start?returnTo=…`. Sign-in is a
  **full-page navigation** (`<a href>` or `location.assign`), never `fetch`.
- `signOut()` → `POST /api/auth/signout` (ignore network / non-2xx), then
  **always** `invalidateSession()`, then resolve. Offline sign-out must still
  clear the UI; the HttpOnly cookie may remain until expiry.
- `useSession()` → `{ user, status: 'loading' | 'signedIn' | 'signedOut' | 'offline', refresh() }`,
  backed by a module-level cache so several components do not each fire a
  request. Re-check on `visibilitychange` → visible and on `online`.

`src/lib/cacheOwner.ts` — identity-slice ownership. Export
`applyCacheOwnership(sub: string): Promise<void>` implementing the
identity-only decision table in Decisions (equals → noop; differs → wipe Dexie
user tables `recipes`/`chatMessages`/`photos`/`cookState`, remove
`cook.hasSeeded`, set `cook.ownerUid`; absent → set `cook.ownerUid`, no wipe).
Keep `cook.theme`. Do **not** call this on a cached/offline session — only
after a definitive signed-in `200` with a `user`. Unit-test the decision
function (pure: `(ownerUid, sub) => 'proceed' | 'wipe' | 'claim'`) without
Dexie.

`src/lib/chatApi.ts` and `src/lib/importApi.ts`:

- delete the `'x-app-password'` header and the `settings` import;
- add `credentials: 'same-origin'` explicitly. (It is already the fetch default
  for same-origin requests; being explicit is what keeps a future absolute URL
  or a reviewer from having to reason about it.)
- 401: call `invalidateSession()`, then throw exactly
  **`'Please sign in again — your session expired.'`** in both files. Specified
  here so the implementer makes no copy decision. A 401 that does not invalidate
  leaves the UI looking signed-in while every chat fails.
- Nothing else changes: the `0x1E` split, the `onDelta` contract, the
  `truncated` flag, the proposal normalisation and the 500 message are all
  untouched.

`src/lib/settings.ts`: remove `PASSWORD_KEY`, `getPassword`, `setPassword`. Keep
`THEME_KEY`, `getTheme`, `setTheme` exactly as they are. The stale
`cook.appPassword` entry on existing devices is left in place.

Tests: drop the password expectations from `settings.test.ts`; in
`chatApi.test.ts` change the 401 assertion to the new string, assert
`invalidateSession` was called (spy the session module), and drop the
`globalThis.localStorage` stub **only if** nothing else in that file needs it
(`streamChatReply` no longer reads localStorage, so it should go — leaving a
stub for a dependency that no longer exists is how a test stops testing what it
claims to).

`src/main.tsx`: render immediately. Kick off `fetchSession()` without awaiting
it for **UI**. **Do not** call `seedIfEmpty()` here in parallel. After
`fetchSession()` settles: if the result is a definitive signed-in user, call
`applyCacheOwnership(user.sub)` before anything else that reads Dexie; if the
result is a definitive signed-out `200` + `{ user: null }` and `cook.ownerUid`
is unset, then `seedIfEmpty()`; otherwise skip. Step 16 starts the sync engine
after a signed-in result.

Failure handling:

- **401 loop** (every chat attempt 401s while `/api/auth/session` says signed
  in) → the cookie is not being sent: check `credentials`, that the request is
  same-origin/relative, and that no service worker is rewriting it (step 8).
- **`noUnusedLocals` fails** after removing the `settings` import → delete the
  import, do not underscore-prefix it.

**Verify (with step 11, not alone):** `npm run build` and `npm test` clean.
`Select-String -Path src -Pattern 'x-app-password|getPassword|setPassword' -Recurse`
returns **nothing**. Chat/import and streaming checks live at the end of step
11. Ownership: with a populated library, set `localStorage['cook.ownerUid']`
to a fake sub, reload signed in as yourself → library is empty (wiped); restore
from backup. With `cook.ownerUid` absent and rows present, sign in → rows
remain and `cook.ownerUid` equals your `sub`.

### 11. [core] Session gate inside `api/chat.ts` and `api/import.ts`

**Atomic with step 10.** Land the server gate in this step *before* the client
stops sending `x-app-password`. Combined verify is at the bottom of this step.

**Repo.** Files: `api/chat.ts`, `api/import.ts`, `api/sessionGate.test.ts` (new).

In each file, replace the `APP_PASSWORD` block:

```ts
if (!process.env.APP_PASSWORD || req.headers.get('x-app-password') !== process.env.APP_PASSWORD) {
  return new Response('Unauthorized', { status: 401 });
}
```

with a call to a **file-local** `sessionSub(req): string | null` that:

- returns `null` when `process.env.SESSION_SECRET` is unset or blank —
  **this is what makes the Vercel copies fail closed**;
- reads the `sous_session` cookie from the `Cookie` header;
- verifies the HMAC with `node:crypto` (`timingSafeEqual`, equal lengths only)
  and checks `v === 1`, `exp > Date.now()`, non-empty `sub` and `email`;
- **then** parses `process.env.ALLOWED_EMAILS` with the same rules as
  `isAllowed` (blank env ⇒ deny; trim/lowercase; `email` must be in the set).
  Cookie valid but email removed ⇒ `null` (401). Copy this block, do not
  import `server/allowlist.ts`;
- returns the `sub`, and `null` on anything unexpected — no throws.

**Export** `sessionSub` from both files (named export next to `POST`). Vercel
invokes `POST`; the export exists so tests hit the *actual* copies, not a
re-typed twin. `api/sessionGate.test.ts` imports both and runs the same
vectors against each:

- valid cookie, matching `SESSION_SECRET` and allowlist → returns `sub`;
- wrong secret → `null`;
- expired `exp` → `null`;
- malformed payload / missing `.` / extra `.` → `null`;
- valid cookie whose email was removed from `ALLOWED_EMAILS` → `null`;
- unset/blank `SESSION_SECRET` → `null`.

Set `process.env.SESSION_SECRET` and `ALLOWED_EMAILS` inside the test file.
Garbage-cookie HTTP probes cannot detect a lenient drift; these tests can.

The 401 body stays `'Unauthorized'` so the client's existing status-based
handling is unchanged. Above each copy, a comment in the style already used for
`RECIPE_SCHEMA`:

```
// NOTE: Duplicated in api/import.ts and server/session.ts. Vercel's function
// runtime transpiles each api/ entrypoint in isolation and cannot import
// sibling helper files, so the check must live inline. Keep all three in sync.
```

Nothing else in either handler changes. The Gemini calls, the schema, the
`0x1E` framing, `maxDuration = 60`, the import URL validation and every error
response stay byte-for-byte. `sub` is not used by these handlers yet — they are
per-request proxies with no storage — but it is what a later per-user rate limit
or usage log would key on, and returning it rather than a boolean costs nothing.
`import` explicitly keeps its `fetch`-the-URL behaviour: a signed-in user
fetching an arbitrary URL is the same exposure as before, now behind an
allowlisted account instead of a shared password.

Failure handling:

- **`erasableSyntaxOnly`** (already on for `api/`) will reject an `enum` or a
  parameter property here — keep the helper to plain functions and `const`.
- **Everything 401s after deploy** → `SESSION_SECRET` is not on the service, or
  differs from the one that signed the cookie. Check
  `gcloud run services describe … --format="value(spec.template.spec.containers[0].env[].name)"`
  (names only — never print values).

**Verify:** `npm run build` and `npm test` clean.
`Select-String -Path api -Pattern 'APP_PASSWORD|x-app-password'` returns
**nothing**. With the built server running (`node --env-file=.env.local scripts/server.ts`):

```powershell
node -e "fetch('http://127.0.0.1:8080/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log('no-cookie',r.status))"
node -e "fetch('http://127.0.0.1:8080/api/import',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log('no-cookie',r.status))"
node -e "fetch('http://127.0.0.1:8080/api/chat',{method:'POST',headers:{'content-type':'application/json',cookie:'sous_session=garbage.garbage'},body:'{}'}).then(r=>console.log('bad-cookie',r.status))"
```

All three print **401**. Then, with a real cookie copied out of DevTools
(`$env:PROBE_COOKIE = '<value of sous_session>'`), run the **streaming oracle
from `docs/plans/sous-subdomain.md` step 2**, replacing the
`'x-app-password': …` header with `cookie: 'sous_session='+process.env.PROBE_COOKIE`.
It must print `FRAMING PASS` and `STREAMING PASS` with `gapMs` ≥ 500.
`INCONCLUSIVE` means retry with a longer prompt, not proceed. Finish with
`Remove-Item Env:PROBE_COOKIE`.

Then, with both `npm run dev` and `npm run dev:api` and a real session:
a chat turn streams and an import works with no password anywhere. Delete the
`sous_session` cookie in DevTools and send a chat message ⇒ the thread shows
`Please sign in again — your session expired.`, `cook.session` is gone, and
the app does not crash. `npm test` includes `api/sessionGate.test.ts` for both
exported `sessionSub`s.

### 12. [ui] The account section replaces the password field

**Repo.** Files: `src/screens/Settings.tsx`.

The "App password" input, its helper text and its Save button come out. In their
place, at the top of Settings:

- **Signed out:** a short line explaining that signing in with Google identifies
  you so chat and import can run as you, and a primary **Sign in with Google**
  control. It must be a real `<a href={signInHref('/settings')}>` styled with
  `primaryBtn` — a `<button onClick={fetch}>` cannot complete an OAuth
  redirect. Beneath it, one sentence: recipes on this device stay on this
  device. **Do not** claim they sync to an account — they do not until step 13.
- **Signed in:** the email (truncated with `truncate`, not wrapped), and a
  **Sign out** control using `secondaryBtn`. Sign out must say, in one line,
  that recipes stay on this device.
- **Loading:** the existing "nothing rendered until data arrives" convention
  (`recipes === undefined ? null : …` in `Library.tsx`) — render nothing for the
  account block rather than a spinner that flashes on every visit.
- **Offline** (`status === 'offline'` with a cached user): show the cached email
  with a muted "offline" note, and do not offer Sign in — a sign-in attempt with
  no network dead-ends on Google's page.

Also in Settings:

- The **Backup** section copy **stays** "Recipes live only on this device."
  That is still true at the identity-only checkpoint. Keep both buttons, the
  hidden file input, the `cook-backup-…json` filename and the status line
  exactly as they are. Step 17 changes this copy when sync is real.
- A small **legal** footer: `Privacy` and `Terms` as plain `<a href="/privacy">`
  / `<a href="/terms">` — **not** React Router `<Link>`, which would client-route
  to a non-existent route. `target="_blank" rel="noreferrer"` so a half-written
  recipe is not lost.

Reuse `primaryBtn`, `secondaryBtn`, `backLink`, `inputClass` and the existing
`h2 className="mt-8 text-lg font-semibold"` section rhythm from
`src/lib/uiClasses.ts`. No new colour, no new spacing scale, no layout
restructure. Tap targets stay at least 44px tall, as the rest of the screen
does.

Failure handling: if the sign-in control is rendered as a `<button>` and nothing
happens on tap, that is this step's bug — it must be an anchor. If Settings
flashes "Sign in" for a moment on every load for a signed-in user, the
`loading` state is being treated as `signedOut`.

**Verify:** `npm run build`, `npm test`, and by hand in `npm run dev` at phone
width (DevTools → iPhone) and desktop width, in **both** themes:

- signed out: Sign in with Google is visible, is an anchor, and starts the real
  flow;
- signed in: the email shows, Sign out works and the screen returns to the
  signed-out state without a reload;
- with DevTools → Network → Offline and a cached session: the email still shows
  with the offline note, no Sign in button, and Export/Import still work;
- `Privacy` and `Terms` open real documents (this also re-proves step 6 and 8
  from the app's own UI);
- keyboard: Tab reaches Sign in / Sign out and Enter activates them;
- `Select-String -Path src/screens/Settings.tsx -Pattern 'appPassword|App password'`
  returns nothing.

### 13. [core] `server/store.ts` — the Firestore layer

**Repo.** Files: `server/store.ts` (new), `server/auth.ts` (wire the user
upsert), `package.json` / `package-lock.json` (`npm install
@google-cloud/firestore @google-cloud/storage` — deferred from step 4).

One module owns every Firestore access. Nothing else in `server/` builds a
collection path.

- Lazily construct one `Firestore` client per process from `firestoreConfig()`
  (`{ projectId, databaseId }`), memoised at module scope — a new client per
  request leaks connections across Cloud Run's request lifetime.
- `userRoot(uid)` → `users/{uid}`, and `col(uid, 'recipes' | 'chatMessages' |
  'cookState' | 'photos')`. **Every** exported function takes `uid` as its first
  parameter and derives paths from it. There is no function that takes a
  collection path, and no function that takes a user id from anywhere but the
  verified session — that is the whole authorization model, and it is structural
  rather than a check that can be forgotten.
- `upsertUser(uid, { email, name })` → merge write, `createdAt` only on create,
  `lastSeenAt` always.
- `listChangedSince(uid, kind, cursor, limit)` →
  `orderBy('serverUpdatedAt').orderBy(FieldPath.documentId())`, `startAfter(ts,
  id)` when a cursor is given, **`limit(limit + 1)`**. Return the first
  `limit` docs. `hasMore` is `fetched.length > limit`. A page that is
  *exactly* `limit` long is **not** treated as `hasMore`. The returned
  `cursor` is `(serverUpdatedAt, id)` of the **last included** document.
  Ordering by the field **and** the document id makes the cursor total.
  Field + `__name__` ordering is covered by Firestore's automatic
  single-field index — **no composite index and no `firestore.indexes.json`**.
- `putDoc` / `tombstone` run **inside a Firestore transaction**
  (`db.runTransaction`) with automatic retry. Read, compare, write are one
  atomic unit — two Cloud Run instances must not apply overlapping mutations
  as last-write-wins on a stale read. Integration check in Verify: two
  overlapping `putDoc` calls with `updatedAt` 5 and 6; the stored document
  must be version 6.
- **Equal timestamps: a tombstone wins against a put.** `compareMutation`
  still applies live-vs-live puts when `<=`. A put that would *un-delete*
  applies only when `clientUpdatedAt > storedUpdatedAt`. Equal-timestamp
  upload vs tombstone ⇒ stay deleted (`applied: false`, reason
  `already-deleted`).
- Photo metadata documents include **`recipeId`** (the recipe that owns the
  photo — recipe card image or the chat message's `recipeId`). `photo.put`
  outbox payload is `{ id, recipeId, updatedAt }` (`updatedAt` = enqueue
  time / `Photo.createdAt`, not only `id`). Drain sends
  `x-photo-updated-at` and `x-recipe-id`. **`photoStore.add(blob)` stays
  local-only** — it does not take `recipeId` and does not enqueue. The parent
  write enqueues `photo.put`:
  - `recipeStore.save` / `create` / `applyDraft`: if the written recipe has
    `photoId`, enqueue `photo.put` with that id and `recipeId: recipe.id`
    **after** the `recipe.put` in the same transaction (seq order: recipe
    first, so drain never uploads against a missing parent);
  - `chatStore.append`: for each `photoIds[]` entry, enqueue `photo.put` with
    `recipeId: message.recipeId`, then `chat.put`;
  - `importLibrary`: see step 15 attribution rules.
  `RecipeForm.tsx` and `ChatPanel.tsx` keep calling `add(blob)` unchanged.
- **Child mutations refuse a dead parent.** `putDoc` for `chatMessages`,
  `cookState`, and `photos`, and the photo-upload metadata transaction, all
  **read `users/{uid}/recipes/{parentRecipeId}` in the same Firestore
  transaction** as the write. If that recipe is missing or tombstoned →
  `{ applied: false, reason: 'recipe-deleted' }` and no child write. This is
  what stops a concurrent `chat.put` from resurrecting a thread after
  `cascadeRecipeDelete` has started.
- `cascadeRecipeDelete(uid, recipeId, at)` is **resumable and idempotent**:
  1. Transactionally LWW-tombstone the **recipe document first** (so new child
     puts start failing the parent check immediately).
  2. Query remaining live children (`chatMessages` where `recipeId`,
     `cookState/{recipeId}`, photo metadata those rows reference plus
     `recipe.photoId` captured before strip). Tombstone them in chunks of
     **≤ 400** writes, each chunk its own transaction, using the same `at`.
     Already-tombstoned children are LWW no-ops.
  3. Persist `users/{uid}/gcsDeletes/{photoId}` `{ photoId, createdAt }`
     **in the same chunk** as each photo tombstone. **Do not delete GCS
     objects inside the Firestore work.** `server/photos.ts` drains that
     collection (object delete, then delete the `gcsDeletes` row).
  4. A crash after step 1 leaves orphans. Retrying the same `recipe.delete`
     sees the recipe already tombstoned and **still runs steps 2–3** until no
     live children remain. Return `{ photoIds, gcsPending: true }`.
- `tombstone(uid, kind, id, clientUpdatedAt)` → **keep** `id`, `updatedAt`
  (= `clientUpdatedAt`), `deletedAt`, `serverUpdatedAt`. Strip other payload.
  Stale deletes return `{ applied: false, current }`. **Never** `.delete()` a
  document: a hard delete is invisible to another device's cursor.
- `putDoc` uses the same `compareMutation` inside the transaction. A newer
  put on a tombstone **un-deletes** (`deletedAt` cleared) and writes the
  payload **only if the parent recipe (when this kind has one) is still
  live**; otherwise `recipe-deleted`. Equal timestamps write (idempotent replay).
- `Date.now()`, not `FieldValue.serverTimestamp()`, for `serverUpdatedAt`: the
  push response has to return the assigned cursor, and a sentinel is not
  readable until a round trip. The cost is that a backwards clock jump could
  hide a document from a cursor; the escape hatch is the full resync in step 17,
  and it is in the Risks.
- Document validation on the way **in** — **every** op kind, not just recipes.
  Reject with `{ applied: false, reason: 'invalid' }` rather than writing junk.

  | Op | Required | Limits |
  |---|---|---|
  | `recipe.put` | UUID `id`; non-empty `title` string; finite `servings`; arrays `ingredientSections`, `steps`, `tags`; finite `createdAt`/`updatedAt` | `JSON.stringify < 200_000` |
  | `recipe.delete` | UUID `id`; finite `updatedAt` (`clientUpdatedAt`) | — |
  | `chat.put` | UUID `id`; UUID `recipeId`; `role` `'user'\|'assistant'`; `content` string; finite `createdAt`; `photoIds` absent or UUID array; `proposedRecipe` absent or a `RecipeDraft` (same field rules as a recipe minus identity timestamps) | `content.length ≤ 20_000`; `photoIds.length ≤ 8`; total JSON `< 200_000` |
  | `chat.clearForRecipe` | UUID `recipeId`; finite `at` | — |
  | `cookState.put` | UUID `recipeId`; finite `servings`/`currentStep`/`updatedAt`/`recipeUpdatedAt`; `checkedKeys` string array (this is the Dexie field name — **not** `checkedIngredients`) | array length ≤ 500 |
  | `photo.delete` | UUID `id`; finite `updatedAt` | — |
  | `photo.put` (HTTP) | UUID path id; `image/jpeg` or `image/png`; body ≤ 2 MB | see step 18 |

  Unknown keys on recipes are dropped via the same field list as
  `compactRecipe` **on the server** before write, so a backup cannot smuggle
  `serverUpdatedAt` into Firestore. `uid`/`sub` in the body is ignored.

Tests here are limited by honesty: nothing in this repo mocks Firestore, and
inventing a mock would test the mock. So the **pure** parts — the LWW predicate,
the cursor encode/decode, the validator, the batch chunker — are exported and
unit-tested, and the Firestore calls themselves are verified against the real
database in the Verify block.

Failure handling:

- **`PERMISSION_DENIED`** → the runtime identity lacks `roles/datastore.user`
  (step 1), or locally your ADC has no quota project
  (`gcloud auth application-default set-quota-project`).
- **`NOT_FOUND: database`** → `FIRESTORE_DATABASE_ID` is wrong or unset while
  step 1 created a named database.
- **`5 NOT_FOUND` on first write** → the database exists but in another
  location/mode than assumed; re-read step 1's describe output.
- **`FAILED_PRECONDITION: index`** → a query was written differently from the
  spec above (a range filter plus an unrelated `orderBy`). Fix the query rather
  than creating an index; the shape above needs none.

**Verify:** `npm test` (the pure helpers) and `npm run build` clean. Then
against the real database, with `.env.local` loaded:

```powershell
node --env-file=.env.local --input-type=module -e "import * as s from './server/store.ts'; const uid='selftest-'+Date.now(); await s.upsertUser(uid,{email:'t@example.com',name:'T'}); const put=await s.putDoc(uid,'recipes','11111111-1111-4111-8111-111111111111',{id:'11111111-1111-4111-8111-111111111111',title:'T',servings:1,ingredientSections:[],steps:[],tags:[],createdAt:1,updatedAt:5},5); console.log('put',put.applied); const stale=await s.putDoc(uid,'recipes','11111111-1111-4111-8111-111111111111',{title:'Older'},4); console.log('stale rejected',stale.applied===false); const page=await s.listChangedSince(uid,'recipes',null,10); console.log('rows',page.docs.length,'cursor',Boolean(page.cursor)); await s.tombstone(uid,'recipes','11111111-1111-4111-8111-111111111111',Date.now()); const after=await s.listChangedSince(uid,'recipes',null,10); console.log('tombstoned',Boolean(after.docs[0].deletedAt));"
```

Expect `put true`, `stale rejected true`, `rows 1`, `tombstoned true`. Then
confirm in the console (Firestore → Data) that the documents are under
`users/selftest-…` and nowhere else, and delete that test subtree by hand
afterwards.

### 14. [core] `/api/sync/pull` and `/api/sync/push`

**Repo.** Files: `server/sync.ts` (new), `server/sync.test.ts` (new),
`scripts/server.ts` (**mount `GET /api/sync/pull` and `POST /api/sync/push`
here**).

Both routes start with `sessionFrom(req)`; `null` ⇒ **401** before anything
else. `uid` comes only from that session. **Neither endpoint reads a user id
from the query string or the body**, and `sync.test.ts` asserts that a body
carrying `uid`/`sub` is ignored rather than honoured.

**`GET /api/sync/pull?cursor=<base64url json>&limit=200`**

- The cursor is **per collection**, because each collection has its own
  ordering: `{ recipes?: [ts,id], chatMessages?: [ts,id], cookState?: [ts,id],
  photos?: [ts,id] }`. A single global cursor across four collections is simply
  wrong and would skip rows. Absent or unparseable ⇒ treat as a full pull from
  the beginning (that is also the "resync" path from step 17).
- Response:
  `{ user: { sub, email }, changes: { recipes: [...], chatMessages: [...], cookState: [...], photos: [...] }, cursor: {...}, hasMore: boolean }`,
  `Cache-Control: no-store`. Tombstones come through as
  `{ id, deletedAt }`. `photos` carry metadata only — never bytes.
- `limit` is clamped to 1…500 and defaults to 200. Each collection is fetched
  with `limit+1` as in step 13. Response `hasMore` is the OR of the four
  collections. **The client must loop while `hasMore` is true, and every
  `hasMore: true` page must include a cursor that is strictly after the
  previous one** (the last included doc). An unchanged cursor with
  `hasMore: true` is a server bug — stop and surface it.
- **Push never advances pull cursors.** The push JSON has **no** `cursor`
  field. Clients keep their per-collection pull cursor in `syncMeta` and
  update it only from pull responses. A push-returned cursor would skip
  concurrent changes from another device that landed between the client's
  last pull and this push.

**`POST /api/sync/push`**

- Body `{ ops: Op[] }`, at most **50** ops and **1 MB** per request; larger ⇒
  413 with a message saying to batch. Ops:
  `recipe.put`, `recipe.delete`, `chat.put`, `chat.clearForRecipe`,
  `cookState.put`, `photo.delete`. (`photo.put` is not a sync op — bytes go to
  `/api/photos/:id` in step 18.)
- Ops are applied **in order** and each one is **idempotent**, so a retried
  batch after a dropped response cannot corrupt anything: puts are keyed by id,
- `chat.clearForRecipe` tombstones messages with `createdAt <= at` **and**,
  on the server, collects every `photoIds[]` on those documents (and any
  remaining messages for that recipe if the client missed a pull), tombstones
  that photo metadata with the same LWW `at`, and writes `gcsDeletes` rows.
  The client still enqueues local `photo.delete` for blobs it has; the
  server cascade is what prevents orphans when the clearing device is
  missing some messages.
- `recipe.delete` runs `cascadeRecipeDelete` server-side. The client sends
  **one** op, not one per orphaned message — a long thread would otherwise blow
  the batch limit.
- Response `{ results: [{ index, applied, reason?, current? }] }` —
  **no cursor**. `applied: false` with the stored document lets the client
  converge on the winner instead of retrying forever. An op that fails
  **validation** is reported and skipped, never retried:
  `{ applied: false, reason: 'invalid' }` is terminal, and the client drops
  it from the outbox rather than wedging the queue.
- Unknown `kind` ⇒ `{ applied: false, reason: 'unknown' }` and skip, so an older
  server never 500s against a newer client.

`server/sync.test.ts` covers the pure decision logic with no Firestore: cursor
encode/decode round-trip and rejection of garbage; the LWW predicate at `<`,
`=`, `>`; op validation (missing id, wrong types, oversize, unknown kind);
`clearForRecipe` boundary at exactly `createdAt === at`; and the
"client-supplied uid is ignored" assertion.

Failure handling:

- **A push that 401s mid-batch** → the client must stop draining and surface
  "sign in again"; it must **not** drop the ops.
- **413** → the client's batch size is wrong; fix the client, not the limit.
- **A single op fails forever** (`reason: 'invalid'`) → step 16's attempt
  counter parks it and surfaces it in Settings. A queue that retries a poisoned
  op every 30 seconds is worse than a visible error.

**Verify:** `npm test` (new suites) and `npm run build` clean. Then against the
running server with a real cookie in `$env:PROBE_COOKIE`:

```powershell
node -e "const c={cookie:'sous_session='+process.env.PROBE_COOKIE,'content-type':'application/json'};fetch('http://127.0.0.1:8080/api/sync/pull').then(r=>console.log('no-cookie pull',r.status)).then(()=>fetch('http://127.0.0.1:8080/api/sync/push',{method:'POST',headers:{'content-type':'application/json'},body:'{\"ops\":[]}'})).then(r=>console.log('no-cookie push',r.status)).then(()=>fetch('http://127.0.0.1:8080/api/sync/pull',{headers:c})).then(r=>r.json()).then(j=>console.log('pull ok',j.user.sub!==undefined,Object.keys(j.changes)))"
```

Expect `no-cookie pull 401`, `no-cookie push 401`, and a pull whose `user.sub`
is your real `sub` with all four collection keys present. Then push one recipe
op with a body that **also** contains `"uid":"someone-else"`, and confirm in the
Firestore console that the document landed under **your** `users/{sub}` subtree
and that no `users/someone-else` document exists.

### 15. [core] Dexie v3: outbox, syncMeta, and stores that enqueue

**Repo.** Files: `src/lib/db.ts`, `src/lib/outbox.ts` (new),
`src/lib/recipeStore.ts`, `src/lib/chatStore.ts`, `src/lib/photoStore.ts`,
`src/lib/useCookState.ts`, `src/lib/backup.ts`, `src/lib/seed.ts`.

`src/lib/db.ts`:

```ts
this.version(3).stores({
  outbox: '++seq',
  syncMeta: 'key',
});
```

`super('cook')` and the v1/v2 declarations are **not touched**. Dexie carries
existing tables forward, so v3 adds two tables and nothing re-indexes. Extend
the export comment to say that `syncEngine` is inside this boundary alongside
the stores.

`src/lib/outbox.ts`: the op union (mirroring step 14 exactly), the row shape
`{ seq?: number; kind; payload; enqueuedAt: number; attempts: number }`, and
`enqueue(tx, op)`.

Then every mutating store method enqueues **inside its existing transaction**,
with `db.outbox` added to the transaction's table list so an op cannot survive a
rolled-back write:

| Store method | Op |
|---|---|
| `recipeStore.save`, `applyDraft`, `create` | `recipe.put` with the compacted recipe; **and** `photo.delete` for every id `deleteReplacedPhoto` removes |
| `recipeStore.remove` | **one** `recipe.delete` (the server cascades, including photos) |
| `chatStore.append` | `chat.put` |
| `chatStore.clearForRecipe` | `chat.clearForRecipe` with `at: Date.now()`, **plus** `photo.delete` for each attached image id that `clearForRecipe` currently removes locally |
| `cookStateStore.update` (in `useCookState.ts`) | `cookState.put` with `updatedAt: Date.now()` **on the op**, not on the row |
| `recipeStore.save` / `create` / `applyDraft` (in addition to `recipe.put`) | `photo.put` `{ id, recipeId, updatedAt }` when the written recipe has `photoId`, **after** `recipe.put` in the same transaction |
| `chatStore.append` (in addition to `chat.put`) | `photo.put` for each `message.photoIds[]` with that message's `recipeId`, **before** `chat.put` |
| `photoStore.add` | **nothing** — local blob only |
| `photoStore.remove` | `photo.delete` |
| `photoStore.sweepUnreferenced` | **nothing** |

Three traps, each of which is a silent data bug if missed:

- **`sweepUnreferenced` must not enqueue.** It is cache eviction, not a user
  delete. Enqueueing there would delete server-side photos that other devices
  still reference.
- **`compactRecipe` strips unknown keys.** Do **not** add sync bookkeeping
  fields (`dirty`, `syncedAt`, `ownerUid`) to `Recipe`, `ChatMessage` or
  `CookStateRow`: `compactRecipe` would drop them on the next save, and worse,
  every v2 backup file already in existence has the old shape. The outbox is a
  separate table precisely so no persisted record shape changes. `recipeStore`'s
  existing behaviour (`compactRecipe`, the `updatedAt: Date.now()` stamp, the
  `deleteReplacedPhoto` cleanup) is unchanged.
- **`recipeStore.save` already stamps `updatedAt`.** Enqueue the op with the
  **written** recipe (the post-`compactRecipe`, post-stamp value), not the
  caller's argument, or the server sees a stale `updatedAt` and LWW rejects the
  user's own edit.

`src/lib/backup.ts`: `importLibrary` currently `bulkPut`s straight into four
tables. It keeps doing exactly that — same transaction, same merge semantics,
same `app: 'cook'` check, same `{ imported, skipped }` return, same v1 cookState
handling — and additionally enqueues ops in the same transaction. Backup photo
rows have **no `recipeId`**. Attribute them before enqueue:

1. Build `Map<photoId, recipeId>` by walking imported `recipes[].photoId` then
   `chatMessages[].photoIds` (each message already has `recipeId`). First
   reference wins. If a photo is referenced by two recipes, keep the first and
   do not enqueue a second `photo.put` (one object, one metadata doc).
2. Enqueue, in order: `recipe.put` for each imported recipe; `photo.put`
   `{ id, recipeId, updatedAt: createdAt }` for each attributed photo;
   `chat.put` for each message; `cookState.put` for each progress row. Skip
   `photo.put` for photos that nothing referenced — they are cache orphans;
   local `bulkPut` still restores the blob, and `sweepUnreferenced` will drop
   it. Never invent a fake `recipeId`.
3. `exportLibrary` is untouched (it must keep reading `db.*` directly and keep
   producing `version: 2`).

That single change makes Export→Import the migration path with no
migration-specific code anywhere.

`src/lib/seed.ts`: `seedIfEmpty()` gains an early return when a session exists
or when the cache has an owner (`localStorage['cook.ownerUid']` set), and marks
`cook.hasSeeded` in that case so the sample recipe cannot appear later either.
`shouldSeed`'s pure signature and its test stay as they are. Without this, every
new device seeds "Spaghetti al Pomodoro" and pushes it into a real library.

Failure handling:

- **`DexieError: Table outbox does not exist`** in a transaction → the table is
  missing from that transaction's table list.
- **`VersionError`** on an existing device → something edited the v1/v2 `stores`
  declarations instead of adding v3. Revert; those declarations are history and
  are not editable.
- **A recipe saved offline never uploads** → the enqueue is outside the
  transaction, or `recipeStore` enqueued the pre-stamp object.

**Verify:** `npm run build` and `npm test` clean (`compactRecipe`'s key-set
assertion in `recipeStore.test.ts` still passes unchanged — that test is the
guard against adding fields to `Recipe`, and it must not be edited). By hand in
`npm run dev`, DevTools → Application → IndexedDB:

- the database is still named **`cook`** and still holds the recipes it held
  before;
- `outbox` and `syncMeta` exist and the version reads 3;
- creating a recipe adds exactly one `recipe.put` row; editing it adds one more
  whose payload `updatedAt` matches the recipe's new `updatedAt`; deleting it
  adds exactly **one** `recipe.delete` (not one per message);
- sending a chat message adds `photo.put` (if attached) then `chat.put`;
- saving a recipe with a new photo adds `recipe.put` then `photo.put` (never
  the reverse);
- ticking an ingredient adds `cookState.put` with an `updatedAt` on the op and
  **no** new field on the `cookState` row;
- a browser reload with a `photos` row that nothing references still sweeps it
  and adds **no** outbox row;
- importing a backup exported **before** this change still succeeds, reports the
  same counts, and enqueues one op per row.

### 16. [core] `src/lib/syncEngine.ts` — drain, pull, apply, and cache ownership

**Repo.** Files: `src/lib/syncEngine.ts` (new), `src/lib/syncEngine.test.ts`
(new), `src/main.tsx`.

The only new module allowed to import both `db` and `fetch`. **No screen gains a
`fetch`.**

- `sync()` — take `navigator.locks.request('sous-sync', { mode: 'exclusive' },
  …)` when `navigator.locks` exists. If it does not (older WebKit), take a
  Dexie lease: transactionally write `syncMeta['lease'] = { owner, until }`
  only when absent or expired (`until < now`); `owner` is a per-tab
  `crypto.randomUUID()` kept in memory; refresh `until` every 5s while
  running; clear on finish. If the lock/lease is held by another tab, return
  immediately. **Inside** the lock: (1) drain the outbox, (2) pull, (3) apply.
  The module-level in-flight promise still serializes *within* a tab. Two
  tabs must not drain the same outbox concurrently.
- **Drain:** read the outbox in `seq` order, batch ≤ 50, `POST /api/sync/push`.
  Delete every op the server reports `applied: true` **or** `reason: 'invalid' |
  'unknown'` (terminal — a poison op must never wedge the queue). On a transport
  failure, increment `attempts` and stop; on 401, call `invalidateSession()`,
  stop, and set status `signedOut`. When `applied: false` with a `current` document, write the
  server's version into Dexie (the user's edit lost LWW; showing the winner is
  better than showing a value that will silently revert on the next pull).
  After `attempts > 5`, park the op and surface it — do not drop it, and do not
  retry it on a 30-second loop.
- **Pull:** read the cursor from `syncMeta['cursor']`, loop while `hasMore`, and
  store the new cursor **after** each page is applied, so an interrupted pull
  resumes rather than restarting.
- **Apply:** in one Dexie transaction per page and **without enqueuing
  anything**. Map each `SyncChange` through a per-kind normaliser (unit-tested)
  before touching Dexie:
  - recipe/chat **live**: `bulkPut` only `Recipe` / `ChatMessage` fields
    (`compactRecipe` on recipes). Strip `serverUpdatedAt` / `deletedAt`.
  - recipe/chat **tombstone**: delete the local Dexie row; a recipe tombstone
    also locally deletes that recipe's messages, cookState, and cached photo
    blobs, minus any outbox write.
  - cookState **live**: put `{ recipeId, servings, currentStep,
    checkedKeys, recipeUpdatedAt }` only (`CookStateRow` — **not**
    `checkedIngredients`).
  - chat **live**: put `{ id, recipeId, role, content, createdAt }` plus
    optional `photoIds` and `proposedRecipe`. There is no `images` field.
  - cookState **tombstone**: delete the Dexie row.
  - photos **live**: do **not** write `db.photos`; add the id to
    `syncMeta['remotePhotos']`.
  - photos **tombstone**: delete any local blob; remove the id from
    `remotePhotos`.
  `useLiveQuery` re-fires on its own.
- **Ownership**, checked before any sync and before any apply. Identity-only
  (step 10) already **claimed** `ownerUid` for the first signed-in `sub`, so
  the "absent + rows" path is rare after that slice (cleared localStorage, or
  a device that never ran step 10). When it does fire, it must still not
  silently push. Decision table **once sync exists**:
  - `cook.ownerUid` **equals** the signed-in `sub` → proceed.
  - `cook.ownerUid` **differs** → wipe `recipes`, `chatMessages`, `photos`,
    `cookState`, `outbox`, `syncMeta`, set `cook.ownerUid` to the new `sub`,
    then full pull. **No prompt**: the cache belongs to another account and must
    not be readable by this one.
  - `cook.ownerUid` **absent** and the tables are **empty** → set it and pull.
  - `cook.ownerUid` **absent** and rows **exist** → do nothing at all and
    report `needsMigration` for step 17's screen. Never scrape, never wipe,
    never push. This is the one path where silent behaviour would destroy data
    the user has nowhere else.
  - `confirmMigration()` — called only by that screen, after the user has been
    told to export: wipe, set `cook.ownerUid`, full pull.
- **Triggers:** once at startup after `fetchSession()` resolves signed-in; on
  `online`; on `visibilitychange` → visible (debounced, ≥ 30 s since the last
  run); and after a successful `importLibrary`. **No polling timer** — this is a
  phone app and a background poll costs battery for nothing.
- **Status** published through a tiny subscribe/`useSyncStatus()` hook:
  `'idle' | 'syncing' | 'offline' | 'error' | 'signedOut' | 'needsMigration'`,
  plus `lastSyncedAt` (persisted in `syncMeta`) and `pendingCount`.

Unit tests cover only what is pure: the ownership decision table (the five cases
above as a function of `ownerUid`, `sub`, `rowCount`), the batching split, the
"delete on applied or terminal reason, keep on transport failure" rule, and the
cursor merge. Dexie and `fetch` behaviour is verified by hand below, because
this repo has no fake-indexeddb and adding one for this is a separate,
unrelated project.

Failure handling:

- **An infinite pull loop** → `hasMore` is true with an unchanged cursor.
  `startAfter` is missing the document-id tiebreaker (step 13) or the cursor is
  not being stored.
- **Recipes reappear after deletion** → the delete was a hard Firestore delete
  instead of a tombstone, or apply is enqueuing ops.
- **Every device resets another device's edit** → apply is enqueuing ops, so
  each pull immediately pushes back.
- **The library empties on sign-in** → the ownership branch took the
  "differs" path when it should have taken "absent + rows exist". This is the
  one bug in the plan that loses user data; the decision table test exists for
  it.

**Verify:** `npm test` and `npm run build` clean. Then, by hand:

1. Signed in on a fresh browser profile with an empty library: create two
   recipes, add a chat message, tick an ingredient. The outbox drains to empty
   and the Firestore console shows the documents under your `users/{sub}`.
2. Open a **second** browser profile, sign in as the same account: the two
   recipes, the message and the tick appear without touching anything.
3. Delete a recipe in profile A, reload profile B: it disappears there, and it
   does **not** come back after another reload or a restart.
4. Go offline (DevTools → Network → Offline) in profile A, edit a recipe, go
   online: the edit pushes and appears in B.
5. In profile B, sign out and sign in with a **different** Google account (add a
   second email to `ALLOWED_EMAILS` temporarily): the library empties with no
   prompt and B shows that account's own (empty) library. Sign back in as the
   first account: the recipes come back.
6. `localStorage.removeItem('cook.ownerUid')` in a profile that has rows, then
   reload: the status is `needsMigration`, **nothing** is wiped and **nothing**
   is pushed (confirm the outbox stays empty and Firestore gains no documents).

### 17. [ui] Sync status and the first-sign-in migration screen

**Repo.** Files: `src/components/AccountGate.tsx` (new), `src/App.tsx`,
`src/screens/Settings.tsx`.

**`AccountGate`**, rendered by `App` inside `ErrorBoundary` and above the
`Routes`, shows nothing at all unless `useSyncStatus()` is `needsMigration`. In
that state it is a full-screen, non-dismissable panel — the one moment in this
app where blocking is right, because the alternative is a wipe of data the user
has nowhere else. Follow the existing bottom-sheet idiom from `Library.tsx`
(`fixed inset-0 z-30`, `rounded-t-3xl bg-surface`, safe-area bottom padding)
rather than inventing a modal:

- Heading: *Add this device's recipes to your account*.
- Body, with the real count: *This device has **N** recipes that aren't in your
  account yet. Export a backup first, then continue — your account's library
  replaces the copy on this device, and you can import the backup afterwards to
  add these recipes to your account.*
- **Export backup** (`primaryBtn`) — calls the same `exportLibrary` download as
  Settings. Until it has been tapped at least once in this session, **Continue
  is disabled**, with a one-line hint saying why. Deliberate friction: this is
  the only irreversible tap in the app.
- **Continue** (`secondaryBtn`) → `confirmMigration()`. While it runs, disable
  both buttons and show *Loading your library…*; do not unmount the panel until
  the first pull finishes, or a half-pulled library flashes past.
- **Sign out** (`secondaryBtn`, muted, last) — calls `signOut()`. This is the
  escape; Settings is unreachable behind a non-dismissable gate, so the gate
  must carry it. No Cancel that leaves `needsMigration` silently stuck.

**Settings → a Sync section** (below Account, above Backup), using the existing
`h2` rhythm:

- One muted line: *Synced just now* / *Synced 5 min ago* / *Never synced*, from
  `lastSyncedAt`.
- When `pendingCount > 0`: *N changes waiting to upload* (plural-aware, like the
  existing import status line's `recipe${imported === 1 ? '' : 's'}` style).
- `status === 'offline'`: *Offline — changes upload when you're back on.*
- `status === 'error'`: the danger style already used for the import status
  (`text-danger`), one sentence, plus **Try again** → `sync()`.
- **Sync now** (`secondaryBtn`), disabled while `syncing`.
- **Resync from server** as a small, muted, last-resort control with a two-tap
  confirm (reuse the `Clear` → `Clear all?` pattern from `ChatPanel.tsx`): clears
  the cursor and re-pulls everything. It is the escape hatch for a cursor that
  has gone wrong, and it must say that it does not delete anything.

Nothing anywhere spins on the whole app, and no screen shows a sync state while
loading — the library renders from cache immediately, exactly as today.

Also rewrite the Settings copy that step 12 left identity-only:

- Account, signed out: recipes in your account follow you across devices;
  recipes already on this device stay until you add them to your account.
- Account, signed in: sign out still says recipes stay cached on this device.
- Backup: signed in, replace "Recipes live only on this device." with: recipes
  sync to your account; an export is still the way to move a library between
  accounts or keep an offline copy. Signed out, keep the current warning.
  Buttons, filename and status line stay as they are.

Failure handling: if the gate ever appears for a signed-out user, the status
mapping is wrong (`needsMigration` requires a signed-in session). If it appears
on every load for a signed-in user, `confirmMigration` is not persisting
`cook.ownerUid`.

**Verify:** `npm run build`, `npm test`, then by hand at phone width in both
themes:

- the gate appears, Continue is disabled, **Sign out is visible and works**,
  Export downloads a file, Continue then enables and completes, the gate does
  not return after a reload;
- import the exported backup afterwards: the recipes come back **and** appear on
  the second device (this is the migration story, proven end to end);
- Settings shows a plausible "Synced …", a pending count that returns to zero,
  and an offline line when DevTools is offline;
- **Resync from server** needs two taps and leaves the library intact;
- the gate traps focus and cannot be dismissed with Escape or a background tap.

### 18. [core] Photos: bucket endpoints and lazy fetch

**Repo.** Files: `server/photos.ts` (new), `scripts/server.ts` (**mount
`GET|POST /api/photos/:id` on the prefix matcher from step 6**),
`src/lib/photoStore.ts`, `src/lib/syncEngine.ts`.

**Server.** One GCS client per process, from `photoBucket()`. Object name is
**`users/{uid}/{photoId}`** — deriving the path from the session means one
user's bytes are structurally unreachable from another's account, with no check
to forget. `photoId` must match the app's UUID shape before it touches GCS;
anything else is a 400 (a photo id reaching an object path is the one place an
injected `../` would matter).

- `POST /api/photos/:id` — session required. Headers
  `x-photo-updated-at` (finite ms) and `x-recipe-id` (UUID) are required;
  missing ⇒ 400. `Content-Type` must be `image/jpeg` or `image/png`; body
  capped at **2 MB**; larger ⇒ 413.

  GCS cannot join a Firestore transaction, and wrapping a GCS write inside
  `runTransaction` is wrong (retries re-upload). Use this **staged,
  idempotent** protocol — each stage is its own step and is safe to retry:

  1. **Intent (Firestore transaction).** Read `recipes/{recipeId}` and
     `photos/{id}`. Reject 409 `recipe-deleted` if the recipe is missing or
     tombstoned. Run LWW with **tombstone-wins-on-equal**. If the stored
     photo is live → **200** and stop (idempotent replay; do not touch GCS).
     If a tombstone wins → **409**, do not write GCS. If the put should
     apply: write photo metadata `{ id, recipeId, status: 'uploading',
     updatedAt, contentType, size, serverUpdatedAt }` (`deletedAt` cleared).
  2. **Bytes (GCS, outside any transaction).** Upload to
     `users/{uid}/{photoId}`. If metadata `status` is `uploading`, overwrite
     is allowed (retry of a crashed step 2). If `ifGenerationMatch: 0` fails
     because the object already exists, continue — this request or an earlier
     retry wrote it. On GCS failure: leave metadata `uploading`, return 503;
     the client retries the same POST; do not increment outbox `attempts`
     toward park on 503 from this endpoint (same as `PHOTO_BUCKET` unset).
  3. **Confirm (Firestore transaction).** Re-read recipe and photo metadata.
     If recipe is now tombstoned, or photo metadata is now a tombstone:
     write `gcsDeletes/{id}`, tombstone the photo if not already, return 409
     `recipe-deleted`. If metadata is still `uploading` or live: set
     `status: 'live'`, `deletedAt` cleared, `recipeId`, `contentType`, `size`,
     `serverUpdatedAt`, return 200.
  4. **Concurrent delete vs upload.** `recipe.delete` tombstones the recipe
     first (step 13). A POST that passed step 1 then loses the race is
     caught at step 3 and enqueues GCS cleanup. A POST that starts after the
     recipe tombstone fails at step 1 and never writes the object.
  5. **Orphan objects.** A crash between steps 2 and 3 leaves an object with
     `uploading` metadata. The next POST retry completes step 3. A periodic
     drain (same as `gcsDeletes`, invoked at the end of photo mutations and
     after push) treats `uploading` older than 15 minutes as failed: enqueue
     `gcsDeletes` and tombstone. GET `/api/photos/:id` 404s unless metadata
     exists, is not tombstoned, **and `status` is `live`**.

- `GET /api/photos/:id` — session required. 404 unless the metadata document
  exists, is not tombstoned, `status === 'live'`, and is under **this** `uid`.
  Stream the object through, do **not** buffer it, `Content-Type` from the
  metadata.
  **Do not use a year-long immutable cache on this URL.** The path is the
  same for every account (`/api/photos/:id`); after switching Google users
  the HTTP cache can replay the previous account's bytes without a
  re-validation. Serve `Cache-Control: private, no-store` on this endpoint.
  IndexedDB remains the durable per-account cache; wiping Dexie on owner
  change does **not** clear the HTTP cache. (If a later phase wants
  immutable caching, the URL must include `uid` or a per-user cache-buster.)
  **No signed URLs**.
- Deletes: `photo.delete` tombstones metadata **and** enqueues
  `users/{uid}/gcsDeletes/{id}` (same durable work item as recipe cascade).
  A dedicated drain (on push, and at the end of `photos.ts` mutations) deletes
  the GCS object then the `gcsDeletes` row. A missing object on delete is
  success. Do not require the recipe payload to still exist.
- `PHOTO_BUCKET` unset ⇒ `/api/photos/*` returns **503**. The engine **leaves
  `photo.put` in the outbox**, does **not** increment `attempts` toward the
  park threshold, and retries on the next successful sync once the bucket
  exists. Skipping-without-parking would drop the only upload forever.

**Client.** `photoStore.add(blob)` stays a local IndexedDB write with **no
outbox row** (step 15). `ensureLocal` and GET caching as specified here.
- `ensureLocal(id)` — **new**: if `db.photos` has no row for `id`, `GET
  /api/photos/:id`, and on 200 write the blob into `db.photos`. Deduplicated by
  an in-flight map so a Library screen showing twelve cards does not fire the
  same request twelve times. A 404 or a network failure resolves quietly — a
  missing photo must degrade to the empty thumbnail box `CardThumb` and
  `PhotoThumb` already render, never to an error.
- `getBlob(id)` stays a **pure local read**. Do not make it fetch: it is called
  from `useLiveQuery`, and a side-effecting query that writes the table it reads
  re-fires itself. Instead `usePhotoUrl(id)` gains an effect that calls
  `void photoStore.ensureLocal(id)`, and the existing live query picks the blob
  up when it lands.
- The engine's drain handles `photo.put` by reading the blob back from
  `db.photos` at drain time (the outbox row carries only the id, so a blob is
  never stored twice) and POSTing it, concurrency **2**, largest last. A
  `photo.put` whose blob is already gone locally is dropped, not retried.
- `sweepUnreferenced` still evicts local blobs and still enqueues nothing.
  Server copies are unaffected, which is the point of a cache.
- `PHOTO_BUCKET` unset is handled above (503 + keep outbox row). Do **not**
  also "skip without parking" — that sentence is superseded.

Failure handling:

- **Every photo 404s after a fresh sign-in on a new device** → `ensureLocal` is
  not being called, or the upload never happened on the first device (check the
  outbox for parked `photo.put` rows).
- **A photo from the wrong account** → the object path is not uid-derived. This
  must be impossible by construction; if it happens, the path is being built
  from the request rather than the session.
- **Memory spike or a dead container on upload** → the body is being buffered;
  stream it.
- **`storage.objects.create` denied** → step 1's bucket binding is missing.

**Verify:** `npm run build`, `npm test` clean. Then by hand:

1. Signed in, attach a photo to a recipe and to a chat message. The outbox
   drains; `gcloud storage ls gs://sous-photos-cooking-assistant-508423/users/<your-sub>/ --project=$P`
   lists both objects; Firestore shows the two metadata documents.
2. In the second profile, the Library thumbnail and the chat photo both render,
   and the Network panel shows exactly **one** `GET /api/photos/<id>` per photo
   (not one per card render).
3. `GET /api/photos/<id>` with **no** cookie ⇒ 401; with a cookie for a
   different account ⇒ **404**; with a non-UUID id ⇒ 400.
4. Delete the recipe: the object disappears from the bucket and the metadata
   document is tombstoned; the second profile loses the thumbnail on its next
   pull.
5. A recipe whose photo is not yet uploaded shows the empty thumbnail box, with
   no console error and no broken-image icon.
6. `POST /api/photos/<id>` with a 3 MB body ⇒ 413.

### 19. [core] `scripts/deploy.sh`, `.env.example`, `README.md`

**Repo.** Files: `scripts/deploy.sh`, `.env.example`, `README.md`,
`public/privacy.html`, `public/terms.html`.

**Legal pages.** Rewrite the storage and retention sections so they match
what is actually deployed after steps 13–18, using the Deploy record's
Firestore `locationId` (do **not** write "stored in the EU" as an
unconditional fact). This is the text Google's reviewer will read, so it must
be true on the day the Branding URLs go live:

- **What is stored:** Google `sub`, email, display name; recipes, chat
  messages, cooking progress, and attached photos in Google Cloud (Firestore
  and Cloud Storage) in the recorded region; a copy cached in IndexedDB per
  device. No password, no Google refresh token.
- **What it is used for:** showing your own recipe library across devices, and
  answering cooking questions. Not sold, not shared, not used for advertising.
- **Retention and deletion:** deleting a recipe deletes its chat thread,
  progress and photos. To delete the whole account's stored data, email
  **chernyshov.k@gmail.com** from the signed-in address (no in-app delete-
  account button). Revoking Google access signs you out but does **not** by
  itself delete stored recipes.
- Terms: drop "the recipe library is stored on the device you are using" as
  the whole story; the library now syncs, with an on-device cache.

Do not deploy (step 20) or fill Branding URLs (step 21) until this rewrite is
in `dist/` and served at `/privacy` and `/terms`.

**`scripts/deploy.sh`** keeps its shape — `resolve_secret`'s env → deployed
service → silent prompt order, `strip_controls`, the `JSON.stringify`
`--env-vars-file` writer, `to_native_path`, the `gcloud run deploy` flags — and
changes only what the env map is:

- `resolve_secret` for `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and
  `ALLOWED_EMAILS` (not secret, but the same stickiness is what stops a redeploy
  from locking everyone out).
- `GEMINI_API_KEY` stays. **`APP_PASSWORD` is removed** — from `resolve_secret`,
  from the key list in the YAML writer, and from the closing `info` lines. Since
  the script deploys with `--env-vars-file`, which **replaces the whole env
  map**, dropping it from that list is what actually deletes it from the
  service. Say so in a comment, because it looks like an omission.
- **`SESSION_SECRET` needs its own resolution and is the most dangerous line in
  this file.** Order: environment, then the deployed service, then **generate**
  32 random bytes — but generate **only** when the `gcloud run services
  describe` call actually **succeeded** and returned no such variable. If the
  describe failed (no network, wrong project, expired credentials), `die` with
  "could not read SESSION_SECRET off the service; refusing to generate a new one
  because it would sign every device out". A silent regeneration on a flaky
  network is a self-inflicted outage. `read_deployed_env` currently returns
  empty for both "no service" and "call failed" — it needs to distinguish them
  for this one variable.
- Non-secret env written into the same YAML:
  `PUBLIC_ORIGIN=https://sous.kyrylo.lol`,
  `GOOGLE_CLOUD_PROJECT=cooking-assistant-508423`,
  `PHOTO_BUCKET=sous-photos-cooking-assistant-508423`, and
  `FIRESTORE_DATABASE_ID` **only if** step 1 created a named database.
- Keep writing values with `JSON.stringify` (double-quoted YAML scalars, escapes
  handled) and keep `strip_controls` on every prompted value — Git Bash on
  Windows prefixes pasted text with a C0 control often enough that this is why
  the function exists. **Never** put a secret on a `gcloud` command line, and
  never go back to `--set-env-vars`, which splits values on commas —
  `ALLOWED_EMAILS` is comma-separated and would be mangled or interpreted as
  several variables.
- The closing `info` block replaces "set the app password in Settings" with the
  Phase 2 follow-ups: fill the consent-screen Branding URLs and publish
  (step 21).

**`.env.example`**: the ten-variable table from the Names section, with
`APP_PASSWORD` gone, a comment saying `ALLOWED_EMAILS` empty means nobody can
sign in, a comment that `SESSION_SECRET` must not change or everyone is signed
out, and `PUBLIC_ORIGIN=http://localhost:5173` as the dev default with a note
that it must match the OAuth client's redirect URI. Keep the existing `VITE_`
warning verbatim.

**`README.md`**, editing only what Phase 2 changes:

- The intro's "There is no account, no server database, and no sync" is now
  false. Replace with: sign in with Google; recipes, chat, progress and photos
  live in your account (Firestore + Cloud Storage, region in the Deploy
  record — default `europe-west1`) and are cached on each device so the app
  works offline.
- Install steps: Settings → **Sign in with Google** instead of entering the app
  password. Keep the export/import migration note for the Vercel origin and add
  that chat and import on that origin now return 401 by design.
- Stack: add `google-auth-library` and `@google-cloud/{firestore,storage}`, and
  the `server/` directory next to `api/` with one line on why new routes live
  there and not in `api/`.
- Environment variables table: the new set, the removal of `APP_PASSWORD`, and
  the two loaded footguns (`ALLOWED_EMAILS` fail-closed, `SESSION_SECRET`
  stickiness).
- Local development: `gcloud auth application-default login`, that dev talks to
  the **real** Firestore and bucket by default, and the
  `FIRESTORE_EMULATOR_HOST` / unset-`PHOTO_BUCKET` opt-outs.
- "How it's put together": `server/` in the tree listing, and the one rule
  extended — UI goes through the stores; the stores and `syncEngine` are the
  only things that touch `db`.
- A short **Sync** subsection: server is the source of truth, IndexedDB is a
  cache, LWW on `updatedAt`, tombstones, outbox, lazy photos, and the
  Export→Import migration.
- "Your data" rewritten to match the privacy policy — they must not contradict
  each other.
- `npm test` is described as "Vitest once over `src/`"; it now also covers
  `server/`. Fix that line.
- Deployment: `bash scripts/deploy.sh` with the new variables; keep the
  domain-mapping and certificate paragraphs as history, unchanged.

**Verify:** `bash -n scripts/deploy.sh` parses. `shellcheck scripts/deploy.sh`
if available (not a gate). `Select-String -Path scripts/deploy.sh,.env.example,README.md -Pattern 'APP_PASSWORD|x-app-password'`
returns **nothing**. `cp .env.example .env.local`, fill it in, and both dev
servers still work from it. Re-read every changed README claim against the tree
— each must be checkable, and "No account" must not survive anywhere.

### 20. [core] Deploy and verify on the live host

**Operational.** **This deploys straight to production** — `sous.kyrylo.lol` is
live and there is no staging. Before running it, record the current revision so
a rollback is one command, not an investigation:

```powershell
& $gcloud run services describe sous --region=europe-west1 --project=$P --format="value(status.latestReadyRevisionName)"
```

Then, in Git Bash:

```bash
bash scripts/deploy.sh
```

It prompts once for anything it cannot read off the running service. Paste the
values from the password manager; **`SESSION_SECRET` must be the one generated
in step 3**, and after the first Phase 2 deploy it is read back off the service
and never typed again.

**If the new revision does not become Ready, roll back immediately** and debug
afterwards:

```powershell
& $gcloud run services update-traffic sous --region=europe-west1 --project=$P --to-revisions=<PREVIOUS_REVISION>=100
& $gcloud run services logs read sous --region=europe-west1 --project=$P --limit=100
```

Failure handling, by symptom:

- **Container fails to start** → a missing production dependency (the three new
  packages must be in `dependencies`, not `devDependencies`), a non-erasable
  TypeScript construct, or `server/` missing from the runtime stage. The
  Dockerfile's `COPY server ./server` line (step 4) may be missing — that is the
  one image change this phase needs, and its symptom is `Cannot find module` on
  every new route while local runs work fine.
- **Every request 401s** → `SESSION_SECRET` absent from the service. Check
  **names only**:
  `--format="value(spec.template.spec.containers[0].env[].name)"`. Never print
  values into a terminal, scrollback or transcript.
- **`redirect_uri_mismatch` in production** → `PUBLIC_ORIGIN` is not
  `https://sous.kyrylo.lol`, or the console entry has a trailing slash.
- **403 on sign-in** → `ALLOWED_EMAILS` did not make it into the env map.
- **`PERMISSION_DENIED` from Firestore or GCS** → step 1's bindings were granted
  to the wrong identity; re-read `spec.template.spec.serviceAccountName`.
- **`APP_PASSWORD` still on the service** → the `--env-vars-file` key list still
  contains it, or someone used `--update-env-vars`.

**Verify**, on the live host:

```powershell
& $gcloud run services describe sous --region=europe-west1 --project=$P --format="value(status.conditions)"
& $gcloud run services describe sous --region=europe-west1 --project=$P --format="value(spec.template.spec.containers[0].env[].name)"
node -e "for (const p of ['/','/privacy','/terms']) fetch('https://sous.kyrylo.lol'+p).then(r=>console.log(p,r.status,r.headers.get('content-type')))"
node -e "fetch('https://sous.kyrylo.lol/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log('no-cookie chat',r.status))"
node -e "fetch('https://sous.kyrylo.lol/api/sync/pull').then(r=>console.log('no-cookie pull',r.status))"
```

Expect `Ready True`; an env name list containing `SESSION_SECRET`,
`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `ALLOWED_EMAILS`, `PUBLIC_ORIGIN`,
`GOOGLE_CLOUD_PROJECT`, `PHOTO_BUCKET`, `GEMINI_API_KEY` and **not**
`APP_PASSWORD`; `/`, `/privacy`, `/terms` → 200 `text/html`; both unauthenticated
API calls → **401**. Then sign in in a desktop browser at
`https://sous.kyrylo.lol`, and re-run the **streaming oracle** (step 11's cookie
variant) against `https://sous.kyrylo.lol` — Cloud Run's front end sits in the
path and can buffer independently of local, so this must be re-proved here:
`FRAMING PASS` and `STREAMING PASS`, `gapMs` ≥ 500, and
`content-encoding`/`content-length` both null on the chat response.

### 21. [core] Fill the Branding URLs and publish to Production

**Operational.** Only after step 20 has `/`, `/privacy` and `/terms` answering
200 over HTTPS on the real hostname.

1. **Google Auth Platform → Branding**, fill in exactly:

   ```
   Homepage:  https://sous.kyrylo.lol
   Privacy:   https://sous.kyrylo.lol/privacy
   Terms:     https://sous.kyrylo.lol/terms
   ```

   Still no logo.
2. **Audience → Publish app → In production.** Confirm the dialog does **not**
   ask for a verification submission — with only the three non-sensitive
   identity scopes it should not.

**Do not leave the app in Testing.** In Testing, only listed test users can sign
in and Google expires grants after about a week; everything works during
development and then breaks for every user seven days later, looking exactly
like a session bug. Publishing is safe here because `ALLOWED_EMAILS` — not the
Testing list — is what restricts who may actually use the app.

Failure handling:

- **"Your app must be verified"** → a sensitive or restricted scope is on the
  Data Access page. Remove it; this app needs none (step 2).
- **A URL is rejected** → it must be on the authorized domain `kyrylo.lol`, must
  return 200 over HTTPS, and must not redirect. Re-check with
  `node -e "fetch('https://sous.kyrylo.lol/privacy').then(r=>console.log(r.status, r.redirected))"`.
- **The consent screen still says Testing** after publishing → it can lag a few
  minutes; re-check before changing anything.

**Verify:** the Audience page reads **In production**; Branding shows all three
URLs; and an incognito sign-in shows the consent dialog titled **Sous** with
only name, email and profile. An account that is **not** in `ALLOWED_EMAILS`
completes Google's consent and then lands on the invitation-only 403 page — that
is the intended shape of "published but private", and it should be checked
deliberately rather than discovered.

### 22. [core] End-state check

**Operational.** By hand, on a desktop browser and on the phone.

- `https://sous.kyrylo.lol` loads with a valid certificate; Library header reads
  **Sous**; the Dexie database in DevTools is still named `cook`.
- Settings → **Sign in with Google** → consent dialog says **Sous**, only
  identity scopes → back to Settings, signed in, email shown.
- **The installed iOS PWA is the important one.** Safari → Share → Add to Home
  Screen, open the installed app, and sign in **from inside it**. Expected:
  Google opens in the in-app view and returns to the app signed in. If instead
  it jumps out to Safari and the installed app remains signed out, that is the
  known iOS standalone cookie-jar case: stop, record it, and implement the **GIS
  `id_token` fallback** from Decisions (a new `/api/auth/google/id-token` route
  plus `https://sous.kyrylo.lol` added to Authorized JavaScript origins). Do not
  attempt other workarounds first.
- One chat turn **streams** (text appears progressively, not all at once) with
  no password anywhere; a proposal applies; one URL import works.
- Sign in on the second device: the same library, the same chat threads, the
  same cook progress, photos loading one at a time.
- Edit on the phone, reload the desktop: the edit is there. Delete on the
  desktop, reload the phone: it is gone and stays gone.
- Airplane mode on the phone: the library, a recipe and its chat history all
  open; an edit made offline appears on the desktop after reconnecting.
- Migration, on a device that had a pre-Phase-2 library: the gate appears,
  Export downloads a file, Continue replaces the cache, Import backup adds those
  recipes to the account, and they show up on the other device. The sample
  recipe does **not** reappear.
- `/privacy` and `/terms` load from the installed app and from a cold browser.
- Sign out: the library still opens from cache; chat says
  `Please sign in again — your session expired.`
- `https://cook-seven-mu.vercel.app` still serves its SPA and its own separate
  library; its chat and import return 401. Nothing about it was reconfigured.

**Verify:** every bullet above, once, by hand. Then fill in the Deploy record
and tick the Status list.

## Out of scope

- **Any Google API scope beyond identity** — no Calendar, no Drive, no offline
  access, no refresh tokens, no Cloud KMS. If a feature ever needs one, it is a
  new consent-screen change and a new plan.
- **Anything on Vercel:** no `vercel.json` edit, no env change, no redirect, no
  teardown, no pausing deploys. Its chat/import 401ing is the intended outcome,
  not a bug to fix.
- **Re-opening Phase 1:** region, domain mapping, certificate, Dockerfile Node
  pin, the `0x1E` protocol, the Gemini contract, the Dexie database name.
- **Multi-tenant SaaS anything**: no org/team model, no roles, no invitations
  table, no per-user quotas or billing, no admin screen. Access control is an
  env-var allowlist, on purpose.
- **Real-time sync**: no WebSockets, no Firestore listeners, no push. Sync runs
  on startup, on reconnect, on focus, and on demand.
- **Conflict resolution UI**: LWW per document, no merge view, no version
  history, no undo.
- **Server-side Gemini history or usage metering per user.**
- **Sharing a recipe with another user, public recipe links, or export to
  anything but the existing backup file.**
- **Secret Manager** (`--set-secrets`), a dedicated runtime service account,
  min-instances, CPU/memory tuning, Cloud Armor, multi-region.
- **CI changes**: `.github/workflows/ci.yml` keeps running `tsc -b` + `npm test`.
  No deploy automation, no integration test against real Firestore in CI.
- **A test harness for Dexie or Firestore** (fake-indexeddb, emulator in CI).
  Pure logic is unit-tested; the rest is verified by hand, as this repo already
  does.
- **Deleting the orphaned `cook.appPassword` localStorage key** or the stale
  `APP_PASSWORD` in anyone's local `.env.local`.
- **The GIS `id_token` fallback**, unless step 22 proves the redirect flow
  breaks in the installed iOS PWA.

## Risks

- **The installed iOS PWA may not complete a redirect OAuth flow.** An
  out-of-scope top-level navigation from a standalone web app can be handed to a
  browser view whose cookie jar is not the app's, so the callback's
  `Set-Cookie` lands somewhere the app cannot see. This is the single most
  likely thing to fail at step 22 on the device that matters most. The fallback
  (GIS popup → `id_token` → same verification, same cookie) is designed but
  deliberately unbuilt.
- **Wiping the wrong cache loses data that exists nowhere else.** The ownership
  decision table has exactly one path that wipes without a prompt (a different
  `sub`) and exactly one that must never wipe (`ownerUid` absent with rows
  present). Get them backwards and a pre-Phase-2 phone library is gone, with no
  server copy to restore from. This is why the gate forces an export first and
  why the decision table is unit-tested.
- **LWW loses an edit silently.** Two devices editing one recipe offline: the
  later `updatedAt` wins and the other edit vanishes with no notification. For
  one person with a phone and a laptop this is rare and acceptable; it would not
  be for a shared household library.
- **`serverUpdatedAt` is a wall clock.** `Date.now()` on the server means a
  backwards clock adjustment could place a document behind a cursor that has
  already passed, hiding it from a device until something else touches it. The
  mitigation is the "Resync from server" control, not a distributed clock.
- **Publishing to Production makes the sign-in page world-reachable.**
  `ALLOWED_EMAILS` is the only thing between an arbitrary Google account and the
  `GEMINI_API_KEY`. It is fail-closed, deploy.sh always writes it, and a blank
  value denies everyone — but a future refactor that "helpfully" treats an empty
  list as "allow all" would quietly turn the app into an open Gemini proxy.
- **Rotating `SESSION_SECRET` signs every device out**, including the phone
  that has unsynced offline edits in its outbox. The edits survive (the outbox
  is local and drains after the next sign-in), but it looks like data loss for
  as long as the user is signed out. `deploy.sh` reading the value back off the
  service is what prevents an accidental rotation; the refusal-to-generate
  branch is what prevents a network blip from causing one.
- **The service worker can swallow `/api/` navigations.** Without the denylist,
  sign-in in the installed app fails with no network request to look at — the
  hardest class of bug to diagnose on a phone. The old service worker already
  installed on devices also keeps serving the old shell until `autoUpdate`
  replaces it, so the first load after this deploy may still behave like the
  pre-Phase-2 app.
- **Three copies of the session verifier** (`server/session.ts`, `api/chat.ts`,
  `api/import.ts`) can drift, and a drift in the *lenient* direction is a
  security bug rather than a broken feature. The mitigation is the "keep all
  three in sync" comment plus `api/sessionGate.test.ts` running the same
  vectors against both exported `sessionSub`s, plus step 11's HTTP 401 probes.
- **Buffered streaming, again.** Auth adds a 401 branch before the stream and
  new headers on the response. Anything that reads the whole body, sets
  `Content-Length`, or compresses `/api/chat` turns the assistant back into a
  blank pause followed by a wall of text. The guard is the framing/streaming
  oracle, run **both** locally (step 11) and against Cloud Run (step 20).
- **Multiple `Set-Cookie` headers get folded.** `Headers.forEach` joins repeated
  values with a comma, which browsers mis-parse, and the OAuth callback sets
  two. `getSetCookie()` plus an array `setHeader` is the fix; get it wrong and
  sign-in fails only in production-shaped conditions.
- **Firestore's `(default)` database may already be in Datastore mode**, which
  cannot be converted. Step 1 surfaces it before any code depends on it, and the
  named-database branch keeps the phase moving — at the cost of one more env var
  that every environment must then set.
- **Photo bytes are billed egress and cache poorly on a phone.** Lazy per-photo
  fetch with `Cache-Control: private, no-store` (IndexedDB is the durable
  cache) keeps HTTP from mixing accounts; a device that clears its storage
  re-downloads the whole library's photos. Acceptable for a personal library;
  worth remembering before adding a hundred photos.
- **The Vercel origin becomes a half-working app** with no in-app explanation:
  its library works, its assistant 401s. Anyone still installed there needs the
  README's Export→Import path. Deciding Vercel's fate is still deferred.
- **New dependency weight and cold starts.** `@google-cloud/firestore` plus
  `@google-cloud/storage` are substantial packages; the image grows and the
  first request after idle pays more than Phase 1's ~1–3s. Do not "fix" it with
  a paid warm instance in this phase; do keep the Firestore and Storage clients
  memoised at module scope so a cold start pays for them once.
- **`npm run build` is the only type gate on `server/`.** The dev servers run
  TypeScript unchecked through Node's type stripping, so an error in `server/`
  can sit unnoticed until a build or a container start. `erasableSyntaxOnly` and
  step 4's `tsc -b` coverage are what move that failure left.

## Open Questions

**None blocking.** Everything needed to execute is settled above. Recorded
here so a later reader knows they were considered and answered, not missed:

1. **Who is on the allowlist?** The plan ships
   `ALLOWED_EMAILS=chernyshov.k@gmail.com`. Adding a second person is one
   comma-separated value and one redeploy; they get their **own** empty library
   (identity is per Google `sub`, not a shared household account). No shared or
   household library is designed here.
2. **Does the Vercel deployment auto-build from this repo?** If it does, its
   chat and import will 401 from the next push. That is the intended
   fail-closed outcome and needs no action — and changing it would mean touching
   Vercel, which this plan forbids.
3. **Local development shares the production library.** Same Google account ⇒
   same `sub` ⇒ same Firestore subtree, so a local experiment can modify real
   recipes. Accepted deliberately for a single-user app; the documented opt-outs
   are `FIRESTORE_EMULATOR_HOST` and leaving `PHOTO_BUCKET` unset.
4. **Deferred, decide later:** move the secrets to Secret Manager
   (`--set-secrets`); give Cloud Run a dedicated runtime service account instead
   of the default compute one; retire or redirect
   `cook-seven-mu.vercel.app` once every device has migrated; add per-user
   Gemini usage metering; add a Firestore lifecycle/cleanup job for old
   tombstones.

## Deploy record

Filled in as the operational steps run, so a later diagnosis can tell which
choice was actually made.

| What | Value |
|---|---|
| Firestore database id / mode / location | `(default)` / FIRESTORE_NATIVE / europe-west1 |
| `FIRESTORE_DATABASE_ID` needed? | no |
| Photo bucket name | |
| Runtime service account (from `serviceAccountName`, or default compute) | |
| Roles granted to it | |
| OAuth client id (last 6 chars only) | |
| Redirect URIs registered | |
| `SESSION_SECRET` stored in password manager | |
| `ALLOWED_EMAILS` value | |
| Revision before the Phase 2 deploy (rollback target) | |
| Revision after | |
| Consent screen published to Production on | |
| iOS standalone redirect sign-in: works / needed GIS fallback | |

## Status

Identity slice is steps 2–12. Do not check off 20–22, and do not add a second
allowlisted email, until 13–19 are done. Step 1 may wait until just before 13.

- [x] 1. [core] Firestore database *(operational; photo bucket/IAM left for step 18/deploy)*
- [x] 2. [core] Consent screen: Branding, Data Access, Audience *(operational)*
- [x] 3. [core] Web OAuth client and the session secret *(operational)*
- [x] 4. [core] Dependencies, `server/` directory, env module *(repo)*
- [x] 5. [core] `server/session.ts` — sign and verify `sous_session` *(repo)*
- [x] 6. [core] `scripts/server.ts`: method-aware router, prefix matcher, legal-page mapping *(repo)*
- [x] 7. [ui] `/privacy` and `/terms`, written for this app *(repo)*
- [x] 8. [core] Keep the service worker out of `/api/` and the legal pages *(repo)*
- [x] 9. [core] `server/auth.ts` — the Google sign-in routes *(repo)*
- [x] 10+11. [core] Client session + `sessionSub` gate, one pass *(repo)*
- [x] 12. [ui] The account section replaces the password field *(repo)*
- [x] 13. [core] `server/store.ts` — the Firestore layer *(repo)*
- [x] 14. [core] `/api/sync/pull` and `/api/sync/push` *(repo)*
- [x] 15. [core] Dexie v3: outbox, syncMeta, and stores that enqueue *(repo)*
- [x] 16. [core] `src/lib/syncEngine.ts` — drain, pull, apply, cache ownership *(repo)*
- [x] 17. [ui] Sync status and the first-sign-in migration screen *(repo)*
- [ ] 18. [core] Photos: bucket endpoints and lazy fetch *(repo)*
- [ ] 19. [core] `scripts/deploy.sh`, `.env.example`, `README.md`, privacy rewrite *(repo)*
- [ ] 20. [core] Deploy and verify on the live host *(operational)*
- [ ] 21. [core] Fill the Branding URLs and publish to Production *(operational)*
- [ ] 22. [core] End-state check *(operational)*

## Audit

- Round 1: REVISE — identity step order, cache ownership in the identity slice,
  premature Settings/privacy claims, callback `sous_oauth` cleanup on throws,
  `readSession` absent vs unusable, `returnTo` open-redirect, duplicated
  `sessionSub` tests and `invalidateSession` on 401, recipe-delete vs child-write
  races, GCS-inside-Firestore-transaction, `photoStore.add` vs `recipeId`,
  backup photo attribution.
- Round 2: pending.
