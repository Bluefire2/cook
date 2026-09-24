# Handoff: why Sous is invitation-only

For a later session or agent. This is a product and security decision, not a
temporary Google-console setting. Do not "open" the app by emptying
`ALLOWED_EMAILS`, treating a blank list as allow-all, or leaving OAuth in
Testing.

Parent plan: `docs/plans/sous-oauth-db.md` (Allowlist fail-closed; Open
Question 1; Risks: publishing). Invitation flow:
`docs/plans/invitation-flow.md`. Cutover: `docs/plans/deploy-and-end-state.md`
step 4. Code: `server/membership.ts` (`accessDecision`, `requireMember`,
`requireOwner`), `server/members.ts`, `server/allowlist.ts`. User-facing copy:
`public/privacy.html` Access, `public/terms.html` What Sous is.

## What "invitation-only" means

Google Auth Platform Audience is **In production**. Any Google account can
finish consent titled **Sous** (identity scopes only: `openid`,
`userinfo.email`, `userinfo.profile`).

Admission is **after** that, in our callback. There are two tiers:

1. **`ALLOWED_EMAILS`** — owner/bootstrap list, fail-closed (blank = nobody).
   Every address here is an **owner/admin** who can manage invitations at
   `/admin`. Re-parsed on every protected request with no cache.
2. **Firestore `members/{sub}`** with `status: 'active'` — ordinary members
   the owner approved from `/admin`, or who redeemed a single-use invite
   link the owner minted there. Keyed by Google **`sub`**, effective on the
   next request with **no redeploy**.

An email that is not admitted (not owner, no active member record), or
`email_verified` is not true, or `ALLOWED_EMAILS` is unset/blank, gets **403**,
HTML invitation-only page with **Request access**, a link to `/privacy`, **no**
`sous_session`, and a log line `sign-in refused: <email>`. That 403 is the
intended shape of **published but private**. It is not a misconfigured consent
screen.

The live owner list is one address: `chernyshov.k@gmail.com`. Comparison is
lowercased and trimmed.

## Why (product)

Sous is a personal recipe book with a Gemini cooking assistant, not a public
SaaS. It exists for one person. Libraries are keyed by Google `sub`, not a
shared household account. A second person **requests access** from the 403 page;
the owner approves at **`/admin`**; **no redeploy** is involved, and that person
gets **their own empty library**. An admitted member can later be granted
view-only access to a **named collection** by email; that is not a household
`uid` and does not share the default library. A second identity was out of
scope for the Phase 2 cutover.

## Why (billing and data)

Publishing consent makes the sign-in page world-reachable. Admission is then a
**two-tier** gate between an arbitrary Google account and:

- the `GEMINI_API_KEY` bill (chat + import become an open proxy if this fails
  closed in the wrong direction)
- the owner's Firestore + GCS data under `users/{uid}/…`

Both tiers must fail closed. **`/admin`** is the only supported way to widen
the member tier: approve a request, or mint a single-use invite link that the
person redeems at Google consent. Do not add ordinary members to
`ALLOWED_EMAILS`.

HMAC on `sous_session` only proves we issued the cookie. The allowlist and
membership checks are access control. They are re-evaluated on **every**
protected request (sync, photos, chat, import, session refresh), not only at
cookie issue. Removing an owner email from `ALLOWED_EMAILS` must take effect on
the next request, not at 90-day cookie expiry.

`scripts/deploy.sh` always writes the full env map (`--env-vars-file` replaces
the whole map). Forgetting a key deletes it on the next deploy. Forgetting
`ALLOWED_EMAILS` is a 403 outage for the owner, which is the correct fail, not
an open proxy. The map now also includes **`MAIL_FROM`**, **`OWNER_NOTIFY_EMAIL`**,
and optional **`RESEND_API_KEY`**.

## Why not Google Testing instead

Testing only lets listed test users sign in, and grants expire after about a
week. That later looks like a session bug. The product rule is: **do not
leave the app in Testing.** Privacy is admission policy, not Google's test
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
inline. Do not replace that with a client-supplied `x-sous-user` header. On
Cloud Run the inline check is bypassed by an explicit in-process function
argument from `scripts/server.ts` after `requireMember` passed — not by anything
on the wire — and `server/membership.test.ts` asserts the banned header name
appears nowhere in production sources.

