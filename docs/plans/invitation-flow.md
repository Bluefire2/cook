# Invitation request flow (request access → owner approves → own library)

Parent: `docs/plans/sous-oauth-db.md`. Successor slice to
`docs/plans/photos-and-deploy-docs.md` (18–19, landed) and
`docs/plans/deploy-and-end-state.md` (20–22, partly landed — see
**Ordering** and Open Questions).

This plan turns the dead-end invitation-only 403 into a request flow, adds a
Firestore-backed dynamic membership set on top of the `ALLOWED_EMAILS`
fail-closed owner set, and gives the owner an in-app screen to approve or
decline. It deploys straight to production at the end. There is no staging.

## Goal

1. A Google account that is not a member completes Google consent, lands on the
   invitation-only page, and can press **Request access** there.
2. That press records one `accessRequests/{sub}` document in Firestore and
   sends the owner one notification email through the Resend HTTP API.
3. The owner opens `/admin` inside the app — owner-only, enforced server-side —
   sees Pending / Approved / Declined, and approves or declines.
4. An approved person signs in on the next attempt with **no redeploy** and
   gets their **own empty library** (`users/{sub}/…`). No shared or household
   library exists and none is invented.
5. Removing a member takes effect within a bounded, documented 60 seconds —
   not at 90-day cookie expiry.

## Why this is not trivial

- **Membership has to be async, and today's gate is synchronous.**
  `readSession()` in `server/session.ts` calls `isAllowed(email, true,
  allowedEmails())` inline and returns `{status:'unusable'}` on a miss.
  `sessionFrom()` wraps it and is the gate used by `syncPull`, `syncPush`,
  `photosGet`, `photosPost`. A Firestore lookup cannot happen inside a
  synchronous function, so every protected route has to move to a new async
  gate — and the old synchronous escape hatch has to be removed or a future
  route will quietly skip membership.
- **The `api/` landmine.** `api/chat.ts` and `api/import.ts` each carry an
  inline `sessionSub()` (Vercel transpiles each entrypoint in isolation and
  cannot import siblings) and that copy re-checks the **`ALLOWED_EMAILS` env
  var**. `scripts/server.ts` imports those same `POST` handlers for Cloud Run.
  Without a fix, a Firestore-approved member syncs fine and gets **401 on chat
  and import**. The fix must not put `@google-cloud/*` into a Vercel function
  bundle, must not turn the Vercel origin into an open Gemini proxy, and must
  keep `api/sessionGate.test.ts` honest.
- **The identity at the 403 moment has no cookie.** The callback holds a
  Google-verified `sub`, `email`, `email_verified` and `name` from the id_token
  but deliberately issues nothing. The Request access button therefore needs a
  signed, short-lived, zero-privilege artefact — and it must be impossible to
  confuse with a session.
- **The 403 page is server-rendered HTML, not React.** It is the response body
  of `GET /api/auth/callback/google`. Anything interactive there is plain HTML,
  or it needs a redirect into the SPA with a token in a URL.
- **Fail-closed has four different meanings here** — blank `ALLOWED_EMAILS`,
  unverified email, Firestore read throwing, and "valid cookie but membership
  revoked" — and they must map to different HTTP statuses, because a 401 makes
  the client call `invalidateSession()` and a 503 does not.
- **New personal data about non-members.** Email, name, Google `sub` and
  timestamps for people who were never admitted, plus a new subprocessor
  (Resend). `/privacy` is a real document Google's consent screen points at.
- **Abuse.** The request endpoint is reachable by anyone who can complete
  Google consent, so it is an inbox-spam and Firestore-junk surface.

## Starting state (verified by reading the tree)

- `authCallbackGoogle` (`server/auth.ts` ~line 177) checks
  `isAllowed(email, payload.email_verified, allowedEmails())` and on a miss
  logs `sign-in refused: <email>` and returns a 403 whose whole body is
  `'<!doctype html>…<p>This app is invitation-only.</p><p><a
  href="/privacy">Privacy</a></p>…'`. No cookie is set. `upsertUser` runs
  **after** the check, so a refused identity leaves no `users/{sub}` document
  today.
- Every response in that handler goes through the local `respond()` helper,
  which always appends `clearedOauthCookie` and never uses
  `Response.redirect()`. That property must survive.
- `server/allowlist.ts` `isAllowed`: blank/whitespace raw ⇒ `false`;
  `emailVerified !== true` ⇒ `false`; missing/blank email ⇒ `false`; otherwise
  case-insensitive, trimmed set membership. Blank never means allow-all.
- `server/session.ts` exports `signSession`/`verifySession` (`v: 1`),
  `signOauthTx`/`verifyOauthTx` (`v: 'oauth'`, 10-minute `exp`),
  `randomToken`, `readCookie`, the cookie builders, `readSession`,
  `sessionFrom`, `shouldRefresh`, `safeReturnTo`. Both token families are
  `base64url(JSON) + '.' + HMAC-SHA256(payload, SESSION_SECRET)` with a strict
  base64url decoder and `timingSafeEqual`.
- `server/session.test.ts` asserts `readSession` is `unusable` when the
  allowlist misses, and imports `sessionFrom`. Both change in this plan.
- `scripts/server.ts` owns a method-aware `apiRoutes` table plus one prefix
  matcher for `/api/photos/:id` (single segment, no extra slash). Non-`/api/`
  GETs fall back to `index.html` **only when the last path segment contains no
  `.`**. `createRequestListener({ staticRoot: null })` is the dev API server,
  so `/admin` is served by Vite in dev and by the SPA fallback in production.
- `vite.config.ts` PWA `navigateFallbackDenylist` is
  `[/^\/api\//, /^\/privacy$/, /^\/terms$/]`. `/api/auth/callback/google` and
  `/api/access-request` are already denylisted by the first pattern; `/admin`
  **should** be SPA-handled, so this list needs **no change**.
- `server/store.ts` is the per-user Firestore layer (`users/{uid}/…`) and
  exports `getStoreFirestore()`. It contains no top-level collections. Runtime
  SA already holds `roles/datastore.user` project-wide, so new top-level
  collections need **no new IAM**.
- `api/chat.ts` / `api/import.ts`: `export function sessionSub(req)` does
  HMAC + `v===1` + `exp` + `isEmailAllowed(row.email, ALLOWED_EMAILS)` and
  returns `row.sub`. `POST` starts with `if (sessionSub(req) === null) return
  401`. `api/sessionGate.test.ts` runs the same seven vectors against both.
  Vercel has no `SESSION_SECRET`, so `sessionSub` returns `null` there for
  everything — that is the intended Vercel 401 and must not regress.
- Client 401/503 behaviour, verified in `src/lib/syncEngine.ts`,
  `chatApi.ts`, `importApi.ts`, `session.ts`: **401 ⇒ `invalidateSession()`**
  (pull sets `signedOut`, push stops, photo.put signs out, chat/import throw
  "Please sign in again"). **503 ⇒ no sign-out** (pull → `outcome:'error'`,
  push → `stop` + `attempts++`, photo.put → `retry` with no park,
  `fetchSession` → `offline` keeping the cached user).
- `src/lib/chatApi.ts` and `src/lib/importApi.ts` are the precedent for a
  client module that fetches and never touches Dexie. `syncEngine` remains the
  only module importing both `db` and `fetch`.
- `scripts/deploy.sh`: `resolve_secret` for `AUTH_GOOGLE_ID`,
  `AUTH_GOOGLE_SECRET`, `ALLOWED_EMAILS`, `GEMINI_API_KEY`;
  `resolve_session_secret` (dies on a failed describe rather than minting);
  then a single-line `node -e` holding **both** a `fixed` map
  (`PUBLIC_ORIGIN`, `GOOGLE_CLOUD_PROJECT`, `PHOTO_BUCKET`) and a hardcoded
  `keys` array of all eight names, which `process.exit(2)`s if any resolved
  value is empty. `--env-vars-file` replaces the whole env map.
- No new npm dependency is needed: Resend is a plain `fetch` POST.
  `node:crypto` covers the token.

## Decisions

Fixed by the owner before planning — not re-litigated here:

- **D1. Membership lives in Firestore**, effective on the next request with no
  redeploy. `ALLOWED_EMAILS` keeps its exact current semantics as the
  fail-closed **owner/bootstrap** set (blank = nobody). Membership is additive
  and also requires `email_verified === true`.
- **D2. Email goes out through the Resend HTTP API** — one `fetch` POST with a
  bearer token, no new dependency, behind a single `sendMail` seam. Gmail API
  is forbidden (it would need `gmail.send` + a refresh token).
- **D3. Approval happens on an owner-only screen inside the app.** The
  notification email carries **no approval power**: no one-click link, no HMAC
  approve token. Approval only happens behind the owner's session.

Made while planning, with reasons:

