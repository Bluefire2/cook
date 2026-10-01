# AGENTS.md

Guidance for agents working in this repo. The product is **Sous**; the npm
package, backup marker, and directories are still named
`cook`.

## What this is

A personal, allowlisted recipe PWA: readable recipes, a Gemini cooking
assistant per recipe, URL/paste import. Live at https://sous.kyrylo.lol.

There is also `extension/`: an unpacked MV3 Chrome extension (plain JS, no
build step) that imports the page you are reading. It is excluded from the
image and from `tsc`; nothing else depends on it.

It is a **Vite SPA + a hand-written Node server**, not Next.js, not Auth.js.
New HTTP routes go in `server/`, not `api/`. `api/chat.ts` exists because
Vercel still hosts a copy of that handler; it **cannot import siblings**, so
session verification is duplicated inline there. Keep that copy in sync with
`server/session.ts` and `server/allowlist.ts`. `api/import.ts` is a Vercel-only
stub that always returns 401; Cloud Run serves `/api/import` from
`server/importRoute.ts`.

Recipe import (web URL/paste, extension, evals) is one pipeline in
`server/recipeImport.ts`: `importFromHtml` / `importFromSource` /
`importFromImages` take the Gemini client and model as arguments and return an
`ImportOutcome`; routes map outcomes to HTTP. `normalizeImportedRecipe` is the
only cleanup of model output for import.

Both import routes write one `event: 'import'` JSON log line per request
(`server/importLog.ts`, `withImportLog`): the session `sub`, how the import
arrived, the URL as `origin + pathname`, the outcome, counts, a thrown
error's numeric `status`, and timing. Never the email, recipe or pasted text,
HTML, photo bytes, a query string, or an error message. `/privacy` (Server
logs) and `/terms` describe exactly that line and its 30-day retention (the
`_Default` log bucket); change them with it.

No server log line may contain an email address or a link token. Invite
(`/invite/<token>`) and collection-link (`/c/<token>`) pages send
`Referrer-Policy: no-referrer` so the token never rides a `Referer`, and the
`link-token-requests` exclusion on the `_Default` sink
(`scripts/logExclusions.ts`, applied with `node
scripts/apply-log-exclusions.ts --apply`, dry run without) keeps Cloud Run's
request lines for those URLs out of Cloud Logging. `/privacy` promises both;
a new token-in-path route must be added to that filter. To see one account's imports, filter Logs
Explorer on `jsonPayload.event="import"` and `jsonPayload.sub`;
`scripts/import-audit.ts <email>` prints the `sub` and the account's imported
recipes, read-only.

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
schema lock; do not "fix" it by expanding the allow-list. Sharing avoided a
`Recipe` field (`docs/plans/shared-recipes.md`, D3); optional `Recipe.lang`
is the first deliberate exception since `galleryPhotoIds`
(`docs/constitutions/i18n.md`), and code must work when `lang` is missing.
Collections are a separate store kind. Grants live under
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
  `readSession` is cryptographic only. Protected routes call **`requireMember`**
  (or **`requireOwner`** for `/api/admin/*`).
- **Two-tier admission:** `ALLOWED_EMAILS` is the fail-closed **owner/admin**
  set (blank = nobody), re-parsed from env on **every** protected request with
  **no cache**. Firestore **`members/{sub}`** with `status: 'active'` is the
  member tier, keyed by Google **`sub`**. Owners short-circuit before any
  member read. Approve ordinary people from **`/admin`**, not by editing
  `ALLOWED_EMAILS` (every address there is an admin). Owners mint single-use
  7-day bearer invite URLs on `/admin` and can revoke any unused one. An
  admitted member who is not an owner can mint one such link from Settings
  (`POST /api/invites`) and can admit up to 5 people that way; creating
  another replaces their previous unused link, and they do not see `/admin`.
  A signed-in person can also mint from the library header: an owner uses
  the admin mint (`POST /api/admin/invites`), and a member confirms in a
  sheet before minting (`POST /api/invites`).
  Removing a member revokes their unused links, and redeem refuses a link
  whose minter is no longer admitted. The invite landing page runs that
  same check before the join page; redeem still decides inside its
  transaction. The first verified Google account that
  finishes consent from a link is written as an active member and listed
  under Approved. `approvedBy` is the minter's `sub`.