**Firestore member tier (additive):**

- a `members/{sub}` doc that is absent, or whose `status` is not `active`,
  denies;
- `email_verified === true` is still required, and is checked in the callback
  before any token or cookie exists;
- a Firestore read that **throws** denies — with **503**, never **401**, so a
  blip does not sign anyone out;
- `ALLOWED_EMAILS` is still re-parsed on **every** protected request with
  **no cache**, so removing an owner still takes effect on the next request;
  the Firestore tier is cached for at most **60 seconds** per container
  instance, which is the one documented bound on revocation.

## If you need a second person

Use **`/admin`** (Settings → Invitations for owners): they request access from
the 403 page and you approve there, **or** you mint a single-use invite link
and they sign in through it. **Do not** add an ordinary member to
`ALLOWED_EMAILS` — every address in that variable is an **administrator** who
can approve and remove members. Do not invent a household `uid` or a "fix"
that makes blank mean everyone. Named-collection view grants are the only
sharing path. Unverified Google emails stay denied.

## Sharing limits and privacy boundaries

Sharing is view-only for named collections and never changes the per-`sub`
library model. A viewer refresh performs a **full positional reread** of live
incoming grants and current collection contents, not an `updatedAt` delta.
Successful refresh publishes owned and shared rows atomically. If the owned
pull completes but the shared pull has a non-auth failure, Sous publishes that
completed owned-only snapshot, removes stale shared rows, and reports the
existing refresh error. A shared 401/403 still follows the signed-out path.

Successful sign-in writes both display `email` and normalized `emailLower`.
Add-by-email queries `emailLower` first, then uses exact normalized `email`
only as a fallback for legacy profiles whose stored email is already
lowercase. A successful add versus the generic not-found response provides an
account-existence signal. That is a conscious invitation-only product choice;
keep failures generic and do not make them more revealing.

Shared-photo metadata is only an index to the photo's parent recipe. Every
authorization still requires a freshly read incoming share, a live
collection, `canViewRecipe`, and `recipeListsPhoto`; metadata alone grants
nothing. Ask text works for shared recipes, but Ask photo attachments are
intentionally unavailable. Backup export omits shared-parent viewer chat and
its attachments.

There is no viewer leave-shared-collection flow. Revocation removes access,
but viewer-owned chat for that shared recipe may remain orphaned server-side.
Do not add leave UI, orphan cleanup, or shared Ask attachments as incidental
hardening.

On the first production verification after sharing is deployed, delete a real
recipe that is listed in a collection and confirm the Firestore
`array-contains` query on `recipeIds` succeeds. This verifies the required
production index path.

## Access requests

When someone who is not a member completes Google sign-in and presses **Request
access**, Sous stores their email, display name, Google `sub`, and timestamps
in top-level **`accessRequests/{sub}`** in Firestore. No `users/{sub}` document
is created until they are admitted.

The owner notification email carries **no approval power** — no one-click link,
no approve token. Approval happens only behind the owner's session at `/admin`.

Abuse bounds (**one mechanism**): at most **one document per Google account**;
at most **5** requester-driven writes per identity ever, and at most **one**
write per **24 hours** (`lastNotifiedAt` window); quiet repeats write nothing;
**20** notification attempts per **UTC day** globally (email may still be
suppressed while the write stands). `denied` and `approved` are absorbing for
new writes.

## Invite links

The owner can mint a bearer URL `{PUBLIC_ORIGIN}/invite/<token>` from `/admin`.
Firestore stores only `sha256(token)` (`invites/{hash}`), unused for **7 days**,
**single-use**. The raw token is shown once at mint time and is not stored.
Redeem happens in the OAuth callback after Google identity is verified: the
first `email_verified` account consumes the link, writes `members/{sub}`
`active` and an `approved` `accessRequests/{sub}` row, and gets a session.
Owners and already-active members who click their own link are not charged a
use. Unverified email still fails closed and does not consume the invite.
There is no email when a link is redeemed. Cap: **20** unused unexpired links.

