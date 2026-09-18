# Invitation request flow (request access → owner approves → own library)

Parent: `docs/plans/sous-oauth-db.md`. Successor slice to
`docs/plans/photos-and-deploy-docs.md` (18–19, landed) and
`docs/plans/deploy-and-end-state.md` (steps 1–4 landed — the consent screen is
**In production**; 5–7 still pending, see **Ordering**).

This work is branch `invitation-flow`, cut from `main`.
`docs/plans/deploy-and-end-state.md` deliberately lives on the
`deploy-and-end-state` branch and is **not** on this one — the **Ordering**
section below carries everything this plan needs from it. Do not go looking
for the file here and do not report it missing.

Standing product briefing this plan must not contradict:
`docs/handoff-invitation-only.md`. Every fail-closed rule it states is
preserved here; step 12 extends that document to describe the new mechanism
rather than letting it contradict the code.

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
   not at 90-day cookie expiry. Removing an address from `ALLOWED_EMAILS`
   still takes effect on the very next request, uncached, exactly as
   `docs/handoff-invitation-only.md` requires.

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
- `docs/handoff-invitation-only.md` states those same four rules under
  **Fail-closed rules (do not invert)**, plus: no second gate (`APP_PASSWORD`
  was removed because a shared password keeps working after someone is dropped
  from the list); the allowlist is re-parsed on **every** protected request,
  not only at cookie issue; removing an email must take effect on the next
  request, not at 90-day cookie expiry; and the ban on a client-supplied
  `x-sous-user` header quoted verbatim in **D6**. It also contains two
  statements that this feature makes actively wrong — see **D7** and step 12.
  The file was lost once to a stash and is now **committed on this branch**;
  step 12 keeps its contents true rather than rescuing it from oblivion.
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
  401`. `api/sessionGate.test.ts` runs the same **six** vectors against both
  (counted in the file: valid cookie, wrong secret, expired, malformed,
  removed-from-allowlist, blank `SESSION_SECRET`).
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
  so **an approved member whose email changes keeps access**.

  **`/admin` reads exactly one collection: `accessRequests`.** All three
  sections — Pending, Approved, Declined — come from it, filtered by
  `status`. That is sound because `applyDecision` refuses an `action` for
  which no `accessRequests/{sub}` exists (`'unknown-request'`), so **every
  identity the owner has ever decided on necessarily has a request document**:
  the collection is a complete index, not a partial one. `members/{sub}` is
  never listed or displayed; it is read only by `readMember`, only for the
  authorization decision (**D5**). If the two ever disagreed — only a hand
  edit could do it, since `applyDecision` writes both in one transaction —
  `members/{sub}` wins for access and the owner corrects the view by pressing
  Remove access.

  The displayed `email`/`name` on the request document are refreshed on each
  member sign-in by `touchRequestIdentity` in **step 4**, which **updates an
  existing request document and never creates one**. Nothing refreshes them
  implicitly: `upsertUser` only writes `users/{sub}`, so without that call
  `/admin` would keep displaying a stale address indefinitely and the owner
  could revoke the wrong person. The cost:
  the owner can only approve identities that have **already requested** —
  there is no "invite an email address that has never signed in". That is out
  of scope and recorded below.
- **D5. Two new top-level Firestore collections**, not subcollections of
  `users/{uid}`: the admin screen has to *list* requests across identities, and
  a subcollection would need a collection-group query. Nothing under `users/`
  changes.
  - `accessRequests/{sub}`: `{ sub, email, name?, status:
    'pending'|'approved'|'denied', createdAt, updatedAt, requestCount,
    lastNotifiedAt?, identitySeenAt?, decidedAt?, decidedBy? }`.
    **This collection is the single source for everything `/admin` displays**
    (see **D4**), and `lastNotifiedAt` is the 24-hour window field described
    in **D16**, not a delivery receipt. There is deliberately no
    `lastRequestAt`: a quiet press writes nothing, so a "last press" field
    could only ever record the presses that already moved
    `lastNotifiedAt`, and a field that silently means something other than its
    name is worse than no field.
  - `members/{sub}`: `{ sub, email, name?, status: 'active'|'revoked',
    approvedAt, approvedBy, updatedAt }`. **This is the authorization record
    and nothing else.** Only `parseMemberDoc` reads it, and it validates only
    `sub`, `status`, `approvedAt` and `approvedBy`; `email` and `name` are an
    approval-time snapshot, never refreshed and never displayed.
  - `accessRequestMeta/notifications`: `{ day: 'YYYY-MM-DD', count }` — the
    only global inbox bound.

  **Listing, and what it can honestly promise.** Each of the three sections is
  one query: `where('status','==', s).orderBy(FieldPath.documentId())
  .limit(201)`, optionally `.startAfter(cursor)`. Ordering by document id is
  free — an equality-filtered Firestore query is *already* ordered by
  `__name__`, so stating it explicitly adds no index — and it is what makes
  `startAfter` a correct cursor, so every row is reachable by paging. What it
  is **not** is recency: document ids are Google `sub` values, which have no
  relation to time. So this plan does **not** claim "the most recent 200",
  because `where('status','==',…)` plus `orderBy('createdAt','desc')` is
  precisely the shape that demands a **composite index**, and this feature
  adds none. Rows within a loaded page are sorted by `createdAt` descending in
  memory for presentation only, and step 10's UI says exactly that plus a
  **Load more** control. The rejected alternative — an unordered
  `.limit(201)` with an in-memory sort — is worse than it looks: it returns an
  arbitrary subset, sorting it afterwards only sorts that subset, and a
  growing pile of `denied` rows could silently hide actionable `pending` ones
  behind a UI line claiming recency.
- **D6. The `api/` landmine is resolved with an explicit in-process argument,
  not an env flag and not a trusted header.**

  `docs/handoff-invitation-only.md`, **Fail-closed rules (do not invert)**,
  final paragraph, verbatim:

  > The Vercel copies of `api/chat.ts` and `api/import.ts` re-check the
  > allowlist inline. Do not replace that with a client-supplied `x-sous-user`
  > header.

  This design satisfies that rule on both of its clauses, and the distinction
  is the single most important thing for a future reader not to misread:
  1. **The Vercel copies keep re-checking the allowlist inline.** The inline
     `sessionSub` in both files — HMAC, `v === 1`, `exp`, and
     `isEmailAllowed(row.email, process.env.ALLOWED_EMAILS ?? '')` — is not
     edited, not weakened, and not made conditional on any environment
     variable. On Vercel it is still the only gate, and with no
     `SESSION_SECRET` there it still returns `null` for every request.
  2. **Nothing is client-supplied.** The bypass is a second *function
     argument* passed in-process by `scripts/server.ts` after
     `requireMember` has already returned `ok`. It is not a header, not a
     cookie, not a query parameter, and not any other part of the HTTP
     request — there is no wire representation for an HTTP client to set, so
     there is nothing to strip or to forget to strip. A header-based design
     is what the rule bans, and it is banned for the right reason: it would
     have to be scrubbed on every entry path and would be one missed scrub
     away from an open Gemini proxy.

  Step 3's architecture-lock test (assertion 4) asserts that the string
  `x-sous-user` never appears in the **production** sources under `api/`,
  `server/` and `scripts/` — the scan excludes `*.test.ts`, and that exclusion
  is load-bearing rather than cosmetic, because the test files necessarily
  contain the banned string in order to probe for it. So the banned mechanism
  cannot be reintroduced in shipping code under cover of this decision, and
  step 5's Verify probes that exact header name against the live route.

  `api/chat.ts` and `api/import.ts` gain an **optional second parameter**:
  `export async function POST(req: Request, ctx?: { authorizedSub?: string })`.
  When `typeof ctx?.authorizedSub === 'string' && ctx.authorizedSub !== ''`
  the handler skips its inline `sessionSub(req)`; otherwise it runs exactly as
  today. `scripts/server.ts` wraps both handlers so Cloud Run calls
  `chatPost(req, { authorizedSub: access.sub })` **after** `requireMember`
  has passed. Why this shape, beyond the two clauses above:
  - Vercel invokes the exported handler with the request only; if its runtime
    ever passes a second context object, `authorizedSub` is `undefined` and
    the inline `sessionSub` still runs. Fail-closed by default.
  - `@google-cloud/firestore` stays out of `api/` entirely — the membership
    read happens in `server/membership.ts`, which Vercel never loads.
  - `api/sessionGate.test.ts` keeps **every existing vector unchanged** (they
    test `sessionSub`, which is untouched) — six per handler as the file
    stands today, run against both exported `sessionSub`s — including
    `'returns null when email was removed from allowlist'` — the vector that
    is the handoff doc's rule in executable form. One new assertion is added:
    `sessionSub` is still the only gate the `api/` file applies to a bare
    request, header or no header. No vector is weakened.
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
  written into `.env.example`, `README.md`, `AGENTS.md` and
  `docs/handoff-invitation-only.md` in capitals:
  **anyone added to `ALLOWED_EMAILS` becomes an admin** — approve ordinary
  people through `/admin`, never by editing that variable. If that is ever
  unwanted, the revert is a separate `ADMIN_EMAILS` var plus two lines in
  `deploy.sh`; not done now to avoid a fourth deploy key.

  This makes two existing statements in `docs/handoff-invitation-only.md`
  actively wrong rather than merely incomplete, which is why step 12 is not
  optional. Under **Why (product)**: "Adding a second allowlisted email is one
  env value and one redeploy; that person gets **their own empty library**."
  And the whole **If you need a second person** section: "Set `ALLOWED_EMAILS`
  to a comma-separated list, redeploy…". A future agent following those
  instructions literally would hand an ordinary member administrative power
  over the member list, and would do it by redeploy when no redeploy is needed
  any more. Both passages are rewritten in step 12 to point at `/admin`.
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
- **D11. Membership cache: 60-second in-process TTL, positive only,
  keyed by `sub`.** Rationale: a first library load on a new device issues one
  `GET /api/photos/:id` per photo, and an uncached design would add one
  Firestore document read to each. The **owner never reads Firestore at all**
  (the `ALLOWED_EMAILS` check short-circuits first), so this cost and this
  staleness only exist for members.

  The cache is therefore **tier-specific, and the older tier keeps its exact
  guarantee**. `docs/handoff-invitation-only.md` requires that the allowlist be
  "re-parsed on **every** protected request … not only at cookie issue" and
  that "removing an email must take effect on the next request, not at 90-day
  cookie expiry". That stays literally true: `isAllowed(email, true,
  allowedEmails())` is re-evaluated from `process.env` on every protected
  request with **no caching whatsoever**, so removing an address from
  `ALLOWED_EMAILS` still takes effect on the very next request. Only the
  **new** Firestore tier — which that document does not describe, because it
  does not exist yet — carries a bound. Explicit trade-off: **revocation takes
  effect within at most 60 seconds per running container instance** (Cloud Run
  is `min-instances=0 --max-instances=4`, so up to four caches), instead of
  AGENTS.md's "next request". Revocation path: the owner presses Remove access
  → Firestore write is immediate → the serving instance drops its own cache
  entry → other instances expire within 60 s. There is no cross-instance
  flush and none is added (no pub/sub, no polling). Setting the TTL to 0
  restores "next request" exactly, at one Firestore read per protected request
  per member; the constant is one line so that choice stays reversible.

  **Only an `active` member is ever cached. Nothing else is, in any form.**
  This is the asymmetry that makes the bound acceptable, and it is not
  negotiable:
  - absent (no `members/{sub}` doc), `status` not `active`, and a document
    that fails `parseMemberDoc` validation (**step 2**) are **never** cached;
  - a Firestore throw is **never** cached;
  - so a **newly approved** requester is admitted on the **very next
    request** — there is no negative entry to wait out, and the plan's "sign
    in again once approved" copy (**D14**) is therefore literally true;
  - and a transient Firestore blip can never lock a member out for a minute.

  A negative cache would buy one Firestore read per denied request while
  making approval feel broken for up to a minute, and the denied population
  is exactly one document read — not worth it. Revocation, which *is* bounded
  at 60 s, is the owner's own deliberate action and the `/admin` copy says so;
  approval is the path a stranger is waiting on. Step 3 unit-tests both
  directions: approval visible on the next lookup, revocation visible after
  the TTL.

  Nothing here is a second gate in the `APP_PASSWORD` sense the handoff doc
  warns against: membership is per-identity and revocable, there is no shared
  secret, and the step-6 request token grants no access at all (**D8**).
- **D12. Firestore read throws ⇒ deny, with 503 and never a 401.** Fail closed
  means no data is served and Gemini is not called; it must not mean "you are
  signed out", because a 401 makes the client wipe its cached session and
  (from `syncEngine`) report `signedOut`. So: membership **denied** ⇒ 401;
  membership **unknown** ⇒ 503. `authSession` returns 503 without clearing the
  cookie, which `fetchSession` already degrades to `offline` with the cached
  user.

  Be precise about what the owner short-circuit buys, because it is easy to
  overclaim: the owner path never touches Firestore **for the authorization
  decision**, so during a Firestore outage the owner can still sign in, still
  passes every gate, and is never signed out. The owner's **data** operations
  still fail, because sync, photos and the callback's `upsertUser` all read or
  write Firestore themselves — that is unavoidable and has nothing to do with
  membership. What this plan guarantees is therefore narrower and worth
  stating exactly: **authorization survives a Firestore outage for the owner;
  the library does not.** Those downstream failures must surface as **503**
  too, not as an uncaught 500 — step 4 adds that mapping to `server/sync.ts`
  and `server/photos.ts`, because membership short-circuiting does nothing to
  translate a throw raised further down the handler.

  In the OAuth callback, a Firestore error renders a
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
- **D15. Mail is optional and degradable, and `sendMail` never throws.**
  `RESEND_API_KEY` unset ⇒ `sendMail` logs once and returns `false`. So does
  a non-2xx from Resend, **and so does a rejected `fetch`** — DNS failure,
  connection refused, or the 10-second `AbortSignal.timeout` firing, none of
  which produce a response to check `.ok` on. The request is still recorded
  and still appears in `/admin` in every one of those cases, and the caller
  still replies 200, because the record is the thing that matters and the
  requester cannot usefully retry for 24 h (**D16**). This keeps
  `npm run dev:api` working with no Resend account and makes a Resend outage
  or a network blip non-fatal. The result page never claims an email was
  sent.
- **D16. Dedupe, throttle and cap — one rule, not three.** Per identity
  (`sub`) there is exactly one `accessRequests/{sub}` document, and the
  **notification window is also the write window**. A press is either
  *notification-bearing*, in which case it writes, or it is quiet, in which
  case it writes **nothing at all**:

  | existing document | write? | notification window? |
  | --- | --- | --- |
  | absent | create, `requestCount: 1` | yes |
  | `pending`, `now - lastNotifiedAt >= 24 h`, `requestCount < 5` | bump `requestCount`, set `lastNotifiedAt` | yes |
  | `pending`, inside the 24 h window | **no** | no |
  | `pending`, `requestCount >= 5` | **no**, ever again | no |
  | `approved` | no | no |
  | `denied` | no | **never** |

  The third column is `notificationEligible` — "this press opened a
  notification window" — **not** "an email was sent". Delivery is decided
  afterwards by the global daily cap and then by Resend, and either can
  suppress the email while the write stands (see below, and step 2).

  This is the whole abuse bound, and it is deliberately a single mechanism
  rather than a write throttle layered under a separate notification rule.
  The threat is not just inbox spam: a stranger can mint a fresh
  `accessreq` token whenever they like by repeating Google consent, so any
  per-token throttle is worthless, and any rule that writes on a quiet press
  — even a cheap one, even once a minute — is an **unauthenticated,
  unbounded Firestore write channel** against the owner's own quota and bill.
  Making the quiet press a pure read closes it. The resulting guarantees are
  flat and checkable:

  - **at most 5 requester-driven writes per identity, ever**, and at most one
    per 24 hours;
  - **at most one document per Google account** that completes consent. One
    unavoidable document per fresh account is accepted — it costs the attacker
    a new Google identity and a full consent round-trip, and it is the floor
    any request flow has;
  - a replay flood on one token costs **one read per press and zero writes**;
  - `status: 'denied'` and `status: 'approved'` are absorbing: no write, no
    email, and the same neutral copy as a fresh request, so there is no
    "you were rejected" disclosure and no inbox vector.

  `lastNotifiedAt` is therefore the **window** field, not a delivery receipt.
  It is set whenever the write happens, even if the global cap below or a
  Resend failure suppressed the actual email. That matters: if a suppressed
  notification left the window open, an attacker who first exhausted the
  global cap could write once per press again — the bound would collapse
  exactly when the system is already under pressure. A suppressed
  notification costs the requester one wasted window; they may press again
  after 24 h, up to the ceiling of 5.

  Globally, `accessRequestMeta/notifications` caps notifications at **20 per
  UTC day**. It is read and written **only** when a press is already
  notification-bearing, so a quiet press never touches that one shared
  document — otherwise a replay flood would serialize unrelated first-time
  requesters against it and burn transaction retries on contention.

  If an identity ever exhausts its five requests without being decided, the
  owner acts from `/admin` (the document is already there, in Pending); the
  requester never needs another write. Every rule above is a pure function,
  unit tested in step 2.

## Ordering against `deploy-and-end-state.md`

**Independent, not blocked.** `docs/plans/deploy-and-end-state.md` Status shows
steps **1–4 ticked**: the rollback target is recorded, the Phase 2 revision is
deployed, the live probes and streaming oracle passed, and the Branding URLs
are filled with the Audience **In production**.
`docs/handoff-invitation-only.md` agrees ("Google Auth Platform Audience is
**In production**") and adds that a non-listed account completing consent and
landing on the 403 is "the intended shape of **published but private**".

Consequence for this plan: **any** second Google account can complete consent
and reach the 403, so step 14 needs no OAuth console change and nobody has to
be added to a test-users list. The 403 that step 7 replaces is already live in
production today.

Still pending in that cutover, and unchanged by this plan: step 5 (desktop +
second-device sync), step 6 (installed iOS PWA sign-in), step 7 (migration
gate, Vercel leftover, Deploy record).

Where this plan sits: run it **after** those three. They validate the
single-account sync path that this plan then widens to more people, and a
production deploy in the middle of them muddies their results. That is a
sequencing preference, not a technical dependency — no step below depends on
any of them. If step 6 observes the iOS standalone cookie-jar failure, that
stops *that* plan for a GIS `id_token` plan, not this one.

## Files to change

| File | Change |
| --- | --- |
| `server/env.ts` | New getters: `resendApiKey()` (`null` when unset), `mailFrom()`, `ownerNotifyEmail()`. |
| `server/mail.ts` | **New.** `sendMail({subject, text})` → Resend `POST https://api.resend.com/emails`, bearer token, 10 s `AbortSignal.timeout`, returns `boolean`, **never throws** (network and timeout rejections are caught). Logs status codes and error names only, never the key or the body. |
| `server/members.ts` | **New.** Owns the `MemberRecord` type and pure `parseMemberDoc`, so nothing in this file imports `server/membership.ts` — the dependency runs one way, members → membership. Firestore accessors for `members/`, `accessRequests/`, `accessRequestMeta/` (`readMember`, `recordAccessRequest`, `listAccessRequests` as three cursor-paged per-status queries, `applyDecision`, `touchRequestIdentity`) + the pure decisions `nextRequestState`, `nextNotificationCounter`, `decisionTransition`, `isValidSubParam`. |
| `server/members.test.ts` | **New.** Pure only: the `parseMemberDoc` rejection table, the request state machine (`write` **and** `notificationEligible` for every input state, plus `write === notificationEligible` as a loop), 24 h window, `requestCount` ceiling of 5, quiet-press-writes-nothing, denied/approved absorbing, `nextRequestState` idempotence, daily counter rollover **including the cap-exhausted composition where the write stands but delivery is false**, decision transitions. |
| `server/membership.ts` | **New.** Imports `MemberRecord` / `parseMemberDoc` from `server/members.ts`. Pure `accessDecision({email, emailVerified, allowedRaw, member})` → `'owner'|'member'|'denied'`; async `accessAllows(identity)` (never throws — for the callback), `requireMember(req)`, `requireOwner(req)`, `withMembership(handler)`; the **positive-only** 60 s TTL cache with `clearMembershipCache(sub)`; the shared 401/503 response helpers, `storeUnavailable()`, and `readBoundedText(req, limit)`. |
| `server/membership.test.ts` | **New.** Pure `accessDecision` table (blank list, unverified email, blank email, revoked member, owner-when-Firestore-absent), cache TTL with an injected clock in **both** directions (approval visible immediately, revocation after the TTL) + the architecture-lock assertions over production sources only — three of the six land here, one in step 4 and two in step 5, as each becomes true. |
| `server/session.ts` | Add `signAccessRequestTx`/`verifyAccessRequestTx` (`v:'accessreq'`, 10 min). Remove the `isAllowed` call and the `allowedEmails` import from `readSession` (it becomes cryptographic-only, with a doc comment saying so). **Delete `sessionFrom`.** |
| `server/session.test.ts` | Replace the "unusable when allowlist misses" case with an `ok`-regardless-of-email case plus a comment pointing at `requireMember`; drop the `sessionFrom` import; add accessreq round-trip, expiry, and cross-family rejection. |
| `server/auth.ts` | Callback: `isAllowed` → `await accessAllows(...)`; 503 page on a Firestore error; 403 page gains the request form. `authSession`: membership re-check (401/503/clear-cookie) and `isOwner` in the body. |
| `server/access.ts` | **New.** `accessRequestPost` — 4 KB body cap, `application/x-www-form-urlencoded` parse, token verify, `recordAccessRequest`, `sendMail`, and the three server-rendered result pages. |
| `server/admin.ts` | **New.** `adminRequestsGet`, `adminDecisionPost` — both `requireOwner`, JSON only, 4 KB body cap, `sub` pattern validation, self-demotion refused. |
| `server/sync.ts` | `sessionFrom` → `requireMember` in `syncPull` and `syncPush`; a Firestore throw below the gate maps to **503**, not an uncaught 500. |
| `server/photos.ts` | `sessionFrom` → `requireMember` in `photosGet` and `photosPost`; same 503 mapping, which also keeps `photo.put` rows retryable (`shouldParkPhotoPut` returns `false` for 503 unconditionally). |
| `scripts/server.ts` | Route table `+= POST /api/access-request`, `GET /api/admin/requests`, `POST /api/admin/decision`; wrap `chatPost`/`importPost` in the membership gate and pass `{ authorizedSub }`. |
| `api/chat.ts` | Optional `ctx?: { authorizedSub?: string }` second parameter; rewritten sync comment. Gemini request shape, `0x1E` framing and `maxDuration` untouched. |
| `api/import.ts` | Same two edits. Extraction, SSRF posture and prompts untouched. |
| `api/sessionGate.test.ts` | Existing vectors unchanged; one added assertion. |
| `src/lib/session.ts` | `SessionUser` gains optional `isOwner?: boolean`. |
| `src/lib/adminApi.ts` | **New.** `fetchAccessRequests(cursors?)`, `decideAccessRequest({sub, action})`, each returning one page per section with a `nextCursor`. `credentials: 'same-origin'`, 401 → `invalidateSession()` + the standard message, 403 → "This account can't manage invitations." No Dexie import. |
| `src/screens/Admin.tsx` | **New.** Owner-only screen: Pending / Approved / Declined, load on mount, explicit Refresh, per-section **Load more** when a cursor comes back. |
| `src/App.tsx` | `<Route path="/admin" element={<Admin />} />`. |
| `src/screens/Settings.tsx` | An **Invitations** link, rendered only when `user.isOwner`. |
| `.env.example` | `RESEND_API_KEY`, `MAIL_FROM`, `OWNER_NOTIFY_EMAIL`; the `ALLOWED_EMAILS`-is-also-admin warning. No `VITE_` prefixes. |
| `scripts/deploy.sh` | `resolve_optional_secret RESEND_API_KEY`; `MAIL_FROM` + `OWNER_NOTIFY_EMAIL` into the `fixed` map; all three into the `keys` array with `RESEND_API_KEY` marked optional. |
| `README.md` | Invitation flow, `/admin`, env table, the admin warning. |
| `AGENTS.md` | Auth section: dynamic membership, `sub` keying, the 60 s revocation bound, 401-vs-503 rule, the `api/` argument bypass, new env vars, plan table row. |
| `docs/handoff-invitation-only.md` | Extend to the two-tier model; rewrite the two passages **D7** contradicts; repoint the code citations. Committed on this branch — keep it that way. |
| `public/privacy.html` | Access-request data, Resend as subprocessor, retention of **all four** records (pending, declined, approved requests and `members/{sub}`) and what a deletion request covers; rewrite the "Access" section. |
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
15. Production deploy + live verification            [operational]
    └─ 14. Local end-to-end by hand, two accounts
        └─ 13. privacy.html / terms.html             [ui]
            └─ 12. handoff-invitation-only.md
                └─ 11. .env.example, deploy.sh, README, AGENTS.md
                    └─ 10. /admin screen + Settings entry [ui]
                        └─ 9. src/lib/adminApi.ts + isOwner
                            └─ 8. Admin API (owner-only)
                                └─ 7. 403 + result page markup   [ui]
                                    └─ 6. Token + POST /api/access-request
                                        └─ 5. Chat/import gate (the landmine)
                                            └─ 4. Cut routes to the gate
                                                └─ 3. server/membership.ts
                                                    └─ 2. server/members.ts
                                                        └─ 1. mail.ts + env