- **D4. Membership is keyed by Google `sub`, not email.** The 403 moment gives
  a verified `sub`; `sessionSub` in `api/` already returns `sub`; sync already
  keys `users/{uid}` on `sub`. `sub` is stable across a Google email change,
  so **an approved member whose email changes keeps access** and their stored
  `email`/`name` fields refresh on the next sign-in (display only). The cost:
  the owner can only approve identities that have **already requested** —
  there is no "invite an email address that has never signed in". That is out
  of scope and recorded below.
- **D5. Two new top-level Firestore collections**, not subcollections of
  `users/{uid}`: the admin screen has to *list* requests across identities, and
  a subcollection would need a collection-group query. Each list is a single
  `.get()` with `.limit(200)`, sorted and split in memory, so **no composite
  index** is required. Nothing under `users/` changes.
  - `accessRequests/{sub}`: `{ sub, email, name?, status:
    'pending'|'approved'|'denied', createdAt, updatedAt, requestCount,
    lastRequestAt, lastNotifiedAt?, decidedAt?, decidedBy? }`
  - `members/{sub}`: `{ sub, email, name?, status: 'active'|'revoked',
    approvedAt, approvedBy, updatedAt }`
  - `accessRequestMeta/notifications`: `{ day: 'YYYY-MM-DD', count }` — the
    only global inbox bound.
- **D6. The `api/` landmine is resolved with an explicit in-process argument,
  not an env flag and not a trusted header.** `api/chat.ts` and
  `api/import.ts` gain an **optional second parameter**:
  `export async function POST(req: Request, ctx?: { authorizedSub?: string })`.
  When `typeof ctx?.authorizedSub === 'string' && ctx.authorizedSub !== ''`
  the handler skips its inline `sessionSub(req)`; otherwise it runs exactly as
  today. `scripts/server.ts` wraps both handlers so Cloud Run calls
  `chatPost(req, { authorizedSub: access.sub })` **after** `requireMember`
  has passed. Why this shape:
  - No HTTP client can synthesize a second function argument, so there is no
    header or cookie to forge. A trusted-header design would have to be
    stripped on every entry path and would be one missed strip away from an
    open Gemini proxy.
  - Vercel invokes the exported handler with the request only; if its runtime
    ever passes a second context object, `authorizedSub` is `undefined` and
    the inline `sessionSub` still runs. Fail-closed by default.
  - `@google-cloud/firestore` stays out of `api/` entirely — the membership
    read happens in `server/membership.ts`, which Vercel never loads.
  - `api/sessionGate.test.ts` keeps **all seven existing vectors unchanged**
    (they test `sessionSub`, which is untouched). One new assertion is added:
    `sessionSub` is still the only gate the `api/` file applies to a bare
    request. No vector is weakened.
  - The three-copies comment in both `api/` files is rewritten to say: this
    inline copy is the **Vercel** gate and must stay in sync with
    `server/session.ts` + `server/allowlist.ts`; on Cloud Run it is bypassed
    by an explicit `authorizedSub` argument and `server/membership.ts` is
    authoritative. Rejected alternatives: an env flag (`MEMBERSHIP_GATE`) —
    another deploy key and it weakens the `api/` gate to "any valid cookie";
    moving the Gemini handlers into `server/` — a third copy of the `0x1E`
    framing and the request shape, both on the do-not-touch list.
- **D7. Owner/admin = the `ALLOWED_EMAILS` set**, checked with the existing
  `isAllowed(email, true, allowedEmails())`. No new env var; it already has
  exactly the fail-closed semantics wanted, it is already in `deploy.sh` and
  `.env.example`, and today it holds exactly the owner. Consequence, to be
  written into `.env.example`, `README.md` and `AGENTS.md` in capitals:
  **anyone added to `ALLOWED_EMAILS` becomes an admin** — approve ordinary
  people through `/admin`, never by editing that variable. If that is ever
  unwanted, the revert is a separate `ADMIN_EMAILS` var plus two lines in
  `deploy.sh`; not done now to avoid a fourth deploy key.
- **D8. The Request access artefact is a new signed token family**,
  `signAccessRequestTx` / `verifyAccessRequestTx` in `server/session.ts`,
  payload `{ v: 'accessreq', sub, email, name?, iat, exp }`, `exp = iat + 10
  min`, signed with `SESSION_SECRET`, delivered as a **hidden form field** in
  the 403 HTML. It is not a cookie and grants nothing: the distinct `v` means
  `verifySession` (`v === 1`) and `verifyOauthTx` (`v === 'oauth'`) both
  reject it, and it is accepted by exactly one route. It is only ever minted
  after the callback has already checked `email_verified === true`, so a
  verified token implies a verified email. Cross-family rejection is unit
  tested in both directions.
- **D9. The 403 stays server-rendered HTML, and so does the result page.**
  A `<form method="POST" action="/api/access-request">` with the hidden token
  and one submit button; the POST replies with another self-contained HTML
  page. Checked against the tree: `/api/*` is matched by the route table
  before static serving, is already in the service-worker denylist, and never
  reaches the SPA fallback. Rejected: redirecting to a React `/invite?token=…`
  route — it puts a signed token in a URL (history, logs, shareable), boots
  the whole SPA and Dexie for a stranger, and adds a client fetch module for
  one button.
- **D10. CSRF: no token, by analysis.** `sous_session` is `SameSite=Lax`, so a
  cross-site POST carries no cookie and every admin POST fails closed at
  `requireOwner`. Admin POSTs additionally require `Content-Type:
  application/json`, which a cross-site HTML form cannot set without a CORS
  preflight. `POST /api/access-request` needs no cookie at all — its authority
  is the signed token — so a cross-site submission could at most create the
  *token holder's own* request. No hidden CSRF token is added anywhere.
- **D11. Membership cache: 60-second in-process TTL, positive and negative,
  keyed by `sub`.** Rationale: a first library load on a new device issues one
  `GET /api/photos/:id` per photo, and an uncached design would add one
  Firestore document read to each. The **owner never reads Firestore at all**
  (the `ALLOWED_EMAILS` check short-circuits first), so this cost and this
  staleness only exist for members. Explicit trade-off: **revocation takes
  effect within at most 60 seconds per running container instance** (Cloud Run
  is `min-instances=0 --max-instances=4`, so up to four caches), instead of
  AGENTS.md's "next request". Revocation path: the owner presses Remove access
  → Firestore write is immediate → the serving instance drops its own cache
  entry → other instances expire within 60 s. There is no cross-instance
  flush and none is added (no pub/sub, no polling). Only **definite** outcomes
  are cached; a Firestore error caches nothing, so a transient blip cannot
  lock a member out for a minute.
- **D12. Firestore read throws ⇒ deny, with 503 and never a 401.** Fail closed
  means no data is served and Gemini is not called; it must not mean "you are
  signed out", because a 401 makes the client wipe its cached session and
  (from `syncEngine`) report `signedOut`. So: membership **denied** ⇒ 401;
  membership **unknown** ⇒ 503. `authSession` returns 503 without clearing the
  cookie, which `fetchSession` already degrades to `offline` with the cached
  user. The owner path never touches Firestore, so **the owner keeps working
  when Firestore is down**. In the OAuth callback, a Firestore error renders a
  503 "sign-in is temporarily unavailable" page rather than the
  invitation-only 403 — a member must not be told they are uninvited because a
  read failed.
- **D13. No free-text message field on the request.** The form posts the token
  and nothing else. Zero new abuse surface, zero new PII. The bounded
  200-character note is recorded in Out of scope.
- **D14. No email to the requester in v1, on approval or otherwise.** Resend's
  sandbox sender can only deliver to the Resend account's own verified
  address; reaching an arbitrary requester needs `kyrylo.lol` domain
  verification with DNS records. The 403 and result copy therefore say: your
  request was recorded, and you can try signing in again once it is approved.
  The alternative is recorded in Out of scope.
- **D15. Mail is optional and degradable.** `RESEND_API_KEY` unset ⇒
  `sendMail` logs once and returns `false`; the request is still recorded and
  still appears in `/admin`. This keeps `npm run dev:api` working with no
  Resend account and makes a Resend outage non-fatal. The result page never
  claims an email was sent.
- **D16. Dedupe, throttle and cap.** Per identity (`sub`): one document,
  upserted. A second press within **24 h** of the last notification records
  `lastRequestAt` and sends **no** email. After `requestCount >= 5` no further
  notification is ever sent for that identity. `status: 'denied'` never
  notifies again and shows the same neutral copy as a fresh request (no
  "you were rejected" disclosure, no inbox vector). Globally,
  `accessRequestMeta/notifications` caps notifications at **20 per UTC day**;
  over the cap the request is recorded and the email is skipped. Every one of
  these is a pure function, unit tested.

## Ordering against `deploy-and-end-state.md`

**Independent, not blocked — with one verification caveat.** All repo work and
all local verification in this plan work regardless of the consent screen's
publication state. The caveat is step 13: to exercise the 403 by hand you need
a **second Google account that can complete consent**. If the consent screen is
**In production**, any Google account can; if it is still **Testing**, add that
second account to the OAuth client's **test users** list (a console change, no
redeploy, reversible) — do not work around it in code.

