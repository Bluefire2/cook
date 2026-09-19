# Single-use invite links

Parent: `docs/plans/invitation-flow.md`. Request-and-approve stays; this is a
parallel admit path the owner mints from `/admin`.

## Goal

1. An owner on `/admin` can mint a URL `{PUBLIC_ORIGIN}/invite/<token>`.
2. Anyone who opens a still-unused, unexpired link, then completes Google
   consent with a verified email, is admitted as an ordinary member on that
   callback — no Request access, no second owner session.
3. The link is **single-use** (first successful redeem wins) and **dies after
   7 days** if unused. The owner can revoke an unused link sooner.
4. Invite-admitted people show up under **Approved** and can be removed with
   the existing Remove access action.

## Decisions (locked)

- **Bearer, not email-bound.** The owner does not type an address. The first
  `email_verified` Google account to finish consent consumes the link.
  Membership remains keyed by Google `sub` (invitation-flow D4).
- **7-day TTL** on unused links. Redeem and list treat `expiresAt <= now` as
  dead. Expired unused rows do not count toward the cap.
- **Show the URL once** at mint time. Firestore stores only `sha256(token)`
  as the document id; the secret is never written.
- **Do not consume** if the redeemer is already an owner or an `active`
  member. **Do consume and admit** if they were never a member, pending,
  declined, or revoked — the invite is an approval.
- **Unverified email** still fails closed and **does not** consume the invite.
- **No new env vars, no new Google scopes, no Resend mail on redeem.**
- **Landing is server HTML**, same self-contained style as
  `invitationOnlyPage`. Not a React `/invite` route.
- **Do not reuse** `v: 'accessreq'`. New hop cookie `sous_invite`
  (`v: 'invite'`, 10 min) plus an optional `invite` hash on the oauth tx.
- **`accessRequests/{sub}` remains the /admin index.** Redeem writes (or
  flips) that doc to `approved` in the same transaction as `members/{sub}`
  `active` and the invite `redeemed`. `approvedBy` is the minting owner's
  `sub`.
- **Cap:** 20 unused and unexpired invites. Further mint → 409.
- **No production deploy** in this slice unless asked.

## Steps

### 1. [core] Plan file + token/session primitives

This file. `hashInviteToken`, oauth optional `invite`, `sous_invite`
sign/verify, cross-family rejection tests.

### 2. [core] Invite store + pure transitions

`parseInviteDoc`, `inviteTokenFromPath`, `inviteLandingVerdict`,
`redeemInviteTransition`, `revokeInviteTransition`, Firestore accessors,
redeem transaction. Unit tests only.

### 3. [core] Owner APIs

`POST /api/admin/invites`, `GET /api/admin/invites`,
`POST /api/admin/invites/revoke`. `requireOwner`. Register in
`scripts/server.ts`.

### 4. [core] Landing + proxy

`GET /invite/:token` HTML. Handle even when `staticRoot === null`. Vite
proxy + PWA denylist.

### 5. [core] authStart + callback redeem

Cookie → oauth tx → redeem before the denied → invitation-only branch.
401/503/403 mapping unchanged for everyone else.

### 6. [core] Client admin API

`createInvite`, `fetchInvites`, `revokeInvite`.

### 7. [ui] Admin screen

**Invite links** block above Pending: Create link, copy-once URL, unused
rows with revoke.

### 8. [core] Docs and legal

AGENTS.md, README, handoff-invitation-only.md, privacy, terms.

## Status

- [x] 1. [core] Plan file + token/session primitives
- [x] 2. [core] Invite store + pure transitions
- [x] 3. [core] Owner APIs
- [x] 4. [core] Landing + proxy
- [x] 5. [core] authStart + callback redeem
- [x] 6. [core] Client admin API
- [x] 7. [ui] Admin screen
- [x] 8. [core] Docs and legal