```

Steps 7, 10 and 13 are `[ui]`. Everything else is `[core]`. Step 15 is
operational `[core]`. Steps 11–13 are all documentation and copy, and all
three land **before** the hand verification and the deploy.

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

**`sendMail` returns `false`. It never throws, on any path.** That is the
whole contract, and it is the contract because of what the caller does with
it: `server/access.ts` (step 6) has *already recorded the request* by the time
it calls `sendMail`, and a rejection there would escape into the route's error
path and turn a successfully recorded request into a 500 for the person who
made it — the one outcome that is both wrong and unrecoverable, since the
throttle in **D16** means they cannot usefully press again for 24 hours. So
`false` is returned, and only logged, for every one of:

- `resendApiKey()` is `null` — log once per process: "RESEND_API_KEY unset —
  access-request notifications are disabled";
- `mailFrom()` or `ownerNotifyEmail()` throws `envError`;
- `fetch` **rejects** — DNS failure, connection refused, TLS error, or the
  `AbortSignal.timeout(10_000)` firing, which surfaces as a rejection with
  `name === 'TimeoutError'` or `'AbortError'` and **not** as a response. This
  is the case a `response.ok` check alone silently misses;
- the response arrives and is non-2xx.

Structurally: everything from the `fetch` call onward sits inside one
`try/catch`, the `catch` logs `'resend send failed'` plus the error's
**`name`** only — never `message`, never the error object, never a stack —
and returns `false`. Otherwise it POSTs `{ from, to: [ownerNotifyEmail()],
subject, text }` as JSON to `https://api.resend.com/emails` with
`Authorization: Bearer …`, `signal: AbortSignal.timeout(10_000)`, and returns
`response.ok`. On a non-2xx it logs the **status code only**. It never logs
the key, the request body, or the response body. Plain-text body only — no
HTML, no links, and per **D3** no approve link or token of any kind.

