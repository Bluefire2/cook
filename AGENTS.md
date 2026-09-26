# AGENTS.md

Guidance for agents working in this repo. The product is **Sous**; the npm
package, backup marker, and directories are still named
`cook`.

## What this is

A personal, allowlisted recipe PWA: readable recipes, a Gemini cooking
assistant per recipe, URL/paste import. Live at https://sous.kyrylo.lol.

It is a **Vite SPA + a hand-written Node server**, not Next.js, not Auth.js.
New HTTP routes go in `server/`, not `api/`. The two files under `api/`
(`chat.ts`, `import.ts`) exist because Vercel still hosts a copy of those
handlers; they **cannot import siblings**, so session verification is
duplicated inline there. Keep those copies in sync with `server/session.ts`
and `server/allowlist.ts`.

## How to run it

Node **≥ 22.18** (native TypeScript stripping). Both processes:

```
npm run dev       # Vite, http://localhost:5173
npm run dev:api   # node --env-file=.env.local scripts/dev-api-server.ts, port 3001
```

Vite proxies `/api` to 3001. **Vite alone looks fine and then chat/import/sync
fail.** After any change under `server/` or `scripts/server.ts`, restart
`dev:api` — it does not watch those files.

`.env.local` is gitignored and required for `dev:api`. Never print its values.
Never add a `VITE_` prefix to a secret; Vite would inline it into the client.

On this machine Vite has bound **IPv6 `[::1]` only**; `http://127.0.0.1:5173`
may fail. Use `http://localhost:5173`.

```
npm test          # Vitest over src/ and server/
npm run test:import  # live Gemini paste-to-recipe evals; needs GEMINI_API_KEY
npm run build     # tsc -b && vite build — the only type gate on server/
```

`erasableSyntaxOnly` is on for Node/API tsconfigs: **no enums, no constructor
parameter properties**. Dev servers run TS unchecked; a `server/` type error
can sit until `npm run build` or a container start.

## Architecture

```
UI (screens, components)
 → stores (recipeStore / collectionStore / chatStore / photoStore / useCookState)
 → in-memory library + syncEngine/remote (the only modules that fetch)
```

`syncEngine` and `remote` are the only client modules allowed to `fetch` for
library data. Screens must not `fetch`. Do not add fields to `Recipe`,
`ChatMessage`, or `CookStateRow` — `compactRecipe` strips unknown keys, and
`src/lib/recipeStore.test.ts` asserts the exact key set. That test is a
schema lock; do not "fix" it by expanding the allow-list. Collections are a
separate store kind. View-only grants live under
`collections/{id}/grants/{viewerSub}` plus a reverse
`incomingShares/{viewerSub}` index; they are REST, not LWW push. Shared
rows stay in the owner's tree and carry origin metadata beside `Recipe`.

The recipe library is **not** stored in IndexedDB. On boot, `discardLegacyCookDb`
deletes the old Dexie database named `cook` if it is still present. Backups
still use `app: 'cook'` and `cook-backup-` filenames.

## Auth

Google identity only. Scopes: `openid`, `userinfo.email`, `userinfo.profile`.
No refresh tokens, no extra Google APIs, no Auth.js.

- Cookie `sous_session`: `base64url(JSON).HMAC`, payload `{v,sub,email,iat,exp}`.
  HttpOnly, SameSite=Lax, Path=/, Secure on https, 90 days.
  `readSession` is cryptographic only; **`sessionFrom` no longer exists**.
  Protected routes call **`requireMember`** (or **`requireOwner`** for `/api/admin/*`).
- **Two-tier admission:** `ALLOWED_EMAILS` is the fail-closed **owner/admin**
  set (blank = nobody), re-parsed from env on **every** protected request with
  **no cache**. Firestore **`members/{sub}`** with `status: 'active'` is the
  member tier, keyed by Google **`sub`**. Owners short-circuit before any
  member read. Approve ordinary people from **`/admin`**, not by editing
  `ALLOWED_EMAILS` (every address there is an admin). Owners can also mint a
  single-use 7-day bearer invite URL on `/admin`; the first verified Google
  account that finishes consent from that link is written as an active member
  and listed under Approved.
- **401 = denied** (client may invalidate the session). **503 = unknown**
  (Firestore blip — do not sign the user out). Membership **denied** must never
  map to 503; membership **unknown** must never map to 401.
- **Revocation bound:** only **active** members are cached, for **60 seconds**
  per container instance. Removing someone from `members/{sub}` takes effect
  within that bound; removing an owner from `ALLOWED_EMAILS` takes effect on
  the very next request.
- **`api/chat.ts` / `api/import.ts`:** on Cloud Run, `withMembership` passes an
  in-process **`authorizedSub`** argument after `requireMember` passed. The
  inline **`sessionSub`** copy remains the **Vercel** gate and must stay in sync
  with `server/session.ts` + `server/allowlist.ts`.
