# Sous

A personal, allowlisted recipe book that runs as an installed PWA on a phone.
It holds a readable recipe view, a cooking assistant attached to that recipe,
and one-tap import of recipes from a URL or pasted text.

Live at <https://sous.kyrylo.lol>.

The app is called Sous; the repo, database, and directories are still `cook`.

Sign in with Google. Recipes, chat history, cooking progress, and photos live
in your account (Firestore and Cloud Storage in `europe-west1`). The app loads
them when you are signed in. The server also talks to Gemini on your behalf
when you use chat or import.

## Invitation and access

Sous is **invitation-only**: a Google account must either be in
`ALLOWED_EMAILS` (the owner/admin bootstrap list) or hold an **`active`**
`members/{sub}` record in Firestore that the owner created by approving a
request. Everyone else completes Google consent, lands on a server-rendered
403 with **Request access**, and gets no session cookie until approved.

1. The requester submits **Request access** (signed token, no cookie). Sous
   stores one `accessRequests/{sub}` document and may email the owner via
   Resend (optional — requests still appear in `/admin` without email).
2. The owner opens **Settings → Invitations** (owners only) or `/admin` directly.
   The screen loads all three sections on mount, has an explicit **Refresh**,
   and pages with **Load more** per section (document-id order, not “the most
   recent 200”).
3. **Pending** rows can be approved or declined; **Approved** rows can have
   access removed; **Declined** rows can be approved again. Approval writes
   `members/{sub}` and takes effect on the member’s next sign-in — **no
   redeploy**.

**Every address in `ALLOWED_EMAILS` is an owner/admin** who can manage
invitations. Add ordinary members through `/admin`, not by editing that
variable.

## Installing it on a phone

1. Open <https://sous.kyrylo.lol> in Safari.
2. Share → **Add to Home Screen**.
3. Open the installed app, go to **Settings**, and **Sign in with Google**.

Until you sign in, the library is empty. Chat and import need a session.

The old Vercel origin keeps a separate copy of the app. **Export library**
there, then **Import backup** here. Chat and import on the Vercel origin
return **401** by design — that deployment has no session cookie.

## Stack

- Vite 6 + React 19 + TypeScript 5.8, React Router 7
- Tailwind CSS v4 through `@tailwindcss/vite` — there is no `tailwind.config.js`
- In-memory library after pull; Firestore/GCS via `server/`
- `google-auth-library`, `@google-cloud/firestore`, and `@google-cloud/storage`
  on the Node server; OAuth, sync, and photos live in `server/`. The two
  `POST(req: Request)` handlers in `api/` call Gemini via `@google/genai` and
  cannot import siblings on Vercel, so new HTTP routes belong in `server/`.
- `scripts/server.ts` mounts `server/` routes plus the `api/` handlers in the
  Cloud Run container; Vercel still runs only the `api/` functions.
- `vite-plugin-pwa` for the service worker and web manifest

## Running it locally

**Prerequisites**

- Node **22.18 or newer**. `npm run dev:api` and `scripts/server.ts` import
  TypeScript handlers directly and rely on Node's native type stripping, which
  lands in 22.18. `package.json` records this as
  `"engines": { "node": ">=22.18" }`; the container pins
  `node:22.20-bookworm-slim`.