**Verify:** `npm run build` clean. Three by-hand cases through a one-line node
script that imports `sendMail`, each of which must **resolve** `false` and
never reject:

1. no key set ⇒ `false` and the disabled notice;
2. `RESEND_API_KEY` set to a junk value ⇒ Resend answers 401, log shows the
   status code only, `false`;
3. the network unreachable (disconnect the interface, or point `MAIL_FROM`
   resolution at a machine that is offline) with a key set ⇒ the `fetch`
   rejects, the log shows `resend send failed` and an error **name**, and the
   call still resolves `false`. `node --unhandled-rejections=strict` on this
   case must stay silent.

`Select-String -Path server/mail.ts -Pattern 'RESEND_API_KEY'` shows only the
`env.ts` getter call and the notice text — never a value interpolated into a
log or a URL.

**Failure handling:** a 403 from Resend means the sender is not verified for
that account — fix `MAIL_FROM`, do not add a dependency or switch providers
inside this step. A hang means the timeout is missing. An unhandled rejection
anywhere in case 3 means the `try` starts after the `fetch` instead of around
it — fix it here, not in `server/access.ts`, or every caller inherits the
problem.

### 2. [core] `server/members.ts` — the member record, the collections, the pure decisions

This step is self-contained and must build and test on its own: it defines
everything the later membership gate needs and **imports nothing from
`server/membership.ts`**. The dependency runs one way, `membership.ts` →
`members.ts`. That is why `MemberRecord` and `parseMemberDoc` live here,
next to the `readMember` that produces them, rather than in the gate that
consumes them.

Pure, exported, unit-tested (no Firestore, no clock of its own — `now` is a
parameter):

```
export interface MemberRecord {
  sub: string;
  status: 'active' | 'revoked';
  approvedAt: number;
  approvedBy: string;
}

parseMemberDoc(raw: unknown, expectedSub: string): MemberRecord | null
```

`parseMemberDoc` is the **only** way a Firestore document becomes a
`MemberRecord`, and it is strict — a partially written, hand-edited or
half-migrated document must not authorize anybody. It returns `null` unless
**every** one of these holds:

- `raw` is a non-null object;
- `raw.sub` is a non-empty string **and `=== expectedSub`** (a document whose
  body disagrees with its own document id is corrupt, not a member);
- `raw.status` is exactly `'active'` or exactly `'revoked'` — no other string,
  no missing field, no truthiness test;
- `raw.approvedAt` is a finite number `> 0`;
- `raw.approvedBy` is a non-empty string.

A `null` is treated by the gate exactly like an absent document: denied, and
never cached (**D11**). It is never treated as `unknown`/503 — a malformed
document is a definite "not a member", not an outage. `readMember` logs the
`sub` and the reason once when it rejects a document, so a corrupt record is
diagnosable without reading the whole collection.

- `nextRequestState(existing, identity, now)` →
  `{ write: boolean; doc; notificationEligible: boolean }`, implementing the
  **D16** table exactly. Restated as code-shaped rules, because this one
  function is the whole abuse bound:
  - `existing === null` ⇒ `{ write: true, notificationEligible: true }`, doc is
    a fresh `pending` with `requestCount: 1`, `createdAt = updatedAt = now`,
    `lastNotifiedAt = now`;
  - `existing.status === 'pending'` and `existing.requestCount < 5` and
    `now - (existing.lastNotifiedAt ?? 0) >= 86_400_000` ⇒
    `{ write: true, notificationEligible: true }`, `requestCount + 1`,
    `lastNotifiedAt = now`, identity fields refreshed;
  - `existing.status === 'pending'` otherwise (inside the 24 h window, or
    `requestCount >= 5`) ⇒ `{ write: false, notificationEligible: false }`;
  - `existing.status === 'approved'` ⇒ `{ write: false, notificationEligible: false }`;
  - `existing.status === 'denied'` ⇒ `{ write: false, notificationEligible: false }`.

  **The flag is named `notificationEligible`, not `notify`, and the
  distinction is load-bearing.** It means "this press opened a notification
  window", which is a *decision about the request document*. Whether an email
  is actually **sent** is a separate, later question answered by the global
  daily cap and then by Resend. Conflating the two produced a real
  contradiction in an earlier draft: the invariant below claims
  `write === notificationEligible`, yet the cap can permit the write while
  suppressing the email, so a single field called `notify` had to be both true
  and false at once.

  **`write` and `notificationEligible` are never independent**:
  each implies the other, asserted as a property test over every fixture.
  There is no third state and no separate write throttle, because a quiet
  press that writes anything at all is an unauthenticated write channel a
  stranger can drive forever by minting fresh tokens (**D16**). The single
  window is the bound.
- `nextNotificationCounter(counter, now)` → `{ counter, allowed: boolean }` —
  UTC-day rollover, cap 20. **Consulted only when `notificationEligible` is
  already true** (see `recordAccessRequest`), so a quiet press never reads or
  writes it. A `false` from this function suppresses the **email only** — the
  write still happens and `lastNotifiedAt` still moves, or the bound above
  would reopen precisely when the cap is exhausted (**D16**). When it returns
  `allowed: false`, the counter document is **read but not written**: the count
  is already at the cap and rewriting the same value would put every
  over-cap press back into contention on the one global document, which is
  exactly what consulting it lazily was meant to avoid.