Where it sits: run this plan **after** `deploy-and-end-state` steps 5–7
(two-device sync, installed iOS PWA sign-in, migration gate + Deploy record).
Those steps validate the single-account sync path that this plan then widens to
more people, and a production deploy in the middle of them muddies their
results. That is a sequencing preference, not a technical dependency.

See Open Questions: that plan file is **not in the working tree** and the only
copy in git shows its steps 1–4 already ticked, which contradicts the brief.

## Files to change

| File | Change |
| --- | --- |
| `server/env.ts` | New getters: `resendApiKey()` (`null` when unset), `mailFrom()`, `ownerNotifyEmail()`. |
| `server/mail.ts` | **New.** `sendMail({subject, text})` → Resend `POST https://api.resend.com/emails`, bearer token, 10 s `AbortSignal.timeout`, returns `boolean`. Logs status codes only, never the key or the body. |
| `server/members.ts` | **New.** Firestore accessors for `members/`, `accessRequests/`, `accessRequestMeta/` + the pure decisions `nextRequestState`, `shouldNotify`, `nextNotificationCounter`, `decisionTransition`. |
| `server/members.test.ts` | **New.** Pure only: request state machine, 24 h renotify, `requestCount` cap, denied-never-notifies, daily counter rollover, decision transitions. |
| `server/membership.ts` | **New.** Pure `accessDecision({email, emailVerified, allowedRaw, member})` → `'owner'|'member'|'denied'`; async `requireMember(req)`, `requireOwner(req)`, `withMembership(handler)`; the 60 s TTL cache with `clearMembershipCache(sub)`. |
| `server/membership.test.ts` | **New.** Pure `accessDecision` table (blank list, unverified email, blank email, revoked member, owner-when-Firestore-absent) + cache TTL with an injected clock + the architecture-lock assertions. |
| `server/session.ts` | Add `signAccessRequestTx`/`verifyAccessRequestTx` (`v:'accessreq'`, 10 min). Remove the `isAllowed` call and the `allowedEmails` import from `readSession` (it becomes cryptographic-only, with a doc comment saying so). **Delete `sessionFrom`.** |
| `server/session.test.ts` | Replace the "unusable when allowlist misses" case with an `ok`-regardless-of-email case plus a comment pointing at `requireMember`; drop the `sessionFrom` import; add accessreq round-trip, expiry, and cross-family rejection. |
| `server/auth.ts` | Callback: `isAllowed` → `await accessAllows(...)`; 503 page on a Firestore error; 403 page gains the request form. `authSession`: membership re-check (401/503/clear-cookie) and `isOwner` in the body. |
| `server/access.ts` | **New.** `accessRequestPost` — 4 KB body cap, `application/x-www-form-urlencoded` parse, token verify, `recordAccessRequest`, `sendMail`, and the three server-rendered result pages. |
| `server/admin.ts` | **New.** `adminRequestsGet`, `adminDecisionPost` — both `requireOwner`, JSON only, 4 KB body cap, `sub` pattern validation, self-demotion refused. |
| `server/sync.ts` | `sessionFrom` → `requireMember` in `syncPull` and `syncPush`. |
| `server/photos.ts` | `sessionFrom` → `requireMember` in `photosGet` and `photosPost`. |
| `scripts/server.ts` | Route table `+= POST /api/access-request`, `GET /api/admin/requests`, `POST /api/admin/decision`; wrap `chatPost`/`importPost` in the membership gate and pass `{ authorizedSub }`. |
| `api/chat.ts` | Optional `ctx?: { authorizedSub?: string }` second parameter; rewritten sync comment. Gemini request shape, `0x1E` framing and `maxDuration` untouched. |
| `api/import.ts` | Same two edits. Extraction, SSRF posture and prompts untouched. |
| `api/sessionGate.test.ts` | Existing vectors unchanged; one added assertion. |
| `src/lib/session.ts` | `SessionUser` gains optional `isOwner?: boolean`. |
| `src/lib/adminApi.ts` | **New.** `fetchAccessRequests()`, `decideAccessRequest({sub, action})`. `credentials: 'same-origin'`, 401 → `invalidateSession()` + the standard message, 403 → "This account can't manage invitations." No Dexie import. |
| `src/screens/Admin.tsx` | **New.** Owner-only screen: Pending / Approved / Declined, load on mount, explicit Refresh. |
| `src/App.tsx` | `<Route path="/admin" element={<Admin />} />`. |
| `src/screens/Settings.tsx` | An **Invitations** link, rendered only when `user.isOwner`. |
| `.env.example` | `RESEND_API_KEY`, `MAIL_FROM`, `OWNER_NOTIFY_EMAIL`; the `ALLOWED_EMAILS`-is-also-admin warning. No `VITE_` prefixes. |
| `scripts/deploy.sh` | `resolve_optional_secret RESEND_API_KEY`; `MAIL_FROM` + `OWNER_NOTIFY_EMAIL` into the `fixed` map; all three into the `keys` array with `RESEND_API_KEY` marked optional. |
| `README.md` | Invitation flow, `/admin`, env table, the admin warning. |
| `AGENTS.md` | Auth section: dynamic membership, `sub` keying, the 60 s revocation bound, 401-vs-503 rule, the `api/` argument bypass, new env vars, plan table row. |
| `public/privacy.html` | Access-request data, Resend as subprocessor, retention and deletion of pending/denied requests; rewrite the "Access" section. |
| `public/terms.html` | "What Sous is" — invitation **by request and approval**. |
| `docs/plans/invitation-flow.md` | Tick Status as steps land. |

Explicitly **not** changed: `src/lib/db.ts` (no Dexie version, no table —
`/admin` is owner-only and online-only), `src/lib/types.ts`,
`src/lib/outbox.ts`, `src/lib/recipeStore.ts`, `src/lib/syncEngine.ts`,
`src/lib/cacheOwner.ts` (a new member's empty library is existing behaviour:
`ownerUid` absent + empty rows ⇒ claim + pull), `server/store.ts`,
`vite.config.ts` (the SW denylist is already correct), `vercel.json`, Vercel
env, the Dockerfile, `package.json` (no new dependency, `name` unchanged).

## Workback

Read bottom-to-top. Each line is blocked by everything under it.

```
14. Production deploy + live verification            [operational]
    └─ 13. Local end-to-end by hand, two accounts
        └─ 12. privacy.html / terms.html             [ui]
            └─ 11. .env.example, deploy.sh, README, AGENTS.md
                └─ 10. /admin screen + Settings entry [ui]
                    └─ 9. src/lib/adminApi.ts + isOwner
                        └─ 8. Admin API (owner-only)
                            └─ 7. 403 + result page markup   [ui]
                                └─ 6. Token + POST /api/access-request
                                    └─ 5. Chat/import gate (the landmine)
                                        └─ 4. Cut protected routes to the gate
                                            └─ 3. server/membership.ts
                                                └─ 2. server/members.ts
                                                    └─ 1. server/mail.ts + env
```

Steps 7, 10 and 12 are `[ui]`. Everything else is `[core]`. Step 14 is
operational `[core]`.

## Assumptions

- Node ≥ 22.18, native TS stripping. `erasableSyntaxOnly` is on for
  `tsconfig.node.json` (`scripts`, `server`, `vite.config.ts`) and
  `tsconfig.api.json` (`api`): **no enums, no constructor parameter
  properties**. Every status/state value is a string union.
- `npm run build` (`tsc -b && vite build`) is the only type gate on `server/`
  and `api/`. `npm run dev:api` does not watch `server/` — restart it after
  every step that touches `server/` or `scripts/server.ts`.
- `npm test` is Vitest over `src/` and `server/` (and `api/sessionGate.test.ts`),
  default node environment, **pure logic only**. Do not add fake-indexeddb, a
  Firestore emulator, a GCS mock, or a DOM testing library.
- Firestore Native `(default)`, `europe-west1`, no `FIRESTORE_DATABASE_ID`.
  New top-level collections need no new IAM and no composite index.
- Dev talks to **real production Firestore** via local ADC. See Risks for the
  blast radius and the `FIRESTORE_EMULATOR_HOST` opt-out.
- Google identity only: `openid`, `userinfo.email`, `userinfo.profile`. No new
  scopes, no refresh tokens, no Auth.js. `SESSION_SECRET` is not rotated. The
  callback keeps building a `Response` with a `Location` header and never uses
  `Response.redirect()`. Sign-in stays `<a href={signInHref(...)}>`.
- Local redirect URI `http://localhost:5173/api/auth/callback/google`;
  production `https://sous.kyrylo.lol/api/auth/callback/google`. Vite is bound
  to IPv6 `[::1]` on this machine — use `http://localhost:5173`, not
  `127.0.0.1`.
