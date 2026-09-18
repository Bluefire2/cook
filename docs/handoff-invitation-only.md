# Handoff: why Sous is invitation-only

For a later session or agent. This is a product and security decision, not a
temporary Google-console setting. Do not "open" the app by emptying
`ALLOWED_EMAILS`, treating a blank list as allow-all, or leaving OAuth in
Testing.

Parent plan: `docs/plans/sous-oauth-db.md` (Allowlist fail-closed; Open
Question 1; Risks: publishing). Cutover: `docs/plans/deploy-and-end-state.md`
step 4. Code: `server/allowlist.ts`, `server/auth.ts` (403 HTML, no cookie),
`server/session.ts` (re-check on every protected request). User-facing copy:
`public/privacy.html` Access, `public/terms.html` What Sous is.

## What "invitation-only" means

Google Auth Platform Audience is **In production**. Any Google account can
finish consent titled **Sous** (identity scopes only: `openid`,
`userinfo.email`, `userinfo.profile`).

Admission is **after** that, in our callback. `ALLOWED_EMAILS` is a
comma-separated list. An email that is not on it (or `email_verified` is not
true, or the variable is unset/blank) gets **403**, HTML
"This app is invitation-only.", a link to `/privacy`, **no** `sous_session`,
and a log line `sign-in refused: <email>`. That 403 is the intended shape of
**published but private**. It is not a misconfigured consent screen.

The live list is one address: `chernyshov.k@gmail.com`. Comparison is
lowercased and trimmed.

## Why (product)

Sous is a personal recipe book with a Gemini cooking assistant, not a public
SaaS. It exists for one person. Libraries are keyed by Google `sub`, not a
shared household account. Adding a second allowlisted email is one env value
and one redeploy; that person gets **their own empty library**. No shared
library is designed. A second identity was out of scope for the Phase 2
cutover.

## Why (billing and data)

Publishing consent makes the sign-in page world-reachable. `ALLOWED_EMAILS` is
then the only gate between an arbitrary Google account and:

- the `GEMINI_API_KEY` bill (chat + import become an open proxy if this fails
  closed in the wrong direction)
- the owner's Firestore + GCS data under `users/{uid}/…`

HMAC on `sous_session` only proves we issued the cookie. The allowlist is
access control. It is re-parsed on **every** protected request (sync, photos,
chat, import, session refresh), not only at cookie issue. Removing an email
must take effect on the next request, not at 90-day cookie expiry.

`scripts/deploy.sh` always writes `ALLOWED_EMAILS` into the env map
(`--env-vars-file` replaces the whole map). Forgetting it is a 403 outage for
the owner, which is the correct fail, not an open proxy.

## Why not Google Testing instead

Testing only lets listed test users sign in, and grants expire after about a
week. That later looks like a session bug. The product rule is: **do not
leave the app in Testing.** Privacy is `ALLOWED_EMAILS`, not Google's test
user list.

## Fail-closed rules (do not invert)

`server/allowlist.ts`:

- blank or whitespace-only `ALLOWED_EMAILS` → deny everyone
- `email_verified !== true` → deny
- missing/blank email → deny
- otherwise membership in the parsed set

A future refactor that treats an empty list as "allow all" would quietly turn
the app into an open Gemini proxy. Do not add that. Do not add a second gate
(`APP_PASSWORD` was removed on purpose: a shared password keeps working after
someone is dropped from the list).

The Vercel copies of `api/chat.ts` and `api/import.ts` re-check the allowlist
inline. Do not replace that with a client-supplied `x-sous-user` header.

## If you need a second person

Set `ALLOWED_EMAILS` to a comma-separated list, redeploy, and expect a
**separate** empty library for the new `sub`. Do not invent household sharing,
a shared `uid`, or a "fix" that makes blank mean everyone. Unverified Google
emails stay denied.