- `decisionTransition(existing, action, ownerSub, now)` for
  `'approve'|'deny'|'revoke'` → the `members/{sub}` and `accessRequests/{sub}`
  bodies, or a refusal reason (`'unknown-request'`, `'self'`). `existing` is
  the **request** document: a decision about an identity that never requested
  is refused, which is what makes `accessRequests` a complete index of every
  decided identity (**D4**).
- `isValidSubParam(raw)` → `/^[A-Za-z0-9_.-]{1,128}$/`.

Async accessors on `getStoreFirestore()` from `server/store.ts` (which is not
modified):

- `readMember(sub)` → `MemberRecord | null`, via `parseMemberDoc(snap.data(),
  sub)` defined above in this same file. Throws only on a genuine Firestore
  error, which callers map to `unknown`/503.
- `recordAccessRequest(identity, now)` →
  `{ outcome: 'recorded'|'quiet'|'already-approved', notify: boolean }`, where
  this `notify` is the **delivery** decision and is defined as
  `notificationEligible && counter.allowed` — the only place the two ideas
  combine, and the only value `server/access.ts` may use to decide whether to
  call `sendMail`. A cap-exhausted press therefore advances the request
  document (`requestCount`, `lastNotifiedAt`) while returning
  `notify: false` —
  `'quiet'` covering every no-write case except an existing membership
  (inside the 24 h window, at the ceiling of 5, or `denied`), all of which
  render identical copy by design (**D16**) — in **two phases**, so the
  common abuse case never opens a
  transaction and never touches shared state:
  1. A plain `.get()` of `accessRequests/{sub}`, then `nextRequestState`. If
     `write` is `false`, return the matching quiet outcome **immediately** —
     no transaction, no write, and crucially **no read of
     `accessRequestMeta/notifications`**. That document is global to the whole
     app, so touching it on every replay would serialize unrelated requesters
     against one another and burn transaction retries on contention; a replay
     flood must not be able to slow down or fail a *different* person's first
     genuine request.
  2. Otherwise one `runTransaction` that re-reads `accessRequests/{sub}`,
     re-applies `nextRequestState` against the re-read value, and — only if
     that result still has `notificationEligible: true` — reads and writes
     `accessRequestMeta/notifications`. The re-read inside the transaction is
     what makes two simultaneous presses idempotent; phase 1 is an
     optimisation and is never the correctness argument. If the re-read now
     says `write: false` (another press won the race), the transaction commits
     nothing.
- `touchRequestIdentity(sub, identity)` — refresh the **displayed** identity
  on an existing request document, and nothing else. It must never create a
  document and never resurrect one: use a plain
  `ref.update({ email, identitySeenAt, ...(name ? { name } : {}) })`, which
  Firestore **fails** with `NOT_FOUND` when the document does not exist —
  exactly the wanted semantics, in one round trip with no transaction. Catch
  and swallow that `NOT_FOUND`. It writes only those field paths, so it can
  never clobber `status`, `requestCount`, `lastNotifiedAt` or a concurrent
  decision, and `name` is **omitted entirely when undefined** rather than
  written as `undefined`. Best-effort, exactly like the existing `upsertUser`:
  wrapped in `try/catch`, logged, and never able to fail a sign-in. Rejected:
  a `set(..., { merge: true })` on either collection — merge *creates*, so a
  request the owner deleted by hand would silently reappear as a
  half-populated personal-data document, and it would race a revocation into
  a partially rewritten record. `members/{sub}` is deliberately **not**
  touched here at all: its `email`/`name` are an approval-time snapshot that
  nothing reads (**D5**).
- `listAccessRequests(cursors)` → **three** `accessRequests` queries, one per
  status, each `where('status','==', s).orderBy(FieldPath.documentId())
  .limit(201)` and `.startAfter(cursors[s])` when a cursor was supplied.
  Returns
  `{ pending: Page, approved: Page, denied: Page }` where
  `Page = { rows, nextCursor: string | null }`: take 201, return the first
  200, and set `nextCursor` to the 200th row's `sub` when a 201st came back.

  Two properties this shape has and the alternatives do not. It needs **no
  composite index**: an equality-filtered query is already ordered by
  `__name__`, so naming that order explicitly is free, whereas
  `where('status','==',…)` with `orderBy('createdAt','desc')` is the textbook
  composite-index request and this feature creates none. And it is
  **complete**: `startAfter(documentId)` is a stable cursor, so every row in
  every section is reachable by paging, which an unordered `.limit(201)`
  never is — that query returns an arbitrary subset, and sorting the subset
  afterwards cannot turn it into "the most recent" anything. The honest
  consequence, carried into the UI in step 10: rows are **selected** in
  document-id order and only **presented** newest-first within a page. Nothing
  anywhere claims global recency.
- `applyDecision(sub, action, ownerSub, now)` → one `runTransaction` over
  `accessRequests/{sub}` and `members/{sub}`.

No `where` + `orderBy` on **different** fields anywhere, so no composite index.

**Verify:** `npm test` — `server/members.test.ts` covers every pure branch.

`parseMemberDoc` ⇒ `null` for: `null`, a string, `{}`, `{ status: 'active' }`
(**the malformed-authorization case — this must deny**),
`{ sub: 'other', status: 'active', approvedAt: 1, approvedBy: 'x' }` (id
mismatch), `status: 'ACTIVE'`, `status: 'pending'`, `approvedAt: '1'`,
`approvedAt: 0`, `approvedAt: NaN`, and `approvedBy: ''`. It returns a record
only for a fully-formed document.

`nextRequestState`, asserting **both** flags on every case, since they are the
write bound and not only the email bound:

- absent ⇒ `write: true`, `notificationEligible: true`, `requestCount: 1`;
- `pending` at `lastNotifiedAt + 23 h 59 m` ⇒ `write: false` **and**
  `notificationEligible: false` — the quiet press writes nothing;
- `pending` at `+ 24 h 01 m` with `requestCount: 4` ⇒ `write: true`,
  `notificationEligible: true`, `requestCount: 5`;
- `pending` with `requestCount: 5` at `+ 30 days` ⇒ `write: false`,
  `notificationEligible: false` — the ceiling stops writes, not just emails,
  and no later `now` reopens it;
- `approved` and `denied`, each at `+ 30 days` ⇒ `write: false`,
  `notificationEligible: false`;
- `write === notificationEligible` for every case in the table — assert it as
  a loop over the fixtures, so a future edit cannot separate them again;
- **idempotence**: called twice with the same `existing` and `now`, the same
  `doc` and the same `notificationEligible` come back — the property the
  in-transaction re-read relies on.

And, for the eligibility-versus-delivery split (the two must not be conflated
again), over `nextNotificationCounter` and the composition rule:

- a counter already at 20 for today ⇒ `allowed: false`, and the counter is
  **not** incremented past 20 however many times it is called;
- the same counter with `now` in the next UTC day ⇒ `allowed: true`, count
  resets to 1;
- **cap-exhausted composition**: `notificationEligible: true` with
  `allowed: false` ⇒ `recordAccessRequest` returns `notify: false` while the
  request document still advances — `requestCount` incremented and
  `lastNotifiedAt` moved. This is the case an earlier draft could not express
  with one field, and it is the one that keeps the write bound closed when the
  cap is exhausted (**D16**);
- `notificationEligible: false` ⇒ the counter is never consulted at all, so no
  quiet press can burn a day's allowance or contend on that document.

Plus `nextNotificationCounter` rolling over at UTC midnight and capping at 20,
and `decisionTransition` refusing `ownerSub === sub` and refusing an absent
request with `'unknown-request'`.

True concurrency, contention and `update()`-on-missing-document cannot be
unit-tested here (there is no Firestore emulator and this plan does not add
one), so they are verified by hand: the replay flood in step 6, and
`touchRequestIdentity` against a deleted request document in step 14.
`npm run build` clean.

**Failure handling:** if Firestore returns `FAILED_PRECONDITION` asking for an
index, a query used `where` + `orderBy` on **different** fields — the only
legal `orderBy` here is `documentId()`; fix the query, do not create an index.
If `touchRequestIdentity` ever creates a document, it is using `set` with
`merge` instead of `update`.

### 3. [core] `server/membership.ts` — the gate, the cache, the architecture lock

Imports `MemberRecord` and `parseMemberDoc` from `server/members.ts` (step 2)
and `readMember` from the same file. The import graph is one-way and must stay
that way: `membership.ts` → `members.ts` → `store.ts`. Nothing in `members.ts`
may import `membership.ts`.

Pure:

```
accessDecision(input: {
  email: string; emailVerified: boolean;
  allowedRaw: string; member: MemberRecord | null;
}): 'owner' | 'member' | 'denied'
```

Order in `accessDecision`: `isAllowed(email, emailVerified, allowedRaw)` ⇒
`'owner'`; else `emailVerified !== true` ⇒ `'denied'`; else
`member !== null && member.status === 'active'` ⇒ `'member'`; else `'denied'`.
Note what this is **not**: there is no `member?.status === 'active'` on a raw
document anywhere in the codebase, because `{ status: 'active' }` with no
`sub`, no `approvedAt` and no `approvedBy` would satisfy that test. The owner
branch is first and deliberately does **not** consult `member`, which is what
keeps the owner's **authorization** working when Firestore is down — not the
owner's data, which still fails (**D12**).

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
  and `storeUnavailable()` (503 JSON `{error:'Store unavailable'}`) for a
  Firestore throw raised **below** the gate, which step 4 wires into
  `server/sync.ts` and `server/photos.ts`. All three send
  `Cache-Control: no-store`. A separate name for the third is worth it: the
  two 503s mean different things to a person reading a log, and the client
  treats both identically, so nothing downstream has to care.

Cache: module-level `Map<string, number>` — `sub` → the ms timestamp at which
an **`active`** membership was confirmed. There is deliberately no boolean and
no room for one: **only active members are stored** (**D11**), so a cache miss
is indistinguishable from "never cached" and always costs one Firestore read.
TTL 60_000 ms; `map.clear()` when `size > 500`. The TTL is exercised through an
injected `now` parameter on the internal lookup so it is testable without
timers.

Also exported, for the OAuth callback, which has no session cookie yet:

```
accessAllows(identity: {
  sub: string; email: string; emailVerified: boolean;
}): Promise<'owner' | 'member' | 'denied' | 'unknown'>
```

This is the function `server/auth.ts` calls in step 4, and it is the same
decision as `requireMember` with the identity taken from the verified id-token
instead of from a cookie. It **never throws**: a Firestore failure resolves to
`'unknown'`. That is not a stylistic choice — `authCallbackGoogle` wraps its
whole body in a `try { … } catch { return respond(400, 'Sign-in failed') }`,
so a thrown Firestore error would surface as a **400 "Sign-in failed"** and the
503 branch in **D12** would be dead code. Returning a discriminated value keeps
the outage visible. `'owner'` short-circuits before any Firestore read, so the
owner can still sign in while Firestore is down; a positive `'member'`
populates the same cache `requireMember` reads.

