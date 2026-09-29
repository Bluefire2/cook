# Member invite links

Parent: `docs/plans/invite-links.md`. Redeem is unchanged. This slice lets an
admitted member mint one single-use link without opening `/admin`.

Constitutions: `docs/constitutions/i18n.md` (Settings and admin copy). Cook
log and image import do not apply.

## Goal

1. A signed-in member who is not an owner can mint `{PUBLIC_ORIGIN}/invite/<token>`
   from Settings.
2. They do not see the access-management UI: no people list, no approve,
   remove, or revoke, no list of unused links.
3. The owner’s `/admin` screen still mints, lists every unused link, and
   revokes any of them.

## Decisions (locked)

- **Same link.** Bearer, hash-only storage, 7-day TTL, first verified Google
  account, `approvedBy` / `decidedBy` = the minter’s `sub`. No new env,
  scopes, or mail.
- **One outstanding link per member.** Creating another revokes that member’s
  previous unused links first, then mints. Other people’s links stay.
- **Global cap stays 20.** The member’s link counts. If unused links that
  belong to other people already fill the cap, mint returns 409 and revokes
  nothing.
- **`{ url }` only.** `POST /api/invites` never returns an invite id.
- **Owners get 403** on `POST /api/invites`, so this route cannot revoke
  admin-minted links. Owners keep `POST /api/admin/invites`.
- **Everyone else** is 401 or 503, same as other member routes.
- **`createdByEmail` is optional** on the invite doc. Missing rows still
  parse. The owner list shows “Created by {email}” when it is present.
- **Member cap code** is `member-invite-cap`, not `invite-cap`.
- **No production deploy** unless asked.

## Steps

### 1. [core] Plan file

This file.

### 2. [core] Mint helper and `POST /api/invites`

`memberMintRevokeIds` and `mintMemberInvite` in `server/invites.ts`.
`memberInvitesPost` in `server/admin.ts`. Register the route in
`scripts/server.ts`. Owner mint also stores `createdByEmail`.

### 3. [core] Owner list creator

`AdminInviteEntry.creatorEmail` when the doc has `createdByEmail`.

### 4. [ui] Settings control and catalogs

`src/lib/inviteApi.ts`. Settings block only when `isOwner !== true`.
Catalogs `en`, `uk`, `ru`, `zh-Hans`. Creator line on the owner list.
`docs/i18n-review/screens.json` state `settings-invite-link`.

### 5. [core] Docs and legal

`AGENTS.md`, `README.md`, `docs/handoff-invitation-only.md`,
`public/privacy.html`, `public/terms.html`.

### 6. [core] Tests

Replace, cap-without-revoke, `{ url }` only, owner and signed-out refusal,
`creatorEmail` round-trip, doc without it still parses.

## Status

- [x] 1. [core] Plan file
- [x] 2. [core] Mint helper and `POST /api/invites`
- [x] 3. [core] Owner list creator
- [x] 4. [ui] Settings control and catalogs
- [x] 5. [core] Docs and legal
- [x] 6. [core] Tests