- OAuth callback **must not** use `Response.redirect()` (immutable Headers;
  `Set-Cookie` would be dropped). Build a `Response` with a `Location` header
  and always clear `sous_oauth`.
- Sign-in control is `<a href={signInHref(...)}>`, never `fetch` from a button.
- Do not rotate `SESSION_SECRET` casually; it signs every device out.

Local redirect URI is `http://localhost:5173/api/auth/callback/google` (Vite,
not 3001). Production: `https://sous.kyrylo.lol/api/auth/callback/google`.

## Sync

Server is source of truth (Firestore `users/{uid}/…`). The client holds the
library **in memory** after a pull. LWW on `updatedAt`; **tombstones**, never
hard-deletes (a missing doc is invisible to another device's cursor). `uid`
comes only from the session — ignore `uid`/`sub` in bodies.

Pull runs on sign-in, `online`, tab-visible (≥30s debounce), and Refresh in
Settings. Writes go through `POST /api/sync/push` immediately. **No polling
timer. No outbox. No AccountGate.**

`photoStore.add(blob)` keeps the bytes in memory until the parent recipe/chat
write POSTs `/api/photos/:id`. `usePhotoUrl` fetches the blob for the session
(not IndexedDB).

Toasts (`SyncToast`): refresh errors show "Couldn't refresh". No-op app-open
pulls stay silent. `sync()` returns a Promise so Settings can await Refresh.
Clear `inFlight` in `.then`/`.catch` on that Promise, not with `finally`
inside the IIFE — that wedges sync after a signed-out run.

## Sharing

Named collections can be shared view-only with existing admitted members; the
default collection remains private. Shared refresh is a **full positional
reread** of live incoming grants and current collection contents, not an
`updatedAt` delta. The continuation cursor is HMAC-signed with a domain
separate from the session cookie. If grants or collection membership change
between pages, the server returns `409 shared-snapshot-changed` and the
client discards that attempt and rereads from the start, up to three times,
then publishes owned-only state and the existing refresh error. A successful
refresh publishes owned and shared rows atomically. After owned pull
completes, a non-auth shared failure publishes the completed owned-only
snapshot and returns the existing error outcome; a shared 401/403 still
clears the session and library.

Collection delete tombstones live grants in the same transaction. Forward
grants carry an internal `active` flag, and the cascade time is
`grantCascadeAt`, not the client `updatedAt`. Grants written before `active`
are not backfilled; re-share them. Undelete does not restore old viewers.

Viewer chat and cook rows store `sharedParentOwnerSub` beside the document.
The client keeps that in `chatParentOrigins` and `cookParentOrigins`, not on
`ChatMessage` or `CookStateRow`. Backup export treats either the live recipe
origin or that sidecar as shared.

Profile upsert writes display `email` plus normalized `emailLower`. Add-by-email
queries `emailLower` first and falls back only to exact normalized `email` for
legacy profiles that already stored lowercase email. The success-vs-generic
failure account-existence signal is a conscious invitation-only product
choice; do not make failure responses more revealing.

For a shared photo, metadata only indexes its parent recipe. Authorization
still freshly reads the incoming share and live collection, then requires
`canViewRecipe` and `recipeListsPhoto`; metadata alone never authorizes. Ask
text works on shared recipes, but Ask photo attachments are intentionally
unavailable. There is no viewer leave flow. Viewer-owned shared-parent chat
can remain orphaned server-side after revoke; do not invent cleanup as part
of sharing.

## Cloud and deploy

| | |
| --- | --- |
| GCP project | `cooking-assistant-508423` (number `62867274312`) |
| Region / Firestore | `europe-west1`, Native `(default)` — no `FIRESTORE_DATABASE_ID` |
| Cloud Run | `sous`, port 8080 |
| Photo bucket (planned) | `gs://sous-photos-cooking-assistant-508423` |
| Runtime SA | confirm `serviceAccountName`; empty ⇒ `62867274312-compute@developer.gserviceaccount.com` |
| `gcloud` | `C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd` — **not on PATH** |
| Default gcloud project on this machine | `match-cal-507107` — always pass `--project=cooking-assistant-508423` |

Local ADC: `gcloud auth application-default login` and
`set-quota-project cooking-assistant-508423`. Dev talks to **real** Firestore
(and, once set, the real bucket). Opt-outs: `FIRESTORE_EMULATOR_HOST`, unset
`PHOTO_BUCKET`. Same Google account ⇒ same `sub` ⇒ local experiments mutate
the production library.

`scripts/deploy.sh` uses `--env-vars-file` (replaces the **whole** env map).
Never `--set-env-vars` (`ALLOWED_EMAILS` is comma-separated). Never put a
secret on a `gcloud` command line. `SESSION_SECRET` may be generated only if
`services describe` **succeeded** and the var was absent; a failed describe
must die, not mint a new secret. Production env also includes **`MAIL_FROM`**,
**`OWNER_NOTIFY_EMAIL`**, and optional **`RESEND_API_KEY`** (omit with
`SOUS_DISABLE_RESEND=1` to remove an existing key from the service).

This deploys **straight to production**. There is no staging. Record the
current revision before `bash scripts/deploy.sh`. `.github/workflows/deploy.yml`
is **`workflow_dispatch` only** (never on push). It authenticates with Workload
Identity Federation as
`sous-github-deploy@cooking-assistant-508423.iam.gserviceaccount.com`, prints
the live revision, builds the image with Docker on the runner, pushes it to
Artifact Registry, then runs `SKIP_BUILD=1 bash scripts/deploy.sh`. Do not
call `gcloud builds submit` from Actions — the default
`gs://PROJECT_cloudbuild` bucket rejects the WIF identity. One-time pool /
SA / IAM setup is in `docs/github-actions-deploy.md`. Do not add a `push`
trigger.

Docker is not installed locally; local `bash scripts/deploy.sh` still uses
Cloud Build.

The first production verification after deploying sharing must delete a real
recipe that is listed in a collection and confirm the Firestore
`array-contains` query on `recipeIds` succeeds (and therefore its required
index exists).

## Do not touch

- `app: 'cook'` backups, `cook-backup-` filenames
- `vercel.json`, Vercel env, or `https://cook-seven-mu.vercel.app` (chat/import
  401 there is intended)
- Dockerfile Node pin, multi-stage shape, or `CMD` (only `COPY server` was
  the Phase 2 image change)
- Region, domain mapping, certificate
- `0x1E` chat framing / Gemini request shape / `maxDuration = 60`
- Adding Google scopes, refresh tokens, or Auth.js
- `package.json` `"name"`
- Polling sync, Firestore listeners, WebSockets
- Conflict-merge UI (LWW is the product)

## Plans (source of truth for unfinished work)

Non-trivial features go through `docs/plans/<slug>.md` with steps tagged
`[core]` or `[ui]`. Do not implement 18–22 off memory; read the slice plan.

| Plan | Status |
| --- | --- |
| `docs/plans/sous-oauth-db.md` | Parent. Identity + sync (1–17) done. |
| `docs/plans/sync-toast.md` | Done (`b4b43b6`). |
| `docs/plans/photos-and-deploy-docs.md` | Done (GCS photos, deploy.sh, README, legal rewrite). |
| `docs/plans/invitation-flow.md` | In progress on branch `invitation-flow` (request access → `/admin` → Firestore membership). |
| `docs/plans/invite-links.md` | Implementing. Owner-minted single-use 7-day bearer invite links that admit on Google consent. |
| `docs/plans/deploy-and-end-state.md` | Production cutover (`sous-00004-mpx`) and consent In production done. |
| `docs/plans/server-backed-library.md` | Done: drop IndexedDB; in-memory library over pull/push. |
| `docs/plans/ask-voice-stt.md` | Implementing. Ask composer dictation via `POST /api/stt` (Gemini); output remains text. |
| `docs/plans/sync-engine-hardening.md` | Findings only, not an approved plan. Dexie-lease items no longer apply. |
| `docs/plans/recipe-gallery.md` | In progress on branch `cursor/recipe-gallery-267b` (main photo + end-of-recipe gallery). |
| `docs/plans/shared-recipes.md` | PR 1 done. PR 2 view-only collection grants implementing. |
| `docs/plans/bulk-import.md` | Implementing. Opt-in bulk URL import on `/import`. |

If iOS standalone PWA sign-in jumps to Safari and the app stays signed out,
stop and plan the GIS `id_token` fallback from the parent Decisions. Do not
invent other OAuth workarounds.

## Tests and verification

Unit tests cover **pure** logic only. There is no fake-indexeddb, no Firestore
emulator in CI, no GCS mock, no DOM testing library — do not add them for one
feature. `.github/workflows/ci.yml` stays `tsc -b` + `npm test` on push/PR.

Live paste-to-recipe evals are `npm run test:import` (`src/**/*.eval.ts`,
`vitest.eval.config.ts`). They call Gemini against fixtures in `evals/import/`
and need `GEMINI_API_KEY` from `.env.local` (same as `dev:api`). Website
fixtures use cached `page.html` (never fetch at eval time). Do not fold them
into `npm test` or CI.

UI and layout changes: exercise the flow in the browser (not a screenshot).
Vite + `dev:api`, signed in at `localhost:5173`. Check other routes that share
the state you touched.

Chat streaming must not grow `Content-Length` or `Content-Encoding` on
`/api/chat`. The framing/streaming oracle in `docs/plans/sous-subdomain.md`
step 2, with a `sous_session` cookie instead of `x-app-password`, is the
guard — run it against Cloud Run after a production deploy, not only locally.

## Product copy

`/about` is a short public page that says what the app is for. `/privacy`
and `/terms` describe Firestore + GCS and that there is no on-device recipe
database. Theme preference and `cook.session` stay in localStorage. Do not
describe IndexedDB, offline edits, or a local library.