`server/membership.test.ts` also carries the **architecture lock**, in the
spirit of `src/lib/recipeStore.test.ts`: read the sources with `node:fs`
(paths resolved from `import.meta.url`, not `process.cwd()`) and assert the
six properties below.

**The scan covers production sources only** — every `.ts` under `server/`,
`api/` and `scripts/` **except** files matching `*.test.ts`. This exclusion is
load-bearing, not tidiness: the test files necessarily *contain* the very
strings being banned (this file asserts on `x-sous-user`, and
`api/sessionGate.test.ts` probes that exact header), so a naive repo-wide scan
can never pass.

**The six assertions do not all become true at once, so they are not all
added at once.** Adding an assertion before the code it describes exists
makes step 3 unlandable and teaches whoever hits it to comment out a security
test — the worst possible habit to establish in this particular file. Each
assertion is written in the step that makes it true, and the numbering below
is stable so later steps can name them:

| # | Assertion (over production sources) | Added in |
| --- | --- | --- |
| 1 | `readSession` is referenced only in `server/session.ts`, `server/membership.ts` and `server/auth.ts` | **step 3** |
| 2 | the identifier `sessionFrom` appears nowhere | **step 4** |
| 3 | `api/chat.ts` and `api/import.ts` contain no `@google-cloud` substring | **step 3** |
| 4 | the string `x-sous-user` appears nowhere | **step 3** |
| 5 | `scripts/server.ts` contains both `withMembership(chatPost)` and `withMembership(importPost)`, and **no** bare `handler: chatPost` or `handler: importPost` registration | **step 5** |
| 6 | the identifier `authorizedSub` appears in exactly three production files — `api/chat.ts`, `api/import.ts`, `server/membership.ts` — and nowhere else | **step 5** |

Assertions 1, 3 and 4 are true the moment `server/membership.ts` exists:
`sync.ts` and `photos.ts` still reach for `sessionFrom`, not `readSession`, so
1 holds; 3 and 4 hold vacuously and must keep holding. Assertion 2 cannot pass
until step 4 deletes `sessionFrom`. Assertions 5 and 6 describe registrations
and an argument that step 5 introduces.

What each is for. Assertion 3 is the guard for "no Firestore in a Vercel
function bundle". Assertion 4 is the guard for the handoff doc's banned header
(**D6**): the argument bypass must never drift into a header bypass, and a
future agent who reaches for one trips a test that names the rule. Assertions
**5 and 6** are the guard for the gate itself, and they are the ones that
matter most: the whole design rests on `authorizedSub` being reachable *only*
from `withMembership`, so a future route registered against the bare handler
(which would still 401 correctly on Vercel's inline check, and so would look
fine in casual testing) or a new caller that mints its own `authorizedSub` is
caught by a failing test rather than by a member reporting a 401 — or worse,
by nobody.

**Verify:** `npm test` — and the table must include every one of these:

- `accessDecision`: blank `ALLOWED_EMAILS` (⇒ `denied`, never allow-all),
  whitespace-only `ALLOWED_EMAILS`, `emailVerified: false` with an active
  member (⇒ `denied`), blank email, `status: 'revoked'`, `member: null` for a
  non-owner, and owner-with-`member: null`.
- `accessDecision` with a `MemberRecord` that `parseMemberDoc` (step 2, where
  its rejection table lives) actually produced ⇒ `'member'`, and with `null`
  in that slot ⇒ `'denied'`. This step does not re-test the parser; it tests
  that the gate consumes only parser output.
- Cache, through the injected clock: two lookups inside 60 s read Firestore
  **once**; at 60 001 ms it re-reads; a revoked member is still admitted until
  the TTL expires and denied after it (the documented bound); and — the
  **approval** direction — a lookup that found no document, then an approval,
  then a second lookup **re-reads and returns `member`** with no wait, proving
  nothing negative was cached. A Firestore throw leaves the map empty and
  yields `unknown`, and a following successful lookup is not poisoned.
- Lock assertions **1, 3 and 4** are written and pass, scanning production
  sources only. Assertions 2, 5 and 6 are **not** written yet — steps 4 and 5
  add them. Leave a comment in the test file naming the two that are missing
  and the steps that add them, so a half-finished lock is visibly
  half-finished rather than looking complete.

`npm run build` clean.

**Failure handling:** if the lock test fails on assertion 1 after a later step,
that step added a route that skipped the gate — fix the route, do not widen the
allow-list in the test. If an assertion fails the moment it is written, check
it against the table above before editing any source: it may simply belong to
a later step.

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
- **And in both files, map a Firestore throw raised *below* the gate to
  `storeUnavailable()` (503).** Wrap the body of each of the four handlers,
  after the gate returns `ok`, in a `try/catch` that logs and returns that
  503. This is not tidying: passing the membership gate does nothing to
  translate a failure further down, so without it the owner — whose
  authorization deliberately never touches Firestore — hits an **uncaught
  500** on every sync and photo request during a Firestore outage, while
  **D12** promises 503 for exactly this condition and step 14 checks for it.
  A 500 and a 503 are not interchangeable to this client: 503 is the only
  status the sync engine treats as "try later" without consequence. Verified
  in `src/lib/syncEngine.ts`: `shouldParkPhotoPut` returns `false`
  unconditionally for `status === 503`, and the photo POST path returns
  `{kind:'retry'}` on 503 **before** the `attempts + 1` branch, so a photo
  row cannot park or even accumulate an attempt during an outage; the JSON
  push path returns `stop` either way and parks nothing. So the 503 mapping is
  what keeps photo uploads retryable — the status is load-bearing, and
  changing it later to any other 5xx would start parking rows.
  Nothing else in either handler changes; no new status appears anywhere else.
- `server/auth.ts` `authCallbackGoogle`: replace `isAllowed(...)` with
  `await accessAllows({ sub, email, emailVerified: payload.email_verified })`
  from step 3, switching on its four outcomes. `'owner'` ⇒ unchanged path.
  `'member'` ⇒ `upsertUser` + cookie exactly as today. `'denied'` ⇒ the 403
  page (markup in step 7). `'unknown'` ⇒ a **503** page, not the 403
  (**D12**) — a member must never be told they are uninvited because a read
  failed. Because `accessAllows` returns `'unknown'` instead of throwing, this
  branch is reachable at all: the surrounding
  `try { … } catch { respond(400, 'Sign-in failed') }` would otherwise
  swallow a Firestore error into a generic 400 and the 503 page would be dead
  code. `upsertUser` must still run only **after** a positive decision, so a
  refused identity never creates `users/{sub}`. Every branch keeps going
  through `respond()` so `sous_oauth` is always cleared and
  `Response.redirect()` is never used.
- **Refresh the stored display identity on a member sign-in (D4).** On
  `'member'`, alongside `upsertUser`, call
  `touchRequestIdentity(sub, { email, name })` from step 2. Without it,
  `sub`-keyed membership means a member who changes their Google address keeps
  access (correct) while `/admin` keeps showing the **old** address forever
  (misleading — the owner could revoke the wrong person).

  It writes to **one** document, `accessRequests/{sub}`, because that is the
  only collection `/admin` displays (**D4**), and it uses `update` on named
  field paths, so it **cannot create a document and cannot resurrect one the
  owner deleted by hand**. A `NOT_FOUND` is swallowed. Treat it exactly like
  the existing `upsertUser` helper — the repo's prior art for a best-effort
  write: `try/catch`, log, and **never** fail the sign-in over it. A member
  whose request document was deleted keeps full access (authorization lives in
  `members/{sub}`) and simply stops appearing in the Approved list, which is
  the correct reading of a manual deletion.
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
- `server/membership.test.ts`: add **lock assertion 2** (`sessionFrom` appears
  in no production source), which becomes true for the first time in this
  step, and delete the "missing assertions" comment's line for it.

**Verify:** `npm test` (including the newly added assertion 2), `npm run
build`. Restart `dev:api`. Signed in as the owner at
`http://localhost:5173`: library, a recipe, chat, import and Sync now all
work; `/api/auth/session` returns `isOwner: true`. Then, with
`FIRESTORE_EMULATOR_HOST=localhost:1` set (nothing listening) and `dev:api`
restarted: `GET /api/auth/session` as the owner still returns the user — proof
the owner's **authorization** path never touches Firestore — while
`GET /api/sync/pull` returns **503** (not 500, not 401) and the `dev:api` log
shows the caught store error. Restore afterwards.

**Failure handling:** everything 401s ⇒ `requireMember` is treating `unknown`
as `denied`; check the 503 branch. Sync starts signing the user out on a
Firestore blip ⇒ same bug (401 instead of 503). A 500 from sync or photos
during an outage ⇒ the `try/catch` around the handler body is missing or is
inside the gate rather than around the work. The whole app works for a
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

`api/sessionGate.test.ts`: leave every existing vector exactly as it is (six
per handler; **count them before editing** rather than trusting this number)
and add one assertion that a request carrying an `x-sous-user` header — the
header
`docs/handoff-invitation-only.md` explicitly bans (**D6**) — still yields
`null` from `sessionSub`, documenting that the Cloud Run bypass is an
argument and that no header is trusted by either file.

`server/membership.test.ts`: add **lock assertions 5 and 6**. This step is
where they first become true — the wrapped registrations and the
`authorizedSub` identifier do not exist before it — and it is where the
"missing assertions" comment from step 3 is deleted, because the lock is now
complete.

**Verify:** `npm test` (all previously passing `sessionGate` vectors still
green, including the removed-from-allowlist one; all **six** lock assertions
now present and passing). Confirm assertions 5 and 6 actually bite: temporarily
restore a bare `handler: chatPost`, see the test fail, then put the wrapper
back. `npm run build`.
Restart `dev:api`. As the owner, one chat turn streams and one URL import works.
`node -e "fetch('http://localhost:3001/api/chat',{method:'POST',headers:{'content-type':'application/json','x-sous-user':'1'},body:'{}'}).then(r=>console.log(r.status))"`
⇒ **401**, and the same with `x-sous-user` set to the owner's real `sub` ⇒
**401**. Step 14 proves an approved non-owner member also gets chat and
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

1. Require `Content-Type: application/x-www-form-urlencoded` (415 otherwise),
   then read the body with the **bounded reader** below. A `Content-Length`
   header above 4096 is rejected with 413 before reading, but that check is
   only a fast path — it is not the cap, because the header is attacker-
   supplied and absent entirely under `Transfer-Encoding: chunked`.
2. Parse the returned string with `new URLSearchParams(text)` — no
   `formData()`, no multipart.

The reader lives in `server/membership.ts` beside the other shared response
helpers and is used by **both** this route and the admin POST in step 8:

```
readBoundedText(req: Request, limit: number): Promise<string | null>
```

