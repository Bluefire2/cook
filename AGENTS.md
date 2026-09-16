# AGENTS.md

Guidance for agents working in this repo. The product is **Sous**; the npm
package, Dexie database, backup marker, and directories are still named
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
npm run build     # tsc -b && vite build — the only type gate on server/
```

`erasableSyntaxOnly` is on for Node/API tsconfigs: **no enums, no constructor
parameter properties**. Dev servers run TS unchecked; a `server/` type error
can sit until `npm run build` or a container start.

## Architecture

```
UI (screens, components)
  → stores (recipeStore / chatStore / photoStore / useCookState)
  → Dexie `cook`  and  syncEngine (the only modules that touch `db` and fetch)
```

`syncEngine` is the only client module allowed to import both `db` and
`fetch`. Screens must not `fetch`. Do not add fields to `Recipe`,
`ChatMessage`, or `CookStateRow` — `compactRecipe` strips unknown keys, and
`src/lib/recipeStore.test.ts` asserts the exact key set. That test is a
schema lock; do not "fix" it by expanding the allow-list.

Dexie database name is **`cook`**. Versions 1–3 `stores()` declarations are
history. **Do not edit v1/v2/v3.** Add a new version if a table must change.

## Auth

Google identity only. Scopes: `openid`, `userinfo.email`, `userinfo.profile`.
No refresh tokens, no extra Google APIs, no Auth.js.

- Cookie `sous_session`: `base64url(JSON).HMAC`, payload `{v,sub,email,iat,exp}`.
  HttpOnly, SameSite=Lax, Path=/, Secure on https, 90 days.
- `ALLOWED_EMAILS` is fail-closed (blank = nobody). Re-checked on every
  protected request, not only at cookie issue time.
- OAuth callback **must not** use `Response.redirect()` (immutable Headers;
  `Set-Cookie` would be dropped). Build a `Response` with a `Location` header
  and always clear `sous_oauth`.
- Sign-in control is `<a href={signInHref(...)}>`, never `fetch` from a button.
- Do not rotate `SESSION_SECRET` casually; it signs every device out.

Local redirect URI is `http://localhost:5173/api/auth/callback/google` (Vite,
not 3001). Production: `https://sous.kyrylo.lol/api/auth/callback/google`.

## Sync

Server is source of truth (Firestore `users/{uid}/…`). IndexedDB is a cache.
LWW on client `updatedAt`; **tombstones**, never hard-deletes (a missing doc
is invisible to another device's cursor). `uid` comes only from the session —
ignore `uid`/`sub` in bodies.

Sync runs on sign-in, `online`, tab-visible (≥30s debounce), after backup
import, and on demand. **No polling timer.**

Ownership (`cook.ownerUid`):

| owner vs sub | rows | action |
| --- | --- | --- |
| equal | — | sync |
| different | — | wipe cache, pull (no prompt) |
| absent | empty | claim, pull |
| absent | present | `needsMigration` — never wipe, never push |

`AccountGate` is the export-first screen for that last row. Do not toast over
it. `confirmMigration()` calls `runSyncInner` directly so it cannot join an
unrelated in-flight `sync()`.

`photoStore.add(blob)` is **local-only**. Parent writes enqueue `photo.put`.
`sweepUnreferenced` is cache eviction and **must not enqueue** (that would
delete server photos other devices still need). `getBlob` is a pure local
read (used from `useLiveQuery`); do not fetch inside it.

**Today** `splitDrainBatch` still skips `photo.put` (no `/api/photos` yet).
That skip is superseded by `docs/plans/photos-and-deploy-docs.md`. Until that
lands, pending photo rows and a non-zero Settings count are expected.

Toasts (`SyncToast`): "Synced" only when a run actually pushed or applied a
**material** change; failures show "Couldn't sync". No-op app-open syncs stay
silent. `sync()` is deliberately **not** `async`; do not put
`finally { inFlight = null }` inside the IIFE — that wedges sync after a
signed-out run. See `docs/plans/sync-toast.md`.

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
must die, not mint a new secret.

This deploys **straight to production**. There is no staging. Record the
current revision before `bash scripts/deploy.sh`.

Docker is not installed locally; image builds run on Cloud Build.

## Do not touch

- Dexie name `cook`, v1/v2/v3 `stores()`, `app: 'cook'` backups,
  `cook-backup-` filenames
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
| `docs/plans/photos-and-deploy-docs.md` | **Next repo slice:** steps 18–19 (GCS photos, deploy.sh, README, legal rewrite). |
| `docs/plans/deploy-and-end-state.md` | Steps 20–22 (production deploy, consent In production, two-device / iOS PWA check). Forbidden until 18–19 land. |
| `docs/plans/sync-engine-hardening.md` | Findings only, not an approved plan (resync vs in-flight pull, Dexie lease ownership, malformed 200 push bodies). |

If iOS standalone PWA sign-in jumps to Safari and the app stays signed out,
stop and plan the GIS `id_token` fallback from the parent Decisions. Do not
invent other OAuth workarounds.

## Tests and verification

Unit tests cover **pure** logic only. There is no fake-indexeddb, no Firestore
emulator in CI, no GCS mock, no DOM testing library — do not add them for one
feature.

UI and layout changes: exercise the flow in the browser (not a screenshot).
Vite + `dev:api`, signed in at `localhost:5173`. Check other routes that share
the state you touched.

Chat streaming must not grow `Content-Length` or `Content-Encoding` on
`/api/chat`. The framing/streaming oracle in `docs/plans/sous-subdomain.md`
step 2, with a `sous_session` cookie instead of `x-app-password`, is the
guard — run it against Cloud Run after a production deploy, not only locally.

## Product copy

Settings and `/privacy` `/terms` currently still describe identity-first /
device-only storage in places. Step 19 rewrites legal pages for Firestore +
GCS **before** any public Branding URL is filled. Do not ship consent
Homepage/Privacy/Terms URLs until that rewrite is in `dist/`.