- `gcloud` is `C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`,
  not on PATH; always `--project=cooking-assistant-508423`, service `sous`,
  region `europe-west1`. Docker is not installed locally; image builds run on
  Cloud Build.
- A Resend account exists (or is created in step 1) with an API key. Until
  `kyrylo.lol` is domain-verified there, `MAIL_FROM` is the sandbox sender and
  delivery only works to the Resend account's own verified address — which is
  the owner, which is all v1 needs.

## Steps

### 1. [core] `server/mail.ts` and the three env getters

Add to `server/env.ts`, matching the existing style (`envError` for required,
`null` for optional):

- `resendApiKey(): string | null` — trimmed, `null` when unset or blank.
- `mailFrom(): string` — trimmed; `throw envError('MAIL_FROM')` when blank.
- `ownerNotifyEmail(): string` — trimmed; `throw envError('OWNER_NOTIFY_EMAIL')`
  when blank.

`server/mail.ts`:

```
export interface MailMessage { subject: string; text: string }
export async function sendMail(msg: MailMessage): Promise<boolean>
```

`sendMail` returns `false` without throwing when `resendApiKey()` is `null`
(log once per process: "RESEND_API_KEY unset — access-request notifications
are disabled"), and when `mailFrom()`/`ownerNotifyEmail()` throw. Otherwise it
POSTs `{ from, to: [ownerNotifyEmail()], subject, text }` as JSON to
`https://api.resend.com/emails` with `Authorization: Bearer …`,
`signal: AbortSignal.timeout(10_000)`, and returns `response.ok`. On a non-2xx
it logs the **status code only**. It never logs the key, the body, or the
response body. Plain-text body only — no HTML, no links, and per **D3** no
approve link or token of any kind.

**Verify:** `npm run build` clean. With no key set, a one-line node script
importing `sendMail` returns `false` and prints the disabled notice.
`Select-String -Path server/mail.ts -Pattern 'RESEND_API_KEY'` shows only the
`env.ts` getter call and the notice text — never a value interpolated into a
log or a URL.

**Failure handling:** a 403 from Resend means the sender is not verified for
that account — fix `MAIL_FROM`, do not add a dependency or switch providers
inside this step. A hang means the timeout is missing.

### 2. [core] `server/members.ts` — collections and the pure decisions

Pure, exported, unit-tested (no Firestore, no clock of its own — `now` is a
parameter):

- `nextRequestState(existing, identity, now)` → `{ doc, notify: boolean }`
  implementing **D16**: absent ⇒ create `pending` + notify; `pending` and
  `now - lastNotifiedAt >= 24 h` and `requestCount < 5` ⇒ bump + notify;
  `pending` otherwise ⇒ record `lastRequestAt`, no notify; `approved` ⇒ record
  only, no notify; `denied` ⇒ record only, **never** notify.
- `nextNotificationCounter(counter, now)` → `{ counter, allowed: boolean }` —
  UTC-day rollover, cap 20.
- `decisionTransition(existing, action, ownerSub, now)` for
  `'approve'|'deny'|'revoke'` → the `members/{sub}` and `accessRequests/{sub}`
  bodies, or a refusal reason (`'unknown-request'`, `'self'`).
- `isValidSubParam(raw)` → `/^[A-Za-z0-9_.-]{1,128}$/`.

Async accessors on `getStoreFirestore()` from `server/store.ts` (which is not
modified):

- `readMember(sub)` → `{ status } | null`; throws on a Firestore error.
- `recordAccessRequest(identity, now)` → one `runTransaction` reading
  `accessRequests/{sub}` **and** `accessRequestMeta/notifications`, applying
  both pure decisions, writing both docs, and returning
  `{ outcome: 'recorded'|'already-pending'|'already-approved'|'recorded-quiet',
  notify: boolean }`.
- `listAccessRequests()` → `accessRequests` `.limit(200)` and `members`
  `.limit(200)`, one `.get()` each, merged and split into pending / approved /
  denied in memory, each sorted by `createdAt` descending, plus
  `truncated: boolean`.
- `applyDecision(sub, action, ownerSub, now)` → one `runTransaction`.

No `where` + `orderBy` on different fields anywhere, so no composite index.

**Verify:** `npm test` — the new `server/members.test.ts` covers every branch
of all four pure functions, including a second press at 23 h 59 m (no notify)
and at 24 h 01 m (notify), `requestCount = 5` (no notify ever again), a denied
identity pressing twice, the counter rolling over at UTC midnight, and
`decisionTransition` refusing `ownerSub === sub`. `npm run build` clean.

**Failure handling:** if Firestore returns `FAILED_PRECONDITION` asking for an
index, a query used `where` + `orderBy` on different fields — drop the
`orderBy` and sort in memory; do not create an index.

### 3. [core] `server/membership.ts` — the gate, the cache, the architecture lock

Pure:

```
accessDecision(input: {
  email: string; emailVerified: boolean;
  allowedRaw: string; member: { status: string } | null;
}): 'owner' | 'member' | 'denied'
```

Order: `isAllowed(email, emailVerified, allowedRaw)` ⇒ `'owner'`; else
`emailVerified !== true` ⇒ `'denied'`; else `member?.status === 'active'` ⇒
`'member'`; else `'denied'`. The owner branch is first and deliberately does
**not** consult `member`, which is what keeps the owner working when Firestore
is down (**D12**).

Async:

- `requireMember(req)` → `{ kind: 'ok'; sub; email; isOwner }` |
  `{ kind: 'denied' }` | `{ kind: 'unknown' }`. Calls `readSession(req)`; on
  `absent`/`unusable` ⇒ `denied`. Computes `accessDecision` with
  `emailVerified: true` — the documented invariant being that a `sous_session`
  cookie is only ever minted after the callback verified `email_verified ===
  true`. `'owner'` short-circuits before any Firestore read. Otherwise consults
  the cache, then `readMember(sub)`; a throw ⇒ `unknown` and **nothing is
  cached**.
- `requireOwner(req)` → `'ok' | 'unauthenticated' | 'forbidden'`. Session
  only, `isAllowed` only, never Firestore, never the cache.
- `withMembership(handler)` → wraps a `(req, ctx?) => Promise<Response>` into
  a `(req) => Promise<Response>`: `denied` ⇒ `401 'Unauthorized'`,
  `unknown` ⇒ `503`, else `handler(req, { authorizedSub: access.sub })`.
- `clearMembershipCache(sub)`.
- Response helpers so every protected route returns identical bodies:
  `membershipUnauthorized()` (401 JSON `{error:'Unauthorized'}`),
  `membershipUnavailable()` (503 JSON `{error:'Membership unavailable'}`),
  both `Cache-Control: no-store`.

Cache: module-level `Map<string, { active: boolean; at: number }>`, TTL
60_000 ms, `map.clear()` when `size > 500`. The TTL is exercised through an
injected `now` parameter on the internal lookup so it is testable without
timers.

`server/membership.test.ts` also carries the **architecture lock**, in the
spirit of `src/lib/recipeStore.test.ts`: read the sources under
`server/` and `scripts/server.ts` with `node:fs` (resolved from
`import.meta.url`, not `process.cwd()`) and assert

1. `readSession` is referenced only in `server/session.ts`,
   `server/membership.ts` and `server/auth.ts`;
2. the identifier `sessionFrom` appears nowhere in the repo's `server/` or
   `scripts/`;
3. `api/chat.ts` and `api/import.ts` contain no `@google-cloud` substring.

Assertion 3 is the guard for "no Firestore in a Vercel function bundle".

**Verify:** `npm test` — the `accessDecision` table covers blank
`ALLOWED_EMAILS` (⇒ `denied`, never allow-all), whitespace-only
`ALLOWED_EMAILS`, `emailVerified: false` with an active member (⇒ `denied`),
blank email, `member.status: 'revoked'`, `member: null` for a non-owner, and
owner-with-`member: null`. Cache: two lookups inside 60 s hit once; at 60 001
ms it re-reads; an error path leaves the map empty. The three lock assertions
pass. `npm run build` clean.

**Failure handling:** if the lock test fails on assertion 1 after a later step,
that step added a route that skipped the gate — fix the route, do not widen the
allow-list in the test.

### 4. [core] Cut every protected route over to the gate

In `server/session.ts`: add `signAccessRequestTx` / `verifyAccessRequestTx`
(**D8**), remove the `isAllowed` call and the now-unused `allowedEmails`
import from `readSession`, replace its doc comment with an explicit "this is a
cryptographic check, **not** an authorization decision — protected routes must
call `requireMember`", and **delete `sessionFrom`**.

Then, in one pass so nothing is left unguarded:

- `server/sync.ts` `syncPull`, `syncPush`: `requireMember`; `denied` ⇒ the
  existing 401 body, `unknown` ⇒ 503. `uid` still comes only from the session.
- `server/photos.ts` `photosGet`, `photosPost`: same, keeping the existing
  `photoBucket() === null` 503 ahead of it.
- `server/auth.ts` `authCallbackGoogle`: replace `isAllowed(...)` with the
  owner-or-member check. Owner ⇒ unchanged path. Member ⇒ `upsertUser` + cookie
  exactly as today. Denied ⇒ the 403 page (markup in step 7). Firestore threw
  ⇒ a **503** page, not the 403 (**D12**). `upsertUser` must still run only
  **after** a positive decision, so a refused identity never creates
  `users/{sub}`. Every branch keeps going through `respond()` so `sous_oauth`
  is always cleared and `Response.redirect()` is never used.
- `server/auth.ts` `authSession`: after `readSession` is `ok`, re-check
  membership. `denied` ⇒ clear the session cookie and return
  `{user: null}` (this is what signs a revoked member out). `unknown` ⇒ **503,
  cookie untouched** (the client degrades to `offline`). `ok` ⇒
  `{user: {sub, email, isOwner}}`, keeping the existing `shouldRefresh`
  re-issue.
- `server/session.test.ts`: drop the `sessionFrom` import; turn "unusable when
  allowlist misses" into "ok for any valid cookie — membership is enforced by
  `requireMember`" with a comment naming the reason; add accessreq
  round-trip, expiry-rejection, and the two cross-family rejections
  (`verifySession` rejects an accessreq token; `verifyAccessRequestTx` rejects
  a session token and an oauth token).

**Verify:** `npm test`, `npm run build`. Restart `dev:api`. Signed in as the
owner at `http://localhost:5173`: library, a recipe, chat, import and Sync now
all work; `/api/auth/session` returns `isOwner: true`. Then, with
`FIRESTORE_EMULATOR_HOST=localhost:1` set (nothing listening) and `dev:api`
restarted, `GET /api/auth/session` as the owner still returns the user — proof
the owner path never touches Firestore.

**Failure handling:** everything 401s ⇒ `requireMember` is treating `unknown`
as `denied`; check the 503 branch. Sync starts signing the user out on a
Firestore blip ⇒ same bug (401 instead of 503). The whole app works for a
random Google account ⇒ `readSession` lost its allowlist check **and** a route
was not cut over; the architecture-lock test should have caught it.

### 5. [core] The chat/import membership gate (the landmine)

`api/chat.ts` and `api/import.ts`: change the signature to
`export async function POST(req: Request, ctx?: { authorizedSub?: string })`
and the first lines to

```
const authorized =
  typeof ctx?.authorizedSub === 'string' && ctx.authorizedSub !== ''
    ? ctx.authorizedSub
    : sessionSub(req);
if (authorized === null) {
  return new Response('Unauthorized', { status: 401 });
}
```

Nothing else in either file changes — not the Gemini request shape, not the
`0x1E` framing, not `maxDuration = 60`, not `RECIPE_SCHEMA`, not the inline
`sessionSub`. Rewrite the leading NOTE comment in both files per **D6**.

`scripts/server.ts`: import `withMembership` from `../server/membership.ts`
and register `withMembership(chatPost)` / `withMembership(importPost)` in
`apiRoutes` instead of the bare handlers. The `ApiHandler` type stays
`(req: Request) => Promise<Response>`.

`api/sessionGate.test.ts`: leave all seven vectors as they are and add one
assertion that a request carrying an `x-sous-uid`-style header (or any header)
still yields `null` from `sessionSub` — documenting that the Cloud Run bypass
is an argument, not anything a client can send.

**Verify:** `npm test` (all previously passing `sessionGate` vectors still
green). `npm run build`. Restart `dev:api`. As the owner, one chat turn streams
and one URL import works. `node -e "fetch('http://localhost:3001/api/chat',{method:'POST',headers:{'content-type':'application/json','x-sous-uid':'1'},body:'{}'}).then(r=>console.log(r.status))"`
⇒ **401**. Step 13 proves an approved non-owner member also gets chat and
import; this step's own gate check is that a **signed-out** request is 401 and
an owner request streams. Confirm the chat response still has no
`content-length` and no `content-encoding`.

**Failure handling:** a member gets 401 on chat while sync works ⇒ the wrapper
is registered but the handler is still running its inline `sessionSub` (the
`authorizedSub` argument is not being passed, or is empty). Chat 200s with no
cookie at all ⇒ the wrapper is missing from the route table, or
`authorizedSub` is being read from a header — revert immediately, that is an
open Gemini proxy.

### 6. [core] The access-request token and `POST /api/access-request`

`server/access.ts` — `accessRequestPost(req)`:

1. Reject `Content-Length > 4096` with 413 and a body larger than 4096 bytes
   after reading with 413.
2. Require `Content-Type: application/x-www-form-urlencoded`; parse with
   `new URLSearchParams(await req.text())` (no `formData()`, no multipart).
3. `verifyAccessRequestTx(params.get('t') ?? '', Date.now())`; `null` ⇒ the
   "link expired" page, **400**.
4. `recordAccessRequest({ sub, email, name }, Date.now())`.
5. If it returns `notify: true`, `await sendMail(...)` with a plain-text body
   naming the email, the display name, the UTC timestamp and the sentence
   "Approve or decline at https://sous.kyrylo.lol/admin" — a plain URL to the
   owner-authenticated screen, no token, no query string (**D3**).
6. Reply with a self-contained HTML page (markup in step 7), **200** for
   recorded / already-pending / denied (identical copy, **D16**) and 200 with
   the "you already have access" copy for `already-approved`.
7. A Firestore error ⇒ a **503** page telling the person to try again later.
   Never surfaces the underlying error.

Mount `{ method: 'POST', path: '/api/access-request', handler:
accessRequestPost }` in `scripts/server.ts`. A GET to it gets the existing 405
from `matchApiRoute`, which is correct — there is nothing to see.

**Verify:** `npm test`, `npm run build`, restart `dev:api`. With a token minted
in a throwaway node script from the same `SESSION_SECRET`:
`curl -X POST` with a valid token ⇒ 200 recorded, and one `accessRequests/{sub}`
doc appears in the Firestore console; immediately again ⇒ 200 with no new
email (check `lastNotifiedAt` did not move); with a garbage token ⇒ 400; with a
token whose `exp` is in the past ⇒ 400; with a **session** token in the `t`
field ⇒ 400; with a 5 KB body ⇒ 413; `GET /api/access-request` ⇒ 405.

**Failure handling:** a session token accepted as a request token ⇒
`verifyAccessRequestTx` is not checking `v === 'accessreq'`; stop and fix
before anything else. Two emails for two fast presses ⇒ the transaction is not
reading and writing `lastNotifiedAt` atomically.

### 7. [ui] The invitation-only page and the request-result pages

Server-rendered, self-contained HTML in `server/access.ts` (and the 403/503
bodies in `server/auth.ts`), reusing the visual language already established by
`public/privacy.html`: one inline `<style>` block, `color-scheme: light dark`,
`max-width: 42rem`, system font stack, the same `#fafaf9`/`#1c1917` and
`#1c1917`/`#e7e5e4` pairs under `prefers-color-scheme`. No Tailwind, no
bundled CSS, no external requests, no inline `<script>`.

Pages, all with `<meta name="viewport">` and an `<html lang="en">`:

- **403 invitation-only.** Heading "Sous is invitation-only". One sentence
  naming the signed-in address so the person knows which account they used.
  The `<form method="POST" action="/api/access-request">` with
  `<input type="hidden" name="t" value="…">` and a single submit button
  labelled **Request access**. Below it, per **D14**: their request goes to the
  owner, nobody is emailed back, and they can try signing in again once it is
  approved. Footer links to `/privacy` and `/terms`. When the token could not
  be minted, render the same page **without** the form rather than a broken
  button.
- **200 recorded.** "Request sent" / "Your request was recorded." No claim that
  an email was delivered (**D15**). The same copy is used for a repeat press
  and for a previously declined identity (**D16**) — no disclosure either way.
- **200 already a member.** "You already have access — try signing in again."
- **400 expired.** "That link has expired. Sign in again to request access."
  with a link to `/`.
- **503.** "Sign-in is temporarily unavailable. Try again in a few minutes."
  Used by both the callback's Firestore-error branch and the request POST's.

Escape every interpolated value (`email`, `name`, the token) for HTML
attribute and text contexts — a display name comes from Google and is not
trusted markup. One small `escapeHtml` helper in `server/access.ts`, exported
and unit tested with `<`, `>`, `&`, `"`, `'`.

**Verify:** `npm test` (the `escapeHtml` vectors), then by hand in the browser
at `http://localhost:5173` with a **second, non-listed** Google account: the
403 renders legibly in both light and dark, at 375 px and at desktop width, the
button is a real form submit (works with JavaScript disabled), and the result
page renders. Then re-press through browser Back → the repeat copy. Check a
display name containing `<b>` renders as text, not markup. Confirm the 403 and
the result page are **not** intercepted by the service worker (DevTools →
Application → Service Workers, and the Network entry shows no "(from
ServiceWorker)").

**Failure handling:** the SPA shell appears instead of these pages ⇒ the path
is not under `/api/` or the route table was bypassed. A display name renders as
HTML ⇒ escaping is missing; fix before step 14.

### 8. [core] Admin API, owner-only and enforced server-side

`server/admin.ts`:

- `GET /api/admin/requests` → `requireOwner`; `unauthenticated` ⇒ 401,
  `forbidden` ⇒ **403** (so an approved member who guesses the URL gets a
  clear, non-leaking refusal), then `listAccessRequests()` ⇒
  `{ pending, approved, denied, truncated }` with
  `Cache-Control: no-store`. A Firestore error ⇒ 503.
- `POST /api/admin/decision` → `requireOwner` first, before reading the body.
  Require `Content-Type: application/json` (**D10**), cap the body at 4 KB,
  parse `{ sub, action }`, validate `sub` with `isValidSubParam` and `action`
  against `'approve'|'deny'|'revoke'`, refuse `sub === session.sub` with 409
  `'self'`, then `applyDecision(...)`, then `clearMembershipCache(sub)` on this
  instance, then return the refreshed lists so the screen needs no second
  round-trip. `'unknown-request'` ⇒ 404. Firestore error ⇒ 503.

Mount both exact paths in `scripts/server.ts`'s `apiRoutes` — no new prefix
matcher, no path parameters.

**Verify:** `npm test`, `npm run build`, restart `dev:api`. As the owner:
`GET /api/admin/requests` ⇒ 200 with the step-6 request in `pending`;
`POST /api/admin/decision` with `{sub, action:'approve'}` ⇒ 200 and a
`members/{sub}` doc with `status: 'active'`. With **no** cookie ⇒ 401 on both.
With `action: 'nope'` ⇒ 400; with a 5 KB body ⇒ 413; with
`Content-Type: text/plain` ⇒ 415; with the owner's own `sub` ⇒ 409.
`GET /api/admin/decision` ⇒ 405. Step 13 covers the member-gets-403 case with
a real second session.

**Failure handling:** a non-owner reaching 200 ⇒ `requireOwner` is being
called after the body read or not at all; this is the privilege-escalation
case, stop and fix. 403 for the owner ⇒ `ALLOWED_EMAILS` on this process does
not contain the owner's address.

### 9. [core] `src/lib/adminApi.ts` and `isOwner` on the session

`src/lib/adminApi.ts`, modelled on `src/lib/importApi.ts` — plain `fetch`,
`credentials: 'same-origin'`, `cache: 'no-store'`, **no Dexie import, no
`db`**:

```
export interface AccessRequestEntry {
  sub: string; email: string; name?: string;
  requestedAt: number; decidedAt?: number; requestCount: number;
}
export interface AccessRequestLists {
  pending: AccessRequestEntry[];
  approved: AccessRequestEntry[];
  denied: AccessRequestEntry[];
  truncated: boolean;
}
export async function fetchAccessRequests(): Promise<AccessRequestLists>
export async function decideAccessRequest(params: {
  sub: string; action: 'approve' | 'deny' | 'revoke';
}): Promise<AccessRequestLists>
```

401 ⇒ `invalidateSession()` then throw `'Please sign in again — your session
expired.'` (the exact existing wording). 403 ⇒ throw `"This account can't
manage invitations."` 503 ⇒ throw `"Invitations are temporarily
unavailable."` Anything else ⇒ throw with the status, like `importApi` does.

`src/lib/session.ts`: `SessionUser` gains `isOwner?: boolean`.
`readCachedUser` keeps validating only `sub` and `email` as strings, so an old
cache entry without the flag stays usable. Note in a comment that a stale
cached `isOwner` can only reveal a **link**; every admin route is enforced
server-side.

**Verify:** `npm test`, `npm run build`.
`Select-String -Path src/lib/adminApi.ts -Pattern "from './db'|dexie"` prints
nothing. `/api/auth/session` in DevTools shows `isOwner: true` for the owner.

**Failure handling:** a type error in `src/` from `isOwner` ⇒ it was added to
the wrong interface; it belongs to `SessionUser` and must not go near
`Recipe`, `ChatMessage` or `CookStateRow`, whose key sets are locked by
`src/lib/recipeStore.test.ts`.

### 10. [ui] `/admin` screen and the Settings entry point

`src/screens/Admin.tsx`, following `src/screens/Settings.tsx`'s structure and
`src/lib/uiClasses.ts` tokens (`mx-auto max-w-xl px-4 pb-24`, a `backLink`
"← Library" header, `h2 mt-8 text-lg font-semibold` section headings,
`primaryBtn` / `secondaryBtn` / `dangerBtn`, `text-ink-muted` for supporting
copy, `text-danger` for errors):

- Loads once on mount through `fetchAccessRequests()`; an explicit **Refresh**
  button; **no polling, no timer, no Firestore listener, no WebSocket**, and
  no Dexie table — the screen is owner-only and online-only, so it keeps its
  data in React state and shows nothing when offline beyond an error line.
- Three sections: **Pending** (Approve / Decline), **Approved** (Remove
  access), **Declined** (Approve). Each row shows the display name when
  present, the email, and a relative timestamp in the `Settings.tsx`
  "Synced N min ago" idiom. Buttons disable while a decision is in flight and
  the lists come back from the POST response.
- Empty states in plain sentences, e.g. "No pending requests." Not an icon,
  not a spinner-forever.
- Errors render as one `text-danger` line from the thrown message, including
  the 403 case, so a non-owner who navigates to `/admin` directly sees "This
  account can't manage invitations." and nothing else. The screen must render
  no request data before a successful response.
- A short paragraph under the heading stating what approving does: the person
  gets their own empty library, and Remove access takes effect within a
  minute (**D11**).

`src/App.tsx`: add `<Route path="/admin" element={<Admin />} />`. The last
path segment has no `.`, so the SPA fallback in `scripts/server.ts` serves
`index.html`; the SW `navigateFallbackDenylist` is deliberately left alone so
`/admin` is served from the app shell.

`src/screens/Settings.tsx`: inside the existing signed-in Account block, an
**Invitations** link (`<Link to="/admin">`) rendered only when
`user.isOwner === true`, with one `text-ink-muted` line of explanation. No
other Settings copy changes in this step.

**Verify:** `npm run build`, then by hand at `http://localhost:5173` signed in
as the owner: Settings shows Invitations; `/admin` lists the step-6 request;
Approve moves it to Approved without a reload; Remove access moves it back;
Refresh re-fetches. Check 375 px and desktop, dark and light. Reload directly
at `/admin` (SPA fallback + SW), and with the API stopped confirm the error
line appears and no request data is rendered. Confirm Library, RecipeView and
Settings are unaffected.

**Failure handling:** `/admin` 404s on a hard reload in production-like serving
⇒ the SPA fallback rule or the SW denylist was changed; revert the denylist.
The Invitations link showing for a member ⇒ `isOwner` is being read from the
localStorage cache without the server flag; harmless (the route 403s) but fix
the condition.

### 11. [core] `.env.example`, `scripts/deploy.sh`, `README.md`, `AGENTS.md`

`.env.example` gains, with no `VITE_` prefix:

```
# Optional. Resend API key for access-request notifications. Unset disables
# the email; requests are still recorded and still show in /admin.
RESEND_API_KEY=

# Sender for those notifications. Must be verified in Resend. Until
# kyrylo.lol is domain-verified, the sandbox sender only delivers to the
# Resend account's own address.
MAIL_FROM=onboarding@resend.dev

# Where access-request notifications go.
OWNER_NOTIFY_EMAIL=chernyshov.k@gmail.com
```

and, on `ALLOWED_EMAILS`: **every address here is an owner/admin** and can
approve or remove members at `/admin`; approve ordinary people through that
screen, not by editing this variable.

`scripts/deploy.sh` — both places, or the deploy is an outage:

1. Add `resolve_optional_secret RESEND_API_KEY "RESEND_API_KEY (blank to
   disable notification email)"` — a copy of `resolve_secret` that does **not**
   `die` on an empty value. `resolve_secret` and `resolve_session_secret` are
   otherwise untouched; `SESSION_SECRET` still may not be regenerated on a
   failed describe.
2. In the single-line `node -e`: add `MAIL_FROM` and `OWNER_NOTIFY_EMAIL` to
   the `fixed` map (they are not secrets), add all three names to the `keys`
   array, and introduce `const optional=new Set(["RESEND_API_KEY"])` so an
   empty optional value is **omitted from the YAML** instead of
   `process.exit(2)`. Omitting it is the correct way to delete it from the
   service. Still `--env-vars-file`, never `--set-env-vars`, never a secret on
   the command line.

`README.md`: how the invitation flow works end to end, the `/admin` screen, the
new env keys in the existing table, and the `ALLOWED_EMAILS`-is-admin warning.

`AGENTS.md`: in **Auth**, that membership is now `ALLOWED_EMAILS` (owner, fail-closed) **plus**
Firestore `members/{sub}`; that the key is `sub`; that protected routes call
`requireMember` and `sessionFrom` no longer exists; the **401 = denied / 503 =
unknown** rule; the **60-second** revocation bound; and that `api/chat.ts` /
`api/import.ts` accept an `authorizedSub` argument on Cloud Run while their
inline `sessionSub` remains the Vercel gate. In **Cloud and deploy**, the three
new env vars. In **Plans**, a row for this file.

**Verify:** `bash -n scripts/deploy.sh` clean.
`node -e` the env-map line in isolation with `RESEND_API_KEY` unset and
confirm it writes a YAML file containing the other nine keys and no
`RESEND_API_KEY` line; with it set, ten lines. Diff `.env.example`'s key list
against the keys present in `.env.local` **without printing any value**.
`Select-String -Path scripts/deploy.sh -Pattern 'set-env-vars'` prints
nothing. Both dev servers still boot from the existing `.env.local`.

**Failure handling:** if the `keys` array and the `resolve_*` calls disagree,
the next deploy either dies at `process.exit(2)` or silently drops a variable
— re-read both places before step 14. If `node -e` prints nothing under Git
Bash, it was written across multiple lines; it must stay one line.

### 12. [ui] Privacy and terms

`public/privacy.html` — keep the existing document structure, inline styles and
tone; bump "Last updated":

- **What is stored** gains a paragraph: when someone who is not a member
  completes Google sign-in and presses Request access, Sous stores their email
  address, Google display name, Google account id (`sub`) and request
  timestamps in Firestore (`europe-west1`) so the owner can decide. No recipe
  library and no `users/{sub}` document is created for a person who is not
  admitted.
- **Third parties** gains Resend as the email subprocessor for the owner's
  notification, naming what is in that email (the requester's email address
  and display name) and that no one-click approval link is included.
- **Retention and deletion** gains: pending requests are kept until decided;
  declined requests are kept for up to 12 months so a repeat request does not
  re-notify; either can be deleted sooner on request to the contact address.
  There is no automated purge job.
- **Access** is rewritten: Sous is invitation-only; sign-in is limited to
  allow-listed addresses and to accounts the owner has approved from a request;
  requesting access does not grant it.

`public/terms.html` — **What Sous is**: invitation-only **by request and
approval**, with approval at the owner's discretion and access removable at any
time. Leave Accuracy, Acceptable use, Ending it and Liability alone; bump
"Last updated".

**Verify:** `npm run build`, then open `/privacy` and `/terms` on the Vite
origin and read them against the bullets above. No leftover sentence implying
only allow-listed addresses can ever sign in. Both still render in light and
dark and contain no external asset reference. `dist/privacy.html` and
`dist/terms.html` contain the new text — the consent screen's Branding URLs
point at the live copies, so this must be in `dist/` before step 14.

**Failure handling:** if the Branding URLs are already published (see
Ordering), these pages are live documents — a deploy with stale legal copy
after this feature ships is the failure. Do not deploy step 14 before this
step is in the image.

### 13. [core] Local end-to-end by hand, two Google accounts

`npm run dev` + `npm run dev:api`, `http://localhost:5173`, `RESEND_API_KEY`
set only if you intend to send a real email (it goes to the owner's real
inbox). Account A = owner, in `ALLOWED_EMAILS`. Account B = a second real
Google account, **not** in `ALLOWED_EMAILS`, able to complete consent (see
Ordering).

1. Account B, separate browser profile: Settings → Sign in with Google →
   consent → the **403 invitation-only** page with the Request access button.
   No `sous_session` cookie is set; `document.cookie` shows no `sous_oauth`
   either (it is cleared on every branch).
2. Press Request access ⇒ the recorded page. Firestore has one
   `accessRequests/{B-sub}` doc with `status: 'pending'`, `requestCount: 1`.
   No `users/{B-sub}` document exists. One email arrives (or the disabled
   notice is in the `dev:api` log).
3. Press again via Back ⇒ the same copy, `requestCount: 2`, `lastNotifiedAt`
   **unchanged**, no second email.
4. Account B: `GET /api/admin/requests` in that profile ⇒ **401** (no
   session). `/api/sync/pull` ⇒ 401. Chat cannot be reached at all (no app).
5. Account A: `/admin` ⇒ B is Pending. Approve.
6. Account B: sign in again ⇒ lands in the app signed in, Settings shows B's
   email, **no Invitations link**, and the library is **empty** (no sample
   recipe, no recipe of A's). Create a recipe; Sync now; Firestore shows it
   under `users/{B-sub}/recipes` and **nothing** under A's subtree.
7. Account B: one chat turn streams and one URL import works — this is the
   landmine proof. `/admin` in B's profile ⇒ the "can't manage invitations"
   line only, and `POST /api/admin/decision` from B's console ⇒ **403**.
8. Account A: `/admin` → Remove access on B. Within 60 s, B's next
   `/api/auth/session` returns `user: null`, B's app signs itself out, and B's
   chat/import/sync all 401. B's recipes remain in Firestore (nothing is
   deleted) and B's IndexedDB cache still opens read-only, matching the
   existing signed-out behaviour.
9. Account B: sign in again ⇒ the 403 page again, and Request access shows the
   recorded copy with **no** new email (the request is `denied`).
10. Stop `dev:api`'s Firestore access (`FIRESTORE_EMULATOR_HOST=localhost:1`,
    restart): Account A still signs in and still syncs; Account B's session
    endpoint returns **503** and B's client shows `offline`, **not** signed
    out. Restore.