A `null` `req.body` is an **empty body**, not an error: return `''` and let the
caller's own validation reject it (a missing `t` field ⇒ the 400 expired page;
missing JSON ⇒ 400). Do not write `req.body!` — a bodyless POST is easy to
send and must not throw a 500 out of the bounds check. Otherwise it pulls from
`req.body.getReader()`, accumulating byte lengths, and as soon as
the running total exceeds `limit` it calls `reader.cancel()` and returns `null`
(the caller replies 413). It decodes with a single `TextDecoder` over the
collected chunks. `await req.text()` followed by a length check is **not** a
cap and must not be used on either route: `text()` buffers the entire body into
memory *first*, so an unauthenticated caller — `POST /api/access-request` needs
no cookie — can make the container allocate an arbitrary amount of memory and
be OOM-killed while every check still "passes" afterwards. On Cloud Run with
`--max-instances=4` that is a cheap denial of service against the whole app.
The admin POST applies the same reader, but **after** `requireOwner` has
passed, so an unauthenticated caller never reaches it at all.
3. `verifyAccessRequestTx(params.get('t') ?? '', Date.now())`; `null` ⇒ the
   "link expired" page, **400**.
4. `recordAccessRequest({ sub, email, name }, Date.now())`.
5. If it returns `notify: true`, `await sendMail(...)` — which cannot throw
   (**D15**), so its result only decides logging, never the status code —
   with a plain-text body
   naming the email, the display name, the UTC timestamp and the sentence
   "Approve or decline at https://sous.kyrylo.lol/admin" — a plain URL to the
   owner-authenticated screen, no token, no query string (**D3**).
6. Reply with a self-contained HTML page (markup in step 7): **200** with the
   same recorded copy for both `'recorded'` and `'quiet'` — a repeat press, a
   press at the ceiling and a declined identity are indistinguishable to the
   requester, which is deliberate (**D16**) — and 200 with the "you already
   have access" copy for `'already-approved'`.
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

Two more, both aimed at the fixes above:

- **Replay flood.** Submit the *same* valid token 20 times in a tight loop.
  Expect: 20 × 200, exactly **one** `accessRequests/{sub}` document, and —
  this is the bound from **D16**, so check each in the Firestore console —
  `requestCount` still **1**, `lastNotifiedAt` unchanged after the first,
  **`updatedAt` unchanged after the first** (the strongest single check: it
  proves the 19 quiet presses wrote nothing at all, not merely that they
  wrote the same values), exactly one email, and
  `accessRequestMeta/notifications` `count` incremented **exactly once**, not
  20 times. Then re-mint a *fresh* token for the same identity and submit
  again: still no write, because the window belongs to the identity and not
  to the token.
- **Unbounded body.** Send a chunked request with **no `Content-Length`** and
  more than 4 KB of payload:
  `node -e "const b=new ReadableStream({start(c){c.enqueue(new Uint8Array(2_000_000));c.close()}});fetch('http://localhost:3001/api/access-request',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:b,duplex:'half'}).then(r=>console.log(r.status))"`
  ⇒ **413**, and `dev:api` must still be alive and serving afterwards.

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
HTML ⇒ escaping is missing; fix before step 15.

### 8. [core] Admin API, owner-only and enforced server-side

`server/admin.ts`:

- `GET /api/admin/requests` → `requireOwner`; `unauthenticated` ⇒ 401,
  `forbidden` ⇒ **403** (so an approved member who guesses the URL gets a
  clear, non-leaking refusal), then `listAccessRequests(cursors)` ⇒
  `{ pending, approved, denied }`, each a
  `{ rows, nextCursor: string | null }` page, with `Cache-Control: no-store`.
  Cursors arrive as three optional query parameters — `afterPending`,
  `afterApproved`, `afterDenied` — each the `sub` of the last row the client
  already holds. Validate each with `isValidSubParam` and **ignore** an
  invalid one rather than erroring: a bad cursor is a client bug, and
  restarting that section from the top is a harmless, self-correcting
  response. A Firestore error ⇒ 503.
- `POST /api/admin/decision` → `requireOwner` first, before reading the body.
  Require `Content-Type: application/json` (**D10**), then read the body with
  `readBoundedText(req, 4096)` from step 6 — the same bounded reader, never
  `await req.text()` — replying 413 on `null`. Then
  parse `{ sub, action }`, validate `sub` with `isValidSubParam` and `action`
  against `'approve'|'deny'|'revoke'`, refuse `sub === session.sub` with 409
  `'self'`, then `applyDecision(...)`, then `clearMembershipCache(sub)` on this
  instance, then return the refreshed lists — the **first page** of each
  section, cursors reset — so the screen needs no second round-trip.
  `'unknown-request'` ⇒ 404. Firestore error ⇒ 503. Resetting to page one
  after a decision is deliberate and is stated in step 10's copy: at this
  feature's realistic volume nobody is ever paging, and a decision that
  quietly renumbered pages would be worse than one that visibly returns to
  the top.

Mount both exact paths in `scripts/server.ts`'s `apiRoutes` — no new prefix
matcher, no path parameters.