- A Gemini API key, for the assistant, dictation, and import features.
- Google OAuth client credentials and the other server variables in
  [Environment variables](#environment-variables).
- Application Default Credentials so the local API can reach Firestore and GCS
  (see [Local development](#local-development)).

**Setup**

```bash
npm install
cp .env.example .env.local   # fill in keys and allowlist; see below
```

`.env.local` is gitignored and is read only by the local API server. See
[Environment variables](#environment-variables).

**Then start both servers**, in two terminals:

```bash
npm run dev      # Vite on http://localhost:5173
npm run dev:api  # API on http://localhost:3001
```

> **`npm run dev` on its own is not enough.** It serves the whole UI, so it
> looks like everything is fine — but chat, import, dictation, sync, and photos need the
> API. Vite proxies `/api` to `localhost:3001` (see [`vite.config.ts`](vite.config.ts)), and with
> nothing listening there the proxy answers 500, which the app surfaces as
> "Assistant request failed (500)." and "Import failed (500).". The Vite log
> shows `http proxy error: /api/chat` with `ECONNREFUSED`. If AI features break
> and nothing else does, this is why.

[`scripts/dev-api-server.ts`](scripts/dev-api-server.ts) is a thin wrapper
around [`scripts/server.ts`](scripts/server.ts) with `staticRoot: null`: it
serves the same routes as production (auth, sync, photos, chat, import, dictation) on port
3001, so you do not need the Vercel CLI. It loads env vars via
`node --env-file=.env.local`, which means **`.env.local` must exist** — without
it the process exits immediately with `node: .env.local: not found`.

Both servers hot-reload their own side of things; the API server does not watch
`server/` or `api/`, so restart `npm run dev:api` after editing those.

A first launch in an empty browser profile shows an empty library until you
sign in.

### Local development

Local `npm run dev:api` talks to **real** Firestore and the photo bucket by
default (same Google account ⇒ same `sub` as production — experiments mutate
live data). Set up ADC once:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project cooking-assistant-508423
```

Opt-outs: set `FIRESTORE_EMULATOR_HOST` to use the emulator instead of
Firestore, or leave `PHOTO_BUCKET` unset in `.env.local` to keep photo upload
off (`/api/photos` returns 503 until the bucket is set).

### Local development

Local `npm run dev:api` talks to **real** Firestore and the photo bucket by
default (same Google account ⇒ same `sub` as production — experiments mutate
live data). Set up ADC once:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project cooking-assistant-508423
```

Opt-outs: set `FIRESTORE_EMULATOR_HOST` to use the emulator instead of
Firestore, or leave `PHOTO_BUCKET` unset in `.env.local` to keep photo upload
off (`/api/photos` returns 503 and outbox rows stay until the bucket is set).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on 5173, proxying `/api` to 3001 |
| `npm run dev:api` | API listener on 3001; needs `.env.local` and Node ≥ 22.18 |
| `npm run build` | `tsc -b` over the app/node/api tsconfigs, then `vite build` into `dist/` |
| `npm run preview` | Serves the built `dist/` on 4173, for checking the PWA build |
| `npm test` | Vitest once over `src/` and `server/` |
| `npm run test:watch` | Vitest in watch mode |

`node scripts/server.ts` after `npm run build` serves the built app plus the
API on `PORT` (8080 by default). That is what the container runs.

`npm run build` type-checks everything, including `api/`, `server/`, and
`scripts/`, which the running dev servers do not — run it before deploying.

## Environment variables

All of these are **server-side only**. They belong in `.env.local` for local dev
and on the Cloud Run service for production (`bash scripts/deploy.sh` writes
the full map).

| Variable | Required | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | Passed to `new GoogleGenAI({ apiKey })` in the Gemini handlers (chat, import, and Ask dictation). |
| `AUTH_GOOGLE_ID` | yes | OAuth 2.0 Web client id. |
| `AUTH_GOOGLE_SECRET` | yes | OAuth client secret. |
| `SESSION_SECRET` | yes | HMAC key for the `sous_session` cookie. **Do not rotate casually** — every device is signed out if it changes. |
| `ALLOWED_EMAILS` | yes | Comma-separated **owner/admin** list. **Unset or empty ⇒ nobody can sign in** (fail-closed). Every address here can use `/admin`; approve ordinary members there, not by editing this list. |
| `PUBLIC_ORIGIN` | yes | Origin used to build the OAuth redirect URI. Local: `http://localhost:5173`. Production: `https://sous.kyrylo.lol`. |
| `GOOGLE_CLOUD_PROJECT` | yes | `cooking-assistant-508423` for Firestore. |
| `PHOTO_BUCKET` | no | GCS bucket name for recipe and chat photos. Unset ⇒ photo upload returns 503. |
| `MAIL_FROM` | yes (prod) | Resend sender address for access-request notifications. Must be verified in Resend. |
| `OWNER_NOTIFY_EMAIL` | yes (prod) | Inbox that receives access-request notifications. |
| `RESEND_API_KEY` | no | Resend API key. Unset ⇒ no notification email; requests still land in `/admin`. |
| `CHAT_MODEL` | no | Model id for the Gemini endpoints (chat, import, and Ask dictation). Defaults to `gemini-3.7-flash`. A bare `CHAT_MODEL=` is read as `''` by `--env-file`, which defeats the default — comment the line out instead. |

No `VITE_`-prefixed variable exists anywhere in the app, and none should. Vite
inlines `VITE_*` values into the client bundle, so prefixing the Gemini key
would publish it to every browser that loads the app.

## Sync

Firestore is the source of truth. The client pulls into memory on sign-in,
when the tab becomes visible, when the device goes online, and from **Refresh**
in Settings. Writes `POST /api/sync/push` immediately. Changes use
last-write-wins on `updatedAt`. Deletes are **tombstones**, not hard removes.
Photos upload to Cloud Storage; other devices fetch blobs for the current
session when a thumbnail is shown.

## Deployment

Cloud Run in `europe-west1` (not `europe-west2` — that region has no Cloud Run
domain mappings), GCP project `cooking-assistant-508423`, Artifact Registry
repo `sous`. The multi-stage [`Dockerfile`](Dockerfile) pins
`node:22.20-bookworm-slim`, builds `dist/`, and `CMD`s
`["node", "scripts/server.ts"]`. No secrets in any layer: `.dockerignore` and
`.gcloudignore` exclude `.env*`.

Build, push, and deploy with the env map the container needs. The generator
writes **ten** required keys (`GEMINI_API_KEY`, `AUTH_GOOGLE_ID`,
`AUTH_GOOGLE_SECRET`, `SESSION_SECRET`, `ALLOWED_EMAILS`, `PUBLIC_ORIGIN`,
`GOOGLE_CLOUD_PROJECT`, `PHOTO_BUCKET`, `MAIL_FROM`, `OWNER_NOTIFY_EMAIL`)
and adds **`RESEND_API_KEY`** only when it is set — omitting it removes the
key from Cloud Run because `--env-vars-file` replaces the whole map.

```bash
bash scripts/deploy.sh
```

To turn off notification email on a service that already has a key:

```bash
SOUS_DISABLE_RESEND=1 bash scripts/deploy.sh
```

The script resolves secrets from the environment or the live service, never
prints them, and uses `--env-vars-file` so comma-containing values like
`ALLOWED_EMAILS` stay intact. Then map the domain:

```bash
gcloud beta run domain-mappings create --service=sous --domain=sous.kyrylo.lol --region=europe-west1 --project=cooking-assistant-508423
```

In Cloudflare, a grey-cloud (DNS only) CNAME `sous` → whatever that command
printed (so far always `ghs.googlehosted.com`). Proxied (orange) blocks
certificate issuance. HTTPS looks broken until `CertificateProvisioned` is
`True`; do not edit the record while waiting.

[`scripts/server.ts`](scripts/server.ts) serves `dist/` and the API in one
process. It mirrors [`vercel.json`](vercel.json)'s SPA rewrite more strictly:
`index.html` only for GET/HEAD paths that do not start with `/api/` and whose
last segment has no `.`. A missing file-like path 404s instead of returning
HTML.

The Vercel deployment at <https://cook-seven-mu.vercel.app> still exists and
is untouched. Chat and import there return 401.

## How it's put together

```
api/chat.ts               streaming Gemini proxy + the update_recipe tool
api/import.ts             URL fetch, JSON-LD extraction, Gemini extraction
server/stt.ts             Ask dictation: raw audio in, `{ text }` out via Gemini
server/auth.ts            Google OAuth and session cookie
server/sync.ts            Firestore pull/push
server/photos.ts          GCS staged upload and download
server/store.ts           Firestore paths and mutation helpers
scripts/server.ts         production server: server/ + api/ + static dist/
scripts/dev-api-server.ts same listener, static serving off, port 3001
Dockerfile                multi-stage image; CMD node scripts/server.ts
src/App.tsx               flat routes, no layout wrapper
src/screens/              Library, RecipeView, ImportScreen, Settings
src/components/           ChatPanel.tsx, ErrorBoundary.tsx, and subcomponents
src/lib/                  types, stores, in-memory library, small helpers
```

The one rule to keep: **UI code goes through the stores in `src/lib/`
(`recipeStore`, `chatStore`, `photoStore`) and never calls `fetch` for library
data.** [`src/lib/syncEngine.ts`](src/lib/syncEngine.ts) and
[`src/lib/remote.ts`](src/lib/remote.ts) own pull/push/photo HTTP. Admin
HTTP lives in [`src/lib/adminApi.ts`](src/lib/adminApi.ts).

Two details that are easy to trip over:

- The recipe JSON schema Gemini fills in is duplicated verbatim between
  [`api/chat.ts`](api/chat.ts) and [`api/import.ts`](api/import.ts), because
  Vercel transpiles each `api/` entrypoint in isolation and cannot import a
  sibling helper. The two copies must stay in sync, and neither has a
  compile-time relationship to the `RecipeDraft` type.
- `/api/chat` streams **plain text**, then a Record Separator (`0x1E`), then
  any proposal JSON (or empty), then a final `0x1E` that marks a clean end.
  That is why there is no SSE framing: the client splits on `\x1E`, renders the
  text part as it arrives, parses the proposal when present, and treats a
  missing final separator as a cut-off reply.
- `POST /api/stt` takes a raw audio body (`Content-Type` one of webm/mp4/aac/mpeg/ogg/wav)
  and a session cookie, and returns JSON `{ text }`. Vite must proxy `/api` to
  the Node server or dictation fails the same way chat does.

## Your data

Your Google account id, email, and display name are stored server-side so sync
knows who you are. Recipes, chat messages, cooking progress, and attached photos
are stored in Google Cloud (Firestore and Cloud Storage in `europe-west1`).
They are loaded into the browser while you are signed in. There is no app
password and no
Google refresh token. Chat and import send recipe text (and any photos you
attach) to Gemini at request time; Dictate sends a short microphone clip the
same way. That traffic is not stored as a separate library on the server
beyond what sync already keeps.

Settings has **Export library** / **Import backup**, which write and read a
single JSON file containing every recipe, message, and photo (photos as base64).
Use export as a personal backup or to move recipes between accounts. Importing
merges into the account library, overwriting entries that share an id.

To delete all cloud data for an account, email **chernyshov.k@gmail.com** from
the signed-in address (there is no in-app delete-account button). Revoking
Google access in your Google account settings signs you out of Sous but does
**not** by itself delete stored recipes.

**Manual deletion procedure (operator): revoke access first, then delete data.**
Membership is cached positively for up to **60 seconds** per Cloud Run
instance, so deleting a library while the person is still authorized can let
their client push it back on the next sync.

1. Set `members/{sub}.status = 'revoked'`, or delete `members/{sub}` — either
   denies access immediately.
2. Wait at least 60 seconds and confirm denial: their `/api/auth/session` must
   return `user: null` and sync must **401** before you delete anything else.
3. Delete `members/{sub}` if you only revoked in step 1 (a revoked row is
   still stored personal data).
4. Recursively delete the `users/{sub}` subtree. The console does **not**
   delete subcollections when you delete a parent document; use Firestore
   `recursiveDelete`:

   ```bash
   node -e "const {Firestore}=require('@google-cloud/firestore');const db=new Firestore({projectId:'cooking-assistant-508423'});db.recursiveDelete(db.doc('users/'+process.argv[1])).then(()=>console.log('deleted'),(e)=>{console.error(e.message);process.exit(1)})" <SUB>
   ```

   Requires Application Default Credentials with quota project
   `cooking-assistant-508423` (see [Local development](#local-development)).
5. Delete `accessRequests/{sub}` (single document).
6. Remove photo objects (Firestore does not touch GCS):

   ```bash
   gcloud storage rm --recursive gs://sous-photos-cooking-assistant-508423/users/<SUB>/ --project=cooking-assistant-508423
   ```

   On this machine `gcloud` is often not on PATH; use
   `C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`
   instead of `gcloud`.

7. Verify all four are gone: `members/{sub}`, `accessRequests/{sub}`, the
   `users/{sub}` subtree, and the bucket prefix under `users/<SUB>/`.

There is **no automated purge job** for access-request or membership records.