11. `npm test` and `npm run build` both clean.

**Verify:** every numbered bullet, done once by hand. 6, 7 and 8 are the three
that cannot be replaced by a unit test.

**Failure handling:** B gets 401 on chat but syncs ⇒ step 5's wrapper. B sees
A's recipes ⇒ **stop everything**: `uid` is being taken from somewhere other
than the session; that is the one unrecoverable bug in this plan. B's client
signs out on the Firestore outage ⇒ a 401 where a 503 belongs.

### 14. [core] Production deploy and live verification *(operational)*

Record the rollback target first:

```powershell
$gcloud = "C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$P = 'cooking-assistant-508423'
& $gcloud config get account
& $gcloud run services describe sous --region=europe-west1 --project=$P --format="value(status.latestReadyRevisionName)"
```

Write that revision into the parent Deploy record, then from Git Bash at the
repo root on a commit containing steps 1–13:

```bash
bash scripts/deploy.sh
```

Then, env **names** only — never values:

```powershell
& $gcloud run services describe sous --region=europe-west1 --project=$P --format="value(spec.template.spec.containers[0].env[].name)"
```

Must still include `SESSION_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`,
`ALLOWED_EMAILS`, `PUBLIC_ORIGIN`, `GOOGLE_CLOUD_PROJECT`, `PHOTO_BUCKET`,
`GEMINI_API_KEY`, and now `MAIL_FROM` and `OWNER_NOTIFY_EMAIL` (plus
`RESEND_API_KEY` if it was set). A **missing** pre-existing name is an outage —
roll back with
`& $gcloud run services update-traffic sous --region=europe-west1 --project=$P --to-revisions=<PREVIOUS>=100`.