**Verify:** `npm test`, `npm run build`, restart `dev:api`. As the owner:
`GET /api/admin/requests` ⇒ 200 with the step-6 request in `pending`;
`POST /api/admin/decision` with `{sub, action:'approve'}` ⇒ 200 and a
`members/{sub}` doc with `status: 'active'`. With **no** cookie ⇒ 401 on both.
With `action: 'nope'` ⇒ 400; with a 5 KB body ⇒ 413; with
`Content-Type: text/plain` ⇒ 415; with the owner's own `sub` ⇒ 409.
`GET /api/admin/decision` ⇒ 405. Step 14 covers the member-gets-403 case with
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
export interface AccessRequestPage {
  rows: AccessRequestEntry[];
  /** `sub` to pass back as this section's cursor; null when fully loaded. */
  nextCursor: string | null;
}
export interface AccessRequestLists {
  pending: AccessRequestPage;
  approved: AccessRequestPage;
  denied: AccessRequestPage;
}
export async function fetchAccessRequests(cursors?: {
  pending?: string; approved?: string; denied?: string;
}): Promise<AccessRequestLists>
export async function decideAccessRequest(params: {
  sub: string; action: 'approve' | 'deny' | 'revoke';
}): Promise<AccessRequestLists>
```

`fetchAccessRequests` sends only the cursors it was given, so the no-argument
call is exactly the first page of all three sections.

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
- **Paging, with a claim the query can actually back.** A section whose
  `nextCursor` is non-null renders a **Load more** button beneath its rows
  that calls `fetchAccessRequests` with that cursor for that section and
  **appends the returned rows for that section only**. This is the one subtle
  part: the response always carries all three sections, so a Load more in
  Pending comes back with Pending's *next* page but Approved's and Denied's
  *first* pages.   Appending everything would duplicate every already-loaded row
  in the other two sections. So: merge and re-sort the **requested** section
  only, and for the other two **discard both their rows and their returned
  `nextCursor`, keeping the ones already in state**.

  Keeping their old cursors matters as much as discarding their rows. Their
  returned cursor describes *their first page*, so if Approved had already been
  paged twice, overwriting its cursor would rewind it and its next Load more
  would re-fetch a page the screen already shows. The rule is therefore: a
  section's rows and cursor are only ever updated by a fetch that section
  asked for — the initial load and Refresh ask for all three, a Load more asks
  for exactly one. Rows within what is loaded are
  displayed newest-first. The one `text-ink-muted` line beneath a truncated section says
  so honestly — that this section has more entries and loads 200 at a time —
  and **must not** say "the most recent 200", because the query selects in
  account-id order, not by date (**D5**). Recency is a presentation detail
  within a page, not a selection guarantee, and the previous wording promised
  something no index-free Firestore query here can deliver. Approving or
  declining reloads all three sections from their first page; that is the
  documented behaviour, not a bug, and at this volume it is invisible.
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
Refresh re-fetches. With a real `nextCursor` — force it by temporarily
lowering the page size in `listAccessRequests` to 2 and seeding three request
documents — **Load more** appends the next rows exactly once and then
disappears, **and no row in Approved or Declined is duplicated by that click**
(seed one decided request too, so there is something in another section that
could double). Then the cursor-preservation case, which is the one a naive
merge fails: seed enough rows that **two** sections page, press Load more twice
in Pending, then once in Approved, then once more in Pending — the second
Pending click must continue from where it left off, with **no row repeated and
none skipped**. Restore the page size afterwards and confirm the button is gone
with real data. Check 375 px and desktop, dark and light. Reload directly
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
   `die` on an empty value. It keeps the same precedence (environment → the
   deployed service via `read_deployed_env` → interactive prompt), and it keeps
   `strip_controls` and the non-printable warning.

   **It must also provide a way to remove an already-deployed key**, which a
   plain copy of `resolve_secret` cannot: once `RESEND_API_KEY` is on the
   service, the read-back step finds it on every subsequent run, so pressing
   Enter at the prompt would silently reuse it and the key could never be
   turned off. So: if the environment variable `SOUS_DISABLE_RESEND` is
   non-empty, then

   ```bash
   unset RESEND_API_KEY
   ```

   — an explicit `unset`, before the `node -e` runs — and skip resolution
   entirely, with an `info` that notification email is being disabled.

   The `unset` is the whole point of the branch and is not optional. Merely
   *skipping resolution* leaves any `RESEND_API_KEY` that was already
   exported in the operator's shell (or sourced from `.env.local`, or left
   over from an earlier `resolve_*` in the same run) sitting in the
   environment that the `node -e` inherits — and that generator reads
   `process.env`, so the key would be written straight back into the YAML and
   the disable flag would silently do nothing. `unset` makes the variable
   absent for the generator, the key is omitted from the YAML, and because
   `--env-vars-file` replaces the **whole** map, omission is exactly what
   deletes it from the service. Document the one-liner
   (`SOUS_DISABLE_RESEND=1 bash scripts/deploy.sh`) in `README.md`. An empty
   answer at the prompt on a **first** deploy also just leaves it unset, which
   is the documented "no Resend account yet" path (**D15**).

   `resolve_secret` and `resolve_session_secret` are otherwise untouched;
   `SESSION_SECRET` still may not be regenerated on a failed describe.
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

**Verify:** `bash -n scripts/deploy.sh` clean. Then check the env map by
**exact name set**, not by counting lines — a count is what lets a swap hide.
The map today holds **eight** keys (`GEMINI_API_KEY`, `AUTH_GOOGLE_ID`,
`AUTH_GOOGLE_SECRET`, `SESSION_SECRET`, `ALLOWED_EMAILS`, `PUBLIC_ORIGIN`,
`GOOGLE_CLOUD_PROJECT`, `PHOTO_BUCKET`); this step makes it **ten** required
(`MAIL_FROM`, `OWNER_NOTIFY_EMAIL`) and **eleven** when `RESEND_API_KEY` is
set.

Run the `node -e` env-map line in isolation against a throwaway `$ENV_FILE`
with dummy values, and compare the YAML's key set against that expected list
with a sorted diff — every required name present, no name lost, and
`RESEND_API_KEY` present only when it was set:

- `RESEND_API_KEY` unset ⇒ **ten** keys, no `RESEND_API_KEY:` line;
- `RESEND_API_KEY` set ⇒ **eleven**;
- `SOUS_DISABLE_RESEND=1` with a key still on the service ⇒ **ten**, proving
  the key is actually removable;
- **both set at once** — `RESEND_API_KEY=whatever SOUS_DISABLE_RESEND=1` in
  the same environment ⇒ **ten**, and `Select-String` for the key's *value*
  in the generated YAML prints nothing. This is the case the `unset` exists
  for and the one a "skip resolution" implementation quietly fails; run it
  every time `deploy.sh` is touched;
- any *required* value empty ⇒ still `process.exit(2)`, so a missing
  `SESSION_SECRET` or `ALLOWED_EMAILS` remains a hard failure and never a
  silently shortened map.

Print **names only** throughout — never a value. Diff `.env.example`'s key list
against the keys present in `.env.local` the same way, without printing values.
`Select-String -Path scripts/deploy.sh -Pattern 'set-env-vars'` prints
nothing. Both dev servers still boot from the existing `.env.local`.

**Failure handling:** if the `keys` array and the `resolve_*` calls disagree,
the next deploy either dies at `process.exit(2)` or silently drops a variable
— re-read both places before step 15. If `node -e` prints nothing under Git
Bash, it was written across multiple lines; it must stay one line.

### 12. [core] `docs/handoff-invitation-only.md` — extend the briefing, commit it

This file is the standing "why Sous is invitation-only" briefing for a later
agent, and after step 4 it describes a mechanism that no longer exists. Left
alone it would tell a future reader to reject the Firestore `members`
collection as exactly the kind of change it forbids, and to grant admin rights
by editing an env var. **Extending the mechanism, not loosening the policy** —
every fail-closed rule in the document survives verbatim or strengthened, and
nothing in this step relaxes a single one.

Edits, section by section:

- **Header / code citations.** Keep the opening prohibition ("Do not 'open' the
  app by emptying `ALLOWED_EMAILS`, treating a blank list as allow-all, or
  leaving OAuth in Testing") **unchanged**. Repoint the `Code:` line:
  `server/session.ts` is no longer where the per-request re-check lives — name
  `server/membership.ts` (`accessDecision`, `requireMember`, `requireOwner`),
  `server/members.ts`, and `server/allowlist.ts`, and add
  `docs/plans/invitation-flow.md` beside the parent plan.
- **What "invitation-only" means.** Keep the In-production / published-but-
  private framing and the 403 description. Add the second tier: admission is
  now `ALLOWED_EMAILS` (owner/bootstrap, fail-closed, **and the admin
  authority**) **or** an `active` record in Firestore `members/{sub}` written
  by the owner from `/admin`. State that a non-member still gets exactly the
  same 403 with no `sous_session` and the same `sign-in refused:` log line —
  only now that page also offers **Request access**, and that approval is
  effective with **no redeploy**.
- **Why (product).** Replace "Adding a second allowlisted email is one env
  value and one redeploy" with: a second person requests access from the 403,
  the owner approves at `/admin`, and no redeploy is involved. Keep "Libraries
  are keyed by Google `sub`, not a shared household account", "that person
  gets **their own empty library**", and "No shared library is designed" —
  those are still true and still binding.
- **Why (billing and data).** Keep the whole argument. Strengthen it: the gate
  in front of `GEMINI_API_KEY` and `users/{uid}/…` is now two tiers, so both
  must fail closed, and the `/admin` screen is the only way to widen the
  second one. Keep the `deploy.sh` / `--env-vars-file` paragraph as is, and
  note that `MAIL_FROM`, `OWNER_NOTIFY_EMAIL` and the optional
  `RESEND_API_KEY` joined that map.
- **Why not Google Testing instead.** Unchanged.
- **Fail-closed rules (do not invert).** Keep all four `server/allowlist.ts`
  rules, the empty-list-is-not-allow-all warning, and the no-second-gate
  paragraph, **verbatim**. Keep the `x-sous-user` ban **verbatim** and add one
  sentence: on Cloud Run the inline check is bypassed by an explicit
  in-process function argument from `scripts/server.ts` after
  `requireMember` passed — not by anything on the wire — and
  `server/membership.test.ts` asserts the banned header name appears nowhere
  (**D6**). Then add the new tier's rules:
  - a `members/{sub}` doc that is absent, or whose `status` is not `active`,
    denies;
  - `email_verified === true` is still required, and is checked in the
    callback before any token or cookie exists;
  - a Firestore read that **throws** denies — with **503**, never 401, so a
    blip does not sign anyone out (**D12**);
  - `ALLOWED_EMAILS` is still re-parsed on **every** protected request with
    **no cache**, so removing an owner still takes effect on the next request;
    the Firestore tier is cached for at most **60 seconds** per container
    instance, which is the one documented bound on revocation (**D11**).
- **If you need a second person.** Rewrite the section body: point at `/admin`,
  and warn that adding an ordinary person to `ALLOWED_EMAILS` makes them an
  **administrator** who can approve and remove members (**D7**). Keep "Do not
  invent household sharing, a shared `uid`, or a 'fix' that makes blank mean
  everyone" and "Unverified Google emails stay denied" **verbatim**.
- Add a short **Access requests** section: what is stored for a non-member
  (email, display name, `sub`, timestamps in top-level `accessRequests/{sub}`,
  and nothing under `users/`), that the notification email carries **no
  approval power** (**D3**), and the dedupe/throttle/cap numbers (**D16**).

Then **commit the edit**. The file is now tracked on this branch, but it
reached that state the hard way: it was lost once to a stash while
uncommitted, which is the only reason this plan had to reconstruct its rules
from the code. Do not leave this rewrite sitting unstaged — a briefing that
exists only in a working tree cannot do its job.

**Verify:** read the revised document straight through and check that (a) every
one of the four `server/allowlist.ts` rules, the empty-list warning, the
no-second-gate paragraph and the `x-sous-user` ban still appear; (b) no
sentence tells a reader to admit an ordinary member by editing
`ALLOWED_EMAILS` or by redeploying; (c) the `Code:` citations name files that
exist after step 4 —
`node -e "for (const f of ['server/membership.ts','server/members.ts','server/allowlist.ts']) console.log(f, require('node:fs').existsSync(f))"`
prints `true` three times; (d) `git status --short` is clean for
`docs/handoff-invitation-only.md` after the commit. Cross-read it
against `AGENTS.md` from step 11 and confirm the two agree on the tiers, the
admin rule and the 60-second bound.

**Failure handling:** if any fail-closed rule reads weaker than the original,
revert that paragraph to the original wording and re-apply only the additive
sentence — this step may not become the loophole the document warns about. If
`AGENTS.md` and this file disagree on the revocation bound or on who is an
admin, fix both before step 15; a future agent reading one and not the other
is exactly the failure this step exists to prevent.

### 13. [ui] Privacy and terms

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
- **Retention and deletion** must cover **all four** records this feature can
  create, not just the two that are easy to describe. Pending requests are kept
  until decided. A declined request is kept **indefinitely, until it is deleted
  by hand**, because that record is what stops a repeat press from re-notifying
  (**D16**). An **approved** request document is likewise kept indefinitely —
  it is what `/admin` lists (**D4**) — and so is `members/{sub}`, which is the
  authorization record itself and therefore lasts as long as the person has
  access; revoking sets its `status` to `revoked` rather than deleting it, so a
  revoked person still has a row. Say all of that explicitly.

  Also state what a **deletion request covers**, since a member has recipes as
  well as a membership: on request to the contact address, all of
  `accessRequests/{sub}`, `members/{sub}` and the person's `users/{sub}` data
  (recipes, chats, cook state and photos) are deleted, which also removes their
  access. Deleting only the request document would leave an authorization
  record and a whole library behind, which is the kind of half-answer that
  makes a privacy page wrong.

  **And write the procedure down, in `README.md` alongside the step-11 note, or
  the promise is unbacked.** Two Firestore behaviours make the obvious version
  wrong: deleting `users/{sub}` in the console **does not** delete its
  subcollections (the orphaned documents survive and stay queryable by path),
  and nothing in Firestore touches GCS. The procedure is therefore, in order:

  **Revoke access first, and only then delete data.** The order is not
  cosmetic: membership is cached positively for up to 60 s (**D11**), so a
  member whose library you delete while they are still authorized can have
  their client push the whole thing straight back on its next sync — you would
  be racing `syncEngine`, and the visible result is a "deleted" library that
  quietly reappears.

  1. Set `members/{sub}.status = 'revoked'`, **or** delete the document
     outright — either one denies immediately. Revoking is the gentler first
     move because it is reversible if you have the wrong person.
  2. **Wait out the cache and verify denial** before touching any data: after
     60 s that person's `/api/auth/session` must return `user: null` and their
     sync must 401. Only now is the data safe to remove.
  3. **Delete `members/{sub}`** if step 1 only revoked it. A revoked record is
     still a stored record of that person, so leaving it behind would satisfy
     the *access* half of the request while quietly failing the *deletion*
     half — the promise on the privacy page is deletion, not denial.
  4. Recursively delete the `users/{sub}` subtree. `gcloud` has **no**
     single-document recursive delete (`gcloud firestore bulk-delete` targets
     collections, not one document's subtree), so use the client library that is
     already a dependency — `@google-cloud/firestore` ^9.1.0, whose
     `recursiveDelete` does exactly this:

     ```
     node -e "const {Firestore}=require('@google-cloud/firestore');const db=new Firestore({projectId:'cooking-assistant-508423'});db.recursiveDelete(db.doc('users/'+process.argv[1])).then(()=>console.log('deleted'),(e)=>{console.error(e.message);process.exit(1)})" <SUB>
     ```

     It needs local ADC with the quota project set (see Assumptions). Deleting
     `users/{sub}` on its own in the console is **not** sufficient — Firestore
     does not delete subcollections with their parent, so `recipes`, `chats`,
     `cookState` and the rest would survive as orphans that are still
     queryable by path.
  5. `accessRequests/{sub}` — a single document delete.
  6. The photo objects, which nothing above touches:
     `& $gcloud storage rm --recursive gs://sous-photos-cooking-assistant-508423/users/<SUB>/ --project=cooking-assistant-508423`.
  7. Verify absence, **naming all four records** rather than eyeballing the
     console: `members/{sub}` gone, `accessRequests/{sub}` gone, the
     `users/{sub}` subtree gone (re-run the `recursiveDelete` — it succeeds
     trivially on an empty subtree — then confirm the document and its
     subcollections are absent), and the bucket prefix empty. A single
     `node -e` that `.get()`s the two top-level documents and prints
     `snap.exists` for each is the least error-prone form; both must print
     `false`.

  If anything after step 1 fails partway, the person is already denied but data
  remains **present though unreachable through the app** — finish the procedure
  rather than stopping at "they can't sign in any more". Any of the four
  records can be deleted on request to the contact address. State
  plainly that **there is no automated purge job** — do **not** write "kept for
  up to 12 months" or any other period. Nothing in this plan deletes an
  access-request document on a schedule, so a stated retention period would be
  a promise the code does not keep, in the one document that is supposed to be
  legally accurate. The procedure above belongs in `README.md`
  in step 11 so it is findable: delete the `accessRequests/{sub}` document (and
  `members/{sub}` if present) in the Firestore console. If a real retention
  window is ever wanted, it needs a scheduled job and its own plan.
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
point at the live copies, so this must be in `dist/` before step 15.