- **401 = denied** (client may invalidate the session). **503 = unknown**
  (Firestore blip — do not sign the user out). Membership **denied** must never
  map to 503; membership **unknown** must never map to 401.
- **Revocation bound:** only **active** members are cached, for **60 seconds**
  per container instance. Removing someone from `members/{sub}` takes effect
  within that bound; removing an owner from `ALLOWED_EMAILS` takes effect on
  the very next request.
- **`api/chat.ts`:** on Cloud Run, `withMembership` passes an
  in-process **`authorizedSub`** argument after `requireMember` passed. The
  inline **`sessionSub`** copy remains the **Vercel** gate and must stay in sync
  with `server/session.ts` + `server/allowlist.ts`.
- **One exception to cookie-only auth:** `POST /api/extension/import` reads the
  same token from an `X-Sous-Session` header and **never** from the cookie
  (`readHeaderSession`, no fallback), then applies the same membership decision
  as `requireMember` (`requireHeaderMember`). The Chrome extension reads the
  cookie with `chrome.cookies.get` and forwards it, because a `SameSite=Lax`
  cookie is not dependably attached to an extension-initiated request. Do not
  extend header auth to any other route, and do not add
  `Access-Control-Allow-Credentials` to this one.
- **Other cookies**, all HttpOnly, SameSite=Lax, HMAC-signed with
  `SESSION_SECRET`, 10 minutes, each its own `v` family so one never verifies
  as another: `sous_oauth` (oauth transaction), `sous_invite` (app invite
  hop), `sous_collection_link` (collection link hop, `v: 'clink'`,
  **`Path=/c`**, carries the link's sha256 id, never the token). A new flow
  gets a new cookie name and family; do not reuse one.
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

Named collections can be shared with existing admitted members as viewer or
editor; the default collection remains private. Shared refresh is a **full positional
reread** of live incoming grants and current collection contents, not an
`updatedAt` delta. The continuation cursor is HMAC-signed with a domain
separate from the session cookie. If grants or collection membership change
between pages, the server returns `409 shared-snapshot-changed` and the
client discards that attempt and rereads from the start, up to three times,
then publishes owned-only state and the existing refresh error. A successful
refresh publishes owned and shared rows atomically, so an open shared recipe
never disappears mid-refresh; the cost is that the viewer's own updates wait
for the shared pull (about 0.7 s for 900 shared recipes over 6 shares on the
emulator). Keep that trade unless shared pulls get much slower. After owned pull
completes, a non-auth shared failure publishes the completed owned-only
snapshot and returns the existing error outcome; a shared 401/403 still
clears the session and library.

Each grant has `role: 'viewer' | 'editor'`, copied onto its
`incomingShares` row; a missing or unknown role reads as viewer (no
backfill). The owner changes it with `POST /api/collections/:id/grants/role`
`{ sub, role }` (404 for anyone else, 400 for a bad role); the 20-grant cap
counts both roles. Add by email to someone already granted applies the
chosen role (`orchestrateGrantAdd` `onExisting: 'applyRole'`); a grant path
that must not change an existing role passes `'keepRole'`. An editor saves with `recipe.put` plus op-level
`shared: true`. The server resolves owner and role from the session's shares
inside the writing transaction (share → collection → listed live recipe,
stronger role wins), writes the owner's row with the owner's `id`,
`createdAt`, and photo ids, clamps `updatedAt` to server time before the LWW
compare (and stores the clamped value), and rejects (`invalid`) a viewer, an unadmitted
owner, or any photo-id change. The flag only narrows: without it a put is an
ordinary own-tree write. Only the owner deletes; `recipe.delete` from a
session with no own row that reaches the id through a share is `invalid`.
Client role is in-memory `access` on the shared origin, never a `Recipe`
field. Editors get Edit and Ask Apply (photos always kept), no photo, delete,
move, or cook-log controls.

**Collection links** (`server/collectionLinks.ts`, `collectionLinksHttp.ts`)
attach an already admitted member to one collection; they never create a
member (that is `/invite`). The owner mints, lists, and revokes under
`/api/collections/:id/links` (`GET`, `POST { role? }`, `POST …/revoke
{ id }`), cookie session, collection owner only, 404 for anyone else. Firestore
`collectionLinks/{sha256(token)}` holds owner, collection, role, and expiry;
the raw token is only in the mint response. Multi-use until revoked or 7 days,
at most 20 live per collection. `/c/<token>` is server HTML (Vite proxies
`^/c/`, PWA denylist): it swaps the token for the `sous_collection_link` hop
cookie and 303s to `/c/join`, so the token never reaches a rendered page,
Referer, or the OAuth round trip. `GET /c/join` only renders: signed out ⇒ sign
in with `returnTo=/c/join`; signed-in non-member ⇒ the invitation-only 403;
member ⇒ a confirm form. Only the same-origin `POST /c/join` redeems
(`Origin` must be exactly ours, never `null`, so `/c/join` pages send
`Referrer-Policy: same-origin`, not `no-referrer`; the posted id must match
the hop cookie), through `orchestrateGrantAdd`,
the same code path as add-by-email but with `onExisting: 'keepRole'`:
unlike add-by-email, already granted keeps its role (a link never upgrades
or downgrades anyone; the owner's row switch does), the
20-grant cap shows a "full" page and leaves the link valid, the owner's own
link writes nothing. Unknown, revoked, expired, deleted collection, and
unadmitted owner are one generic 404 page. The OAuth callback is unchanged.

Collection delete tombstones live grants in the same transaction. Forward
grants carry an internal `active` flag, and the cascade time is
`grantCascadeAt`, not the client `updatedAt`. Grants written before `active`
are not backfilled; re-share them. Undelete does not restore old viewers.

Viewer chat and cook rows store `sharedParentOwnerSub` beside the document.
The client keeps that in `chatParentOrigins` and `cookParentOrigins`, not on
`ChatMessage` or `CookStateRow`. Backup export treats either the live recipe
origin or that sidecar as shared.

A chat/cook write on a shared parent uses that stored marker (the row's own,
or for a new chat message the viewer's cook row for the recipe) only as a
lookup hint: it narrows the in-transaction incoming-share query to one owner,
and the full share → collection → listed recipe → live recipe chain is still
checked. A stale or missing hint falls back to the full scan. Never take the
hint from the request body.

Grants are inert while their owner is not admitted (not in `ALLOWED_EMAILS`
and no active `members/{sub}`). Shared pull skips them, and that omission is
part of the authorization-scope digest, so a removal between pages restarts
the shared refresh. Shared photo reads 404. Unknown owner membership is 503.
Grant documents are kept, so re-admitting the owner restores their shares.
A shared page reads its recipes in one batch and their photos in one batch.
Backup clone ids are derived from the importing `sub`, the entity namespace,
and the original id, so re-importing a file overwrites the earlier clone.

Profile upsert writes display `email` plus normalized `emailLower`. Add-by-email
queries `emailLower` first and falls back only to exact normalized `email` for
legacy profiles that already stored lowercase email. Profiles written before
`emailLower` existed are repaired once with
`scripts/backfill-email-lower.ts` (dry run, then `--apply`); do not widen the
lookup into a case-insensitive scan instead. The success-vs-generic
failure account-existence signal is a conscious invitation-only product
choice; do not make failure responses more revealing.

For a shared photo, metadata only indexes its parent recipe. Authorization
still freshly reads the incoming share and live collection, then requires
`canViewRecipe` and `recipeListsPhoto`; metadata alone never authorizes. Ask
text works on shared recipes, but Ask photo attachments are intentionally
unavailable.

A grantee — viewer or editor, same endpoint, there is no separate "viewer
leave" — can leave a shared collection with `POST /api/shared/leave`
(`{ ownerSub, collectionId }`, grantee is the session sub only); it
tombstones the same forward-grant + `incomingShares` pair as owner revoke,
reusing that code path (so the tombstone omits `role` the same way a revoke
does). A second leave, or a leave after the owner already revoked, 404s;
the client treats that 404 as success. Viewer-owned shared-parent chat can
remain orphaned server-side after revoke or leave; do not invent cleanup as
part of sharing.

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

As of 2026-09-27, production was `sous-00013-ccs`, deployed from `main` at
`cdf6d07` (includes #35, #36 cook log, and #37). Commits after `cdf6d07` were
not in that deploy. This file does not record later revisions.

The `emailLower` backfill (`node --env-file=.env.local
scripts/backfill-email-lower.ts`, ADC for `cooking-assistant-508423`, dry run
before `--apply`, idempotent) ran 2026-09-27: dry run found 0 pending of 4
profiles, so nothing was applied. Still to run: delete a real recipe that is
listed in a collection and confirm the `array-contains` query on `recipeIds`
succeeds. Native Firestore creates that single-field array index
automatically; the check is for an index exemption or misconfiguration, and
it exercises the real delete path.

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

## Agent module

The library assistant (`POST /api/agent`, screen `/assistant`) is a module.
Public entry points are `agentPost` from `server/agent/index.ts` and
`AssistantScreen` / `AssistantEntryLink` from `src/agent/index.ts`. Nothing
outside those directories imports agent internals. Wiring outside the module
is one route line in `scripts/server.ts`, one route in `src/App.tsx`,
`<AssistantEntryLink />` in `src/screens/Library.tsx`, `listLiveDocs` in
`server/store.ts`, and `onSessionReset` in `src/lib/session.ts`. The harness
under `server/agent/harness/` knows nothing about recipes; only
`server/agent/harness/google.ts` imports `@google/genai`. Domain tools live in
`server/agent/sous/`. See `docs/plans/library-agent.md`.

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

- **Client state** (`docs/constitutions/client-state.md`): How React reads client state: the one library snapshot and its copy-only-what-changes writes, useSyncExternalStore with stable getters and narrow selectors, subscriptions for everything a render reads, and reducer-driven screen dialogs. Read before changing a libraryMemory write, any store hook, a module-level store that React reads, a store read inside a component's render, or Library's dialogs.
- **Cook log** (`docs/constitutions/cook-log.md`): Dated records of cooking a recipe (rating, servings, notes, lessons, photos), the /cooks journal, and promoting a lesson into recipe notes. Read before changing CookLog data, its sync ops or cascade, its photos, its backup handling, or those screens.
- **i18n** (`docs/constitutions/i18n.md`): UI language (the src/i18n catalogs, t(), plurals, cook.locale), the Recipe.lang label and normalizeLang, recipe translation at import and on the recipe screen, dictation language, and the in-context translation review. Read before adding or changing any user-facing text, touching Recipe.lang or a language tag, sending recipe text to a translation provider, or changing the language passed to /api/stt.
- **Image import** (`docs/constitutions/image-import.md`): Importing one recipe from 1–4 photos of notes. Gemini reads the photos and they are not stored. Read before changing importFromImages, the images field, the photo picker, handwritten evals, or the photo sentences in privacy and terms.

## Plans (source of truth for unfinished work)

Non-trivial features go through `docs/plans/<slug>.md` with steps tagged
`[core]` or `[ui]`. Do not implement 18–22 off memory; read the slice plan.

| Plan | Status |
| --- | --- |
| `docs/plans/sous-oauth-db.md` | Parent. Identity + sync (1–17) done. |
| `docs/plans/sync-toast.md` | Done (`b4b43b6`). |
| `docs/plans/photos-and-deploy-docs.md` | Done (GCS photos, deploy.sh, README, legal rewrite). |
| `docs/plans/invitation-flow.md` | Done (#8). Request access → `/admin` → Firestore membership. |
| `docs/plans/invite-links.md` | Done (#12). Single-use 7-day bearer invite links that admit on Google consent. Owners mint from `/admin`. |
| `docs/plans/member-invite-links.md` | Merged (#48; library-header copy in #49). A non-owner member mints one link from Settings (`POST /api/invites`). Not deployed. |
| `docs/plans/server-backed-library.md` | Done: drop IndexedDB; in-memory library over pull/push. |
| `docs/plans/ask-voice-stt.md` | Done (#7). Ask composer dictation via `POST /api/stt` (Gemini); output remains text. |
| `docs/plans/sync-engine-hardening.md` | Findings only, not an approved plan. Dexie-lease items no longer apply. |
| `docs/plans/recipe-gallery.md` | Done (#10, simplified in #18). Main photo + end-of-recipe gallery. |
| `docs/plans/shared-recipes.md` | Done. PR 2 view-only collection grants (#23) deployed as `sous-00011-td2`; production is now `sous-00013-ccs`. `emailLower` backfill ran 2026-09-27 (0 pending); real-delete `array-contains` check still to run (see Cloud and deploy). Editor role (#45) and grantee leave (#43) are merged, not deployed. |
| `docs/plans/shared-collections-review-fixes.md`, `shared-access-hardening.md`, `shared-sharing-final-hardening.md`, `pr23-review-fixes-round-2.md` | Done. Review rounds for PR 2; history only, `shared-recipes.md` and the Sharing section here are current. |
| `docs/plans/bulk-import.md` | Done (#15). Opt-in bulk URL import on `/import`. |
| `docs/plans/chrome-extension-import.md` | Built: `extension/` + `POST /api/extension/import`. Not deployed. |
| `docs/plans/recipe-import-module.md` | Built on `recipe-import-module`: import is `server/recipeImport.ts`; one pipeline for web, extension, evals (`evals/recipeImport.eval.ts`). `api/import.ts` is a 401 stub. Not deployed. |
| `docs/plans/import-blocked-fetch.md` | Extension POSTs the tab HTML; empty html is 422, never `fetchPageHtml`. Website URL import stays paste-fallback. No proxy. |
| `docs/plans/image-import.md` | Built on `cursor/image-import-38e9`, not deployed. Import one recipe from 1–4 photos (handwritten notes) via `images` on `POST /api/import`; Gemini reads them; never stored. Bound by `docs/constitutions/image-import.md`. |
| `docs/plans/image-import-evals-and-retry.md` | Built, not deployed. Handwritten evals split into dev/holdout with `evals/AGENTS.md` rules and `ocrCompare --thinking`. The photo retry and runaway-unit check were measured and reverted (dev approach A 14/15 → 12/15; holdout stayed 15/15). |
| `docs/plans/cook-log.md` | Done (#36; constitution `docs/constitutions/cook-log.md`). Included in `sous-00013-ccs`. |
| `docs/plans/i18n.md` | Merged (#42; constitution `docs/constitutions/i18n.md`). Not deployed. UI language with `src/i18n/` catalogs, `Recipe.lang`, translation at import and on the recipe screen, dictation language. |
| `docs/plans/i18n-follow-ups.md` | Open. Post-deploy owner steps (Cloud Run translate p95, dictation clips, `lang` backfill `--write`), unrun checks, and review nits left after PR #42. |
| `docs/plans/collection-path.md` | Built on `cursor/collection-path-2d3d`. Named collections open at `/collections/<id>`. Legacy `?c=` redirects removed. Not deployed. |
| `docs/plans/approval-email.md` | Built on `cursor/approval-email-420a`. Email the requester after an admin approves an access request. Not deployed; before deploying, set `MAIL_FROM` to a sender on a Resend-verified domain (the sandbox sender skips the send). |
| `docs/plans/library-agent.md` | Merged (#34), not deployed. App-level assistant: read-only tools over the user's own library, modular cards (shopping list first), ephemeral threads. |
| `docs/plans/import-reliability.md` | Approved, not started. Typed import warnings stored as optional `Recipe.importCheck`, deterministic checks, retries (off until phase 3), warning UI. Import logging was done separately (#102). Phase 1 waits on the reporter's failing URLs. |
| `docs/plans/agent-collection-moves.md` | Built, not deployed. `propose_collection_move` / `collection_move` v1 proposal card; client apply via `collectionStore.moveRecipes`. |
| `docs/plans/html-parser-recipe-import.md` | Built on `cursor/html-parser-recipe-import-11d4`. Not deployed. Replace the hand-rolled HTML scanner in `server/recipeImport.ts` with parse5 (issue #91). |
| `docs/plans/sheet-dialog.md` | Merged (#95). Headless dialog for Sheet and Ask: focus trap, initial focus, restore on close, dialog semantics. Not deployed. |

If iOS standalone PWA sign-in jumps to Safari and the app stays signed out,
stop and plan the GIS `id_token` fallback from the parent Decisions. Do not
invent other OAuth workarounds.

## Tests and verification

Unit tests cover **pure** logic only. There is no fake-indexeddb, no Firestore
emulator in CI, no GCS mock, no DOM testing library — do not add them for one
feature. `.github/workflows/ci.yml` runs on PRs and pushes to `main`:
`npm run build` + `npm test`, a Docker image build booted with no cloud
credentials and checked by `.github/scripts/smoke-server.sh`, and dependency
review. None of it needs secrets, ADC, or production.
`scripts/invariants.test.ts` turns rules in this file into failing tests; follow
the rule rather than loosening the check. `evals/pageFixtures.test.ts` runs the
offline extraction step over every cached page and needs an entry for each new
page fixture.

Live paste-to-recipe evals are `npm run test:import` (`evals/**/*.eval.ts`,
`vitest.eval.config.ts`). They call Gemini against fixtures in `evals/import/`
and need `GEMINI_API_KEY` from `.env.local` (same as `dev:api`). Website
fixtures use cached `page.html` (never fetch at eval time). Do not fold them
into `npm test` or CI.

Before changing an import prompt, model setting, output check, retry, or eval
golden, read `evals/AGENTS.md` (dev/holdout split, no tuning on holdout,
experiments logged in `evals/EXPERIMENTS.md`).

UI and layout changes: exercise the flow in the browser (not a screenshot).
Vite + `dev:api`, signed in at `localhost:5173`. Check other routes that share
the state you touched.

Chat streaming must not grow `Content-Length` or `Content-Encoding` on
`/api/chat`. The framing/streaming oracle in `docs/plans/sous-subdomain.md`
step 2, with a `sous_session` cookie instead of `x-app-password`, is the
guard — run it against Cloud Run after a production deploy, not only locally.

## UI text and languages

Any change touching UI copy, `Recipe.lang`, translation, import translation,
or dictation language must follow `docs/constitutions/i18n.md`.

**UI text rule.** Any change that adds or changes user-facing text must put
it in the `src/i18n/` catalogs for every supported language (`en`, `uk`,
`ru`, `zh-Hans`), with no hardcoded strings in screens, components, or
client `lib/` messages. `src/i18n/en.ts` defines the key set; the other
catalogs are typed `Messages`, so a missing key fails `tsc`, and the parity
test in `src/i18n/messages.test.ts` checks plural forms and placeholders.
Sentences are single catalog strings with named `{params}`, never joined
fragments; relative times go through `src/lib/relativeTime.ts`.

Any UI change that adds or changes user-facing text must add it to
every catalog in `src/i18n/` (see `docs/constitutions/i18n.md`), in
the same change. New screens or states are added to
`docs/i18n-review/screens.json` in the same change. Once a task's
implementation is complete and you think its PR may be ready to
merge, and before opening the PR, run the in-context translation
review in `docs/i18n-review/README.md` for every screen that shows
text the task added or changed, in every non-English language. Fix
the blockers, re-review those screens, and attach the report to the
PR. Do not run the review after each individual change; it is a
pre-PR check, not part of the iteration loop. Cursor agents can use
the `.cursor/skills/i18n-visual-review` skill.

## Product copy

`/about` is a short public page that says what the app is for. `/privacy`
and `/terms` describe Firestore + GCS and that there is no on-device recipe
database. Theme preference, the UI language (`cook.locale`), and
`cook.session` stay in localStorage. Do not
describe IndexedDB, offline edits, or a local library. The Chrome extension
sends rendered page HTML, possibly from a page behind a login, to the server
and on to Gemini; `/privacy` and `/terms` must describe that before the
extension is offered beyond the owner. Photos sent for import go to Gemini and
are not stored; `/privacy` and `/terms` say so.