Live checks:

```powershell
node -e "for (const p of ['/','/privacy','/terms']) fetch('https://sous.kyrylo.lol'+p).then(r=>console.log(p,r.status))"
node -e "fetch('https://sous.kyrylo.lol/api/admin/requests').then(r=>console.log('no-cookie admin',r.status))"
node -e "fetch('https://sous.kyrylo.lol/api/access-request',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'t=nope'}).then(r=>console.log('bad token',r.status))"
node -e "fetch('https://sous.kyrylo.lol/api/admin/decision',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log('no-cookie decision',r.status))"
```

Expect 200 / 200 / 200 for the pages, **401** for both admin calls, **400**
for the bad token. `/privacy` must be the step-12 copy. Then sign in as the
owner and re-run the framing/streaming oracle from
`docs/plans/sous-subdomain.md` step 2 with a `sous_session` cookie
(`$env:PROBE_COOKIE`, removed afterwards): `FRAMING PASS`, `STREAMING PASS`,
`gapMs >= 500`, `content-encoding` and `content-length` both `null`. Finally
repeat local bullets 1, 2, 5, 6 and 7 against `https://sous.kyrylo.lol` with
the second account, and confirm
`https://cook-seven-mu.vercel.app` still 401s chat and import.

Write the new revision into the Deploy record.