**Failure handling:** the Branding URLs **are** already published
(`deploy-and-end-state` step 4 is ticked), so these two pages are live
documents that Google's consent screen points at right now. A deploy that
ships this feature with legal copy that does not mention access requests or
Resend is the failure. Do not deploy step 15 before this step is in the image.

### 14. [core] Local end-to-end by hand, two Google accounts

`npm run dev` + `npm run dev:api`, `http://localhost:5173`, `RESEND_API_KEY`
set only if you intend to send a real email (it goes to the owner's real
inbox). Account A = owner, in `ALLOWED_EMAILS`. Account B = any second real
Google account, **not** in `ALLOWED_EMAILS`. The consent screen is In
production, so B needs no console change and no test-users entry — it can
complete consent today and land on the current 403.

1. Account B, separate browser profile: Settings → Sign in with Google →
   consent → the **403 invitation-only** page with the Request access button.
   No `sous_session` cookie is set; `document.cookie` shows no `sous_oauth`
   either (it is cleared on every branch).
2. Press Request access ⇒ the recorded page. Firestore has one
   `accessRequests/{B-sub}` doc with `status: 'pending'`, `requestCount: 1`.
   No `users/{B-sub}` document exists. One email arrives (or the disabled
   notice is in the `dev:api` log).
3. Press again via Back ⇒ **the same copy, and no write at all**:
   `requestCount` stays **1**, `lastNotifiedAt` unchanged, `updatedAt`
   unchanged, no second email. An immediate second press is inside the
   24-hour window, so under **D16** it is a pure read — expecting
   `requestCount: 2` here would mean the write bound had been lost. Note the
   document's `updatedAt` before pressing so the comparison is real.
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
10. **Put B back to an approved, signed-in member before the outage test** —
    the next bullet needs a live member session, and bullets 8 and 9 left B
    revoked with no cookie. Account A: `/admin` → **Declined** → Approve on B
    (the request document is still there, which is why this works and why
    nothing before this point may delete it). Account B: sign in again and
    confirm the app loads with B's recipe still present.
11. Stop `dev:api`'s Firestore access (`FIRESTORE_EMULATOR_HOST=localhost:1`,
    restart). Note what this does and does not prove: **every** Firestore-backed
    operation now fails for everyone, so "A still syncs" is impossible and is
    not the claim. What must hold is that **authorization** survives for the
    owner and that nobody is signed out:
    - Account A can still complete sign-in (the `'owner'` branch of
      `accessAllows` returns before any Firestore read) and
      `GET /api/auth/session` still returns A's user with `isOwner: true`.
    - A's `/api/sync/pull`, `/api/sync/push` and `/api/photos/:id` **fail with
      exactly 503** — not 401, and **not 500**. Check the status in the
      Network panel, not merely that something went wrong: the 503 comes from
      step 4's explicit `storeUnavailable()` mapping, and without it these
      would be uncaught 500s, which the client handles differently. The
      client shows a sync failure, the cached library still opens, A is
      **not** signed out, and no toast says "Synced".
    - **Nothing parks.** Queue a photo while the outage is on, then check
      `db.outbox` in the console: the `photo.put` row's `attempts` has **not**
      increased and `isPhotoPutRowParked` is `false` for it, because
      `shouldParkPhotoPut` returns `false` for 503 unconditionally. After the
      restore, that photo uploads on the next sync with no manual step. A
      photo silently parked by an outage would be a data-loss-shaped bug that
      surfaces days later.
    - Account B's `/api/auth/session` returns **503** with the cookie
      untouched, and B's client shows `offline` with its cached user, **not**
      signed out.
    - `/admin` shows its error line, not an empty-but-successful list.

    Restore afterwards and confirm both accounts recover with no re-sign-in.
12. **Last, because it is destructive:** the `touchRequestIdentity` check, which
    no unit test can cover. Delete `accessRequests/{B-sub}` by hand in the
    console, have B sign in again, and confirm the document is **not**
    recreated — B keeps full access (authorization is `members/{B-sub}`, not the
    request) and simply stops appearing in `/admin`'s Approved list. A
    reappearing half-populated document means the write used `set`/`merge`
    instead of `update`.

    This bullet runs **after** every other one on purpose. Deleting the request
    document is a one-way door for the rest of the script: `decisionTransition`
    refuses `'unknown-request'`, so once it is gone the owner can no longer
    approve, decline or revoke B from `/admin` at all, and B vanishes from all
    three lists. Do not move it earlier.

    **Then clean up, before step 15 and before walking away.** This is not
    tidiness: `dev:api` talks to **real production Firestore** (see
    Assumptions), so whatever this bullet leaves behind is the live state of the
    app. Left as-is it leaves B an **active member who is invisible in
    `/admin`** and cannot be revoked through the UI at all — the worst possible
    resting state, and one nobody would notice later. Finish with:

    Follow **step 13's procedure, in its order** — revoke, verify, then delete —
    because B's browser is still open and still holding a session:

    1. Delete `members/{B-sub}` by hand in the console (`/admin` cannot do it —
       that is the point of this bullet).
    2. Wait out the positive membership cache — up to 60 s (**D11**) — then
       confirm B is actually denied: B's `/api/auth/session` returns
       `user: null` and B's next sign-in lands on the 403 page. **Do not skip
       to step 3 before this passes.** B's client is live and still syncing; if
       it is still authorized when you delete the library, its next sync pushes
       B's recipe back and the deletion silently undoes itself.
    3. Delete B's test library with the `recursiveDelete` one-liner from step
       13 on `users/{B-sub}`, plus any photo objects under
       `gs://…/users/{B-sub}/`. B's recipes were created only for this test.
    4. Optionally recreate `accessRequests/{B-sub}` if you want B available for
       future testing; otherwise B starts clean as a first-time requester,
       which is itself a useful state to be in.
13. `npm test` and `npm run build` both clean.

**Verify:** every numbered bullet, done once by hand, **in order** — bullets 8
through 12 form a chain (revoke → denied → re-approve → outage → destructive
delete) and reordering them makes later ones impossible rather than merely
inconvenient. 6, 7 and 8 are the three that cannot be replaced by a unit test.

**Failure handling:** B gets 401 on chat but syncs ⇒ step 5's wrapper. B sees
A's recipes ⇒ **stop everything**: `uid` is being taken from somewhere other
than the session; that is the one unrecoverable bug in this plan. B's client
signs out on the Firestore outage ⇒ a 401 where a 503 belongs.

### 15. [core] Production deploy and live verification *(operational)*

Record the rollback target first:

```powershell
$gcloud = "C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$P = 'cooking-assistant-508423'
& $gcloud config get account
& $gcloud run services describe sous --region=europe-west1 --project=$P --format="value(status.latestReadyRevisionName)"
```

Write that revision into the parent Deploy record, then from Git Bash at the
repo root on a commit containing steps 1–14:

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
for the bad token. `/privacy` must be the step-13 copy. Then sign in as the
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
  administrator, and it is exactly what `docs/handoff-invitation-only.md`
  currently *instructs* a future agent to do. Four documents warn about it
  after steps 11–13; nothing enforces it.
- **`docs/handoff-invitation-only.md` has been lost once already** — stashed
  while untracked when a cloud agent was launched, which is why this plan's
  first draft had to reconstruct its rules from `server/allowlist.ts` and
  `server/auth.ts`. It is committed on this branch now; the residual risk is
  that step 12's rewrite is left unstaged, which would put the repo's only
  statement of *why* the app is invitation-only back in a working tree alone.
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
- **Inbox spam and Firestore writes are bounded but not zero.** Each
  notification costs the attacker a fresh Google account plus a completed
  consent; per identity the cap is 5 notifications ever and 1 per 24 h, and
  globally 20 per UTC day (**D16**). Because the write window *is* the
  notification window, the same numbers bound the writes: at most 5
  requester-driven writes per identity, ever, and one document per consenting
  account. What remains unbounded, and cannot be bounded at this layer, is
  **document count against fresh Google accounts** — someone willing to
  create accounts can create one small document each. Mitigation if it ever
  happens: delete the junk in the console and, if it is sustained, this needs
  a real rate limit keyed on something other than identity, which is a
  different plan.
- **This deploys straight to production, with no staging.** Step 15 records the
  rollback revision before anything else for that reason.

## Open Questions

**No blocking questions remain.** The two that blocked the first draft are
resolved. `docs/handoff-invitation-only.md` is present and committed on this
branch, and its fail-closed rules have been read in full: all of them are
preserved, its `x-sous-user` ban is quoted in **D6** and satisfied, and step
12 extends the document rather than leaving it to contradict the code.
`docs/plans/deploy-and-end-state.md` lives on its own branch by design; its
state is recorded in **Ordering** (steps 1–4 done, 5–7 pending) and nothing
here needs the file itself. The consent screen is **In production**, so no
OAuth console change is needed anywhere in this plan.

- Non-blocking: does a Resend account already exist, and is `kyrylo.lol`
  verified there? Default assumed in step 1 is the sandbox sender
  (`MAIL_FROM=onboarding@resend.dev`, delivery to the owner's own address
  only), which is enough for v1 and is env-configurable later.
- Non-blocking: **D7** reuses `ALLOWED_EMAILS` as the admin set rather than
  adding `ADMIN_EMAILS`. If the owner would rather have them separate, it is a
  small change: a new `adminEmails()` getter, one line in `requireOwner`, a
  `resolve_secret` + `keys` entry in `deploy.sh`, and a paragraph in step 12's
  handoff rewrite.
- Non-blocking: declined requests are kept **indefinitely, until deleted by
  hand** (step 13's copy, and there is no purge job anywhere in this
  architecture). That record is what keeps a declined identity from
  re-notifying. If the owner prefers deletion on decline instead, drop the
  `denied` state and accept that a declined person can request again — and
  re-notify — after 24 h.

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
- [ ] 12. [core] `docs/handoff-invitation-only.md` — extend the briefing, commit it
- [ ] 13. [ui] Privacy and terms
- [ ] 14. [core] Local end-to-end by hand, two Google accounts
- [ ] 15. [core] Production deploy and live verification *(operational)*