**Verify:** every command and expectation above.

**Failure handling:** container will not start ⇒ a non-erasable TypeScript
construct or a missing `COPY server` (`Cannot find module` on every new route
while local works). Every request 401s ⇒ `SESSION_SECRET` dropped from the env
map. `PERMISSION_DENIED` from Firestore on the new collections ⇒ the runtime SA
lost `roles/datastore.user`; the collections themselves need no new binding.
Notification email never arrives in production ⇒ check the name list for
`RESEND_API_KEY` and the Resend dashboard, not the code; the feature works
without it. Anything unexplained ⇒ roll back to the recorded revision first,
debug second.

## Out of scope

- **Inviting an email address that has never requested.** Membership is keyed
  by `sub` (**D4**), which only exists after the person completes consent.
- **Any email to the requester**, including on approval (**D14**). Would need
  `kyrylo.lol` verified in Resend with DNS records, then one more `sendMail`
  call in `applyDecision`'s caller.
- **A free-text note on the request** (**D13**). If ever added: hard cap at
  200 characters, strip control characters, escape on render, and keep it out
  of the notification subject.
- **Per-user rate limiting or usage metering on `GEMINI_API_KEY`**, and a
  server-side cap on chat body size / history length / image count. See Risks;
  deferred to a follow-up plan (`docs/plans/multi-member-hardening.md`, not
  written by this plan).
- **SSRF hardening of `api/import.ts`.** See Risks; same follow-up.
- **Automated purge of old request documents.** There is no scheduler in this
  architecture; deletion is manual, and `/privacy` says so.
- **A cross-instance cache flush** for instant revocation (**D11**). No
  pub/sub, no polling, no Firestore listeners.
- **An `ADMIN_EMAILS` env var** (**D7**), a second shared-password-style gate,
  Auth.js, extra Google scopes, refresh tokens, and the GIS `id_token`
  fallback (which belongs to `deploy-and-end-state` step 6 if and only if that
  failure is observed).
- Dexie name `cook`, v1/v2/v3 `stores()`, `app: 'cook'` backups,
  `cook-backup-` filenames, `vercel.json` / Vercel env / the Vercel origin's
  configuration, the Dockerfile's Node pin / stages / `CMD`, region, domain
  mapping, certificate, the `0x1E` framing, the Gemini request shape,
  `maxDuration = 60`, `package.json` `"name"`, polling sync, and the LWW
  conflict-merge decision.

## Risks

- **Every member shares one `GEMINI_API_KEY`, with no per-user limit and no
  metering.** This was deliberately deferred by the parent plan;
  `sessionSub` returns `sub` precisely so a future limit can key on it. Each
  approval multiplies the owner's exposure to cost and quota exhaustion, and
  one member's loop can deny the owner service. There is also **no server-side
  cap** on `/api/chat` body size, message-history length, or image count
  (`/api/sync/push` has `MAX_PUSH_OPS`/`MAX_PUSH_BYTES`; chat has nothing).
  Mitigation for v1 is social — approve only people you know — plus Cloud Run
  `--max-instances=4`. Deferred, on purpose, and recorded here so the next
  agent does not rediscover it.
- **`api/import.ts` is an SSRF surface that widens with every member.** It
  `fetch`es a user-supplied URL with `redirect: 'follow'` and only an
  http/https scheme check; private, loopback and link-local destinations are
  not blocked, and the fetched body is fed to Gemini and returned to the
  caller. Two facts currently bound the damage, and **both must be re-checked
  before anything changes**: the request sends only `User-Agent` and `Accept`,
  so the GCE metadata server refuses it for lack of `Metadata-Flavor: Google`
  (no SA-token theft); and the service has **no VPC connector**, so there is no
  private network to reach. Adding a connector, or any header forwarding, turns
  this into a real vulnerability. Deferred to the follow-up plan; not silently
  ignored.
- **Revocation is eventual, up to 60 s per instance** (**D11**), against
  AGENTS.md's "next request". Documented in `AGENTS.md` by step 11. If that is
  ever unacceptable, set the TTL to 0 and accept one Firestore read per
  protected request per member.
- **`ALLOWED_EMAILS` now grants admin** (**D7**). The natural instinct —
  "just add my friend to `ALLOWED_EMAILS`" — silently makes them an
  administrator. Three documents warn about it; nothing enforces it.
- **Dev writes to production Firestore.** `members/`, `accessRequests/` and
  `accessRequestMeta/` are **top-level**, so local `dev:api` experiments can
  approve or decline a real person, and a local run with `RESEND_API_KEY` set
  emails the owner's real inbox. They are also outside the `users/{uid}`
  subtree, so no existing backup, export or per-user cleanup covers them.
  Mitigations: leave `RESEND_API_KEY` out of `.env.local` unless testing mail,
  use a distinct second Google account (distinct `sub`) for request testing,
  and use `FIRESTORE_EMULATOR_HOST` for destructive experiments.
- **Deleting `sessionFrom` and the `isAllowed` call inside `readSession`
  temporarily makes the codebase one forgotten call away from an open app.**
  The architecture-lock test in step 3 exists for exactly this and must not be
  "fixed" by widening its allow-list.
- **`--env-vars-file` replaces the whole env map**, and the key list lives
  inside a one-line `node -e`. A partial map signs everyone out
  (`SESSION_SECRET`), locks everyone out (`ALLOWED_EMAILS`), or breaks Gemini.
  This remains the most dangerous line in the repo.
- **The notification email is a social-engineering target.** It contains an
  attacker-chosen display name and email address. It is plain text, carries no
  link other than `https://sous.kyrylo.lol/admin`, and **no approval power**
  (**D3**) — so the worst case is a misleading name in the owner's inbox, and
  the owner still reads the real values on `/admin`.
- **Inbox spam is bounded but not zero.** Each notification costs the attacker
  a fresh Google account plus a completed consent; per identity the cap is 5
  notifications ever and 1 per 24 h, and globally 20 per UTC day (**D16**).
  Firestore junk is one small document per consenting account.
- **This deploys straight to production, with no staging.** Step 14 records the
  rollback revision before anything else for that reason.

## Open Questions

- **BLOCKING — `docs/handoff-invitation-only.md` does not exist.** It is not in
  the working tree and `git log --all -- docs/handoff-invitation-only.md`
  returns nothing, so the stated product/security rationale for the
  invitation-only gate could not be read. This plan reconstructs the
  fail-closed rules from `AGENTS.md` and from `server/allowlist.ts`,
  `server/session.ts` and `server/auth.ts` directly, and preserves all of
  them (blank list denies everyone, unverified email denies, blank email
  denies, blank never means allow-all, re-check on every protected request).
  If that document exists elsewhere, it must be read before step 4, because a
  rule in it could contradict **D7** (owner set) or **D11** (60 s cache).
- **BLOCKING — `docs/plans/deploy-and-end-state.md` is also missing from the
  working tree**, and the only copy in git (commit `1cfde06`, on branch
  `cursor/cloud-agent-1789710534681-e537h`, which is **not** an ancestor of
  `HEAD`) shows its Status with steps **1–4 ticked** — i.e. the consent screen
  already published to Production — which contradicts the brief's "steps 4–7
  are still pending". Confirm which is authoritative and what the consent
  screen's real state is. It changes exactly one thing in this plan: whether
  step 13 can use any second Google account (In production) or needs that
  account added to the OAuth **test users** list first (Testing). It does not
  change any code.
- Non-blocking: does a Resend account already exist, and is `kyrylo.lol`
  verified there? Default assumed in step 1 is the sandbox sender
  (`MAIL_FROM=onboarding@resend.dev`, delivery to the owner's own address
  only), which is enough for v1 and is env-configurable later.
- Non-blocking: **D7** reuses `ALLOWED_EMAILS` as the admin set rather than
  adding `ADMIN_EMAILS`. If the owner would rather have them separate, it is a
  small change: a new `adminEmails()` getter, one line in `requireOwner`, and
  a `resolve_secret` + `keys` entry in `deploy.sh`.
- Non-blocking: declined requests are kept for 12 months per step 12's copy.
  If the owner prefers immediate deletion on decline, drop the `denied` state
  and accept that a declined person can re-notify after 24 h.

## Status

- [ ] 1. [core] `server/mail.ts` and the three env getters
- [ ] 2. [core] `server/members.ts` — collections and the pure decisions
- [ ] 3. [core] `server/membership.ts` — the gate, the cache, the architecture lock
- [ ] 4. [core] Cut every protected route over to the gate
- [ ] 5. [core] The chat/import membership gate (the landmine)
- [ ] 6. [core] The access-request token and `POST /api/access-request`
- [ ] 7. [ui] The invitation-only page and the request-result pages
- [ ] 8. [core] Admin API, owner-only and enforced server-side
- [ ] 9. [core] `src/lib/adminApi.ts` and `isOwner` on the session
- [ ] 10. [ui] `/admin` screen and the Settings entry point
- [ ] 11. [core] `.env.example`, `scripts/deploy.sh`, `README.md`, `AGENTS.md`
- [ ] 12. [ui] Privacy and terms
- [ ] 13. [core] Local end-to-end by hand, two Google accounts
- [ ] 14. [core] Production deploy and live verification *(operational)*
