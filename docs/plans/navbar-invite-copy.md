# Navbar invite copy

Add an Invite control to the library header that mints a link and copies it.
The person stays on the library. Settings and `/admin` keep their existing
mint UI.

Constitutions: `docs/constitutions/i18n.md` (principles 9 and 16; catalog
text only — server-rendered invite HTML stays English and out of scope).
Cook log and image import do not apply. No constitution amendment.

Nothing in the locked decisions is impossible in this tree. `Library` is
the home navbar (`/` and `/?c=`). `createInvite` and `createMemberInvite`
already return `{ url }` (admin also returns `invites`; ignore that array
here). Screens already must not `fetch`; both helpers live in `src/lib/`.
`navigator.clipboard.writeText` after the mint `await` can reject when the
click’s user activation has ended. That is the clipboard-failure path
below, not a reason to switch to `ClipboardItem` or to copy before the URL
exists.

## Decisions

1. The control is a `type="button"` in the library header cluster, before
   Cooks, using `ghostBtn`. No app-wide chrome. No control on Cooks,
   Settings, Admin, or recipe screens. Do not remove Settings `MemberInvite`
   or the `/admin` mint.
2. Render it only when `useSession().user` is non-null (signed in, and
   offline with a cached user). Hide it when `user` is null (signed out, or
   still loading). Do not also require `status === 'signedIn'`.
3. Click mints, then copies. It does not navigate.
4. `user.isOwner === true` calls `createInvite()` (`POST /api/admin/invites`).
   Any other `isOwner` (`false` or missing) calls `createMemberInvite()`
   (`POST /api/invites`). Owners are 403 on the member route. Use only
   `created.url`. A stale cached `isOwner` can pick the wrong helper; the
   server still refuses, and the toast shows that `Error`. Do not refresh
   the session first and do not add a third client.
5. Happy path: `navigator.clipboard.writeText(url)`, then a success toast
   whose text is `library.inviteCopied`. Do not toast `admin.copied`.
6. Visible label is `library.inviteLink` (`Invite`). While the POST is in
   flight, disable the button and show `admin.creating`. Add
   `disabled:opacity-40` (`ghostBtn` has no disabled style). A later click
   may mint again; do not lock the button after success. A member’s next
   mint still replaces their previous unused link.
7. API failures toast `error.message` from the helpers (`error.sessionExpired`,
   `error.adminUnavailable`, `error.adminForbidden`, `error.inviteCap`,
   `error.memberInviteCap`, `error.memberInviteLimit`, `error.requestFailed`,
   and the same for any other code those helpers already map). A non-`Error`
   throw toasts `common.somethingWentWrong`. A rejected `fetch` is an
   `Error`; toast its message and do not add a catalog key for it. No new
   error codes, no server changes, no inline error paragraph.
8. If mint succeeds and `writeText` rejects: do not show the success toast.
   Toast `library.inviteCopyFailed` (error color) and reveal that URL in a
   readonly input plus Copy, matching Settings `MemberInvite`: label
   `admin.newInviteLink`, input `readOnly` with `onFocus` select, button
   `admin.copy` / `admin.copied`. Keep the panel until a `writeText` of
   that URL fulfills or `Library` unmounts. A fulfilled fallback copy
   closes the panel in the same update and then shows `library.inviteCopied`.
   The toast is the confirmation; do not delay unmount to paint `Copied`.
   A rejected fallback copy leaves the panel and `admin.copy`. Do not clear
   the panel when the toast fades, when an API error happens on a later
   click, or when the person switches collection (`/?c=` stays on
   `Library`). A later click that mints a new URL replaces the revealed
   value; a later click that throws leaves the previous URL up.
9. Toast visuals match `SyncToast`: fixed top pill, `aria-live="polite"`,
   `aria-atomic="true"`, success `bg-ink text-page`, error `bg-danger-fill
   text-white`, 200ms fade, success 2500ms, error 5000ms, fade starts 200ms
   before clear, `motion-reduce:transition-none`, region stays mounted
   while `Library` is mounted, `key` bumps so a repeat message re-announces.
   Own component, used only by `Library`. Do not import sync subscriptions,
   edit `SyncToast`, or edit the sync engine. Offset below the sync pill:
   sync is `top-[max(0.75rem,env(safe-area-inset-top))]`; this toast uses
   `top-[calc(max(0.75rem,env(safe-area-inset-top))+2.75rem)]` and `z-30`.
10. New strings go in `en`, `uk`, `ru`, and `zh-Hans` together. `en` is the
    key set. No hardcoded screen strings. Add two `screens.json` states
    (`needsData: true`). Note on `library-populated` and `library-empty`
    that a signed-in header shows Invite and that the review must not click
    it. Do not run the in-context review.
11. `Library` calls the existing lib functions only. It does not `fetch`.
12. One pure helper for which client to call, with a unit test. No DOM
    test, Firestore emulator, or fake IndexedDB. No production deploy.
13. Docs: one sentence on the Auth bullet in `AGENTS.md`, and one sentence
    in the Invite links section of `docs/handoff-invitation-only.md`. Do
    not edit the plans table, privacy, terms, or invite server rules.
14. Do not edit `docs/plans/member-invite-links.md`.

## Copy

New keys, inserted next to `library.cooks` in each catalog. No placeholders.
`src/i18n/messages.test.ts` rejects a non-English value equal to the English
string, so use these translations.

| Key | `en` | `uk` | `ru` | `zh-Hans` |
| --- | --- | --- | --- | --- |
| `library.inviteLink` | Invite | Запросити | Пригласить | 邀请 |
| `library.inviteCopied` | Invite link copied | Посилання-запрошення скопійовано | Ссылка-приглашение скопирована | 邀请链接已复制 |
| `library.inviteCopyFailed` | Invite link created, but it could not be copied | Посилання-запрошення створено, але його не вдалося скопіювати | Ссылка-приглашение создана, но её не удалось скопировать | 邀请链接已创建，但无法复制 |

Reused, not new: `admin.creating`, `admin.copy`, `admin.copied`,
`admin.newInviteLink`, `common.somethingWentWrong`.

## Steps

### 1. [core] Which mint client

Files: `src/lib/inviteMint.ts`, `src/lib/inviteMint.test.ts`.

Export `inviteMintClient(user: { isOwner?: boolean }): 'admin' | 'member'`.
Return `'admin'` only when `isOwner === true`; otherwise `'member'`. The
function does not `fetch`. Test `true`, `false`, and omitted `isOwner`.

### 2. [ui] Header, toast, failure panel, catalogs, manifest

Files: `src/screens/Library.tsx`, `src/components/LibraryInviteToast.tsx`,
`src/i18n/en.ts`, `src/i18n/uk.ts`, `src/i18n/ru.ts`, `src/i18n/zh-Hans.ts`,
`docs/i18n-review/screens.json`.

Catalogs: add the three keys and the strings in the table above.

`Library` already uses `useSession()` for `status` (empty copy). Also read
`user`. In the header cluster (`flex items-center gap-1`), before the Cooks
`Link`, when `user !== null`:

```tsx
<button
  type="button"
  className={`${ghostBtn} disabled:opacity-40`}
  disabled={pending}
  onClick={() => void mint()}
>
  {pending ? t('admin.creating') : t('library.inviteLink')}
</button>
```

Let the cluster wrap (`flex-wrap justify-end`) so longer translations sit
with the title instead of overflowing it. Do not change the title, Cooks,
or Settings classes otherwise.

`mint` (ignore the result if `Library` unmounted before it finishes):

- `inviteMintClient(user) === 'admin'` → `(await createInvite()).url`
- else → `(await createMemberInvite()).url`
- `writeText` fulfills → clear any revealed URL, success toast
  `library.inviteCopied`
- `writeText` rejects → store that URL, error toast
  `library.inviteCopyFailed`, do not toast success
- helper throws → error toast of `error.message`, or
  `common.somethingWentWrong` when the throw is not an `Error`; leave an
  already revealed URL in place

Mount `LibraryInviteToast` from `Library` only (not `App`). Copy the
`SyncToast` show/fade timers and pill classes. Position class:

`pointer-events-none fixed inset-x-0 top-[calc(max(0.75rem,env(safe-area-inset-top))+2.75rem)] z-30 flex justify-center px-4`

The live region stays mounted for the whole time `Library` is mounted,
including when the message is empty.

When a URL is revealed, render the Settings card directly under the header
(empty library and populated library, including `/?c=`): `htmlFor` /
`id="library-invite-url"`, `admin.newInviteLink`, readonly `inputClass`
input, `secondaryBtn` copy button with `admin.copy` / `admin.copied`.
Fallback copy uses `writeText` on the revealed URL only. Success closes
the panel and shows `library.inviteCopied`. Failure keeps the panel.
Unmounting `Library` drops the panel; do not persist the URL.

`docs/i18n-review/screens.json`:

- Append to the `setup` of `library-empty` and of `library-populated`:
  `A signed-in header shows Invite before Cooks. Do not click Invite.`
- After `library-populated`, add:
  - `library-invite-copied`, route `/`, `needsData: true`. Setup: signed
    in, after Invite, the “Invite link copied” toast is showing. Clicking
    Invite writes an invite (owner: `POST /api/admin/invites`; member:
    `POST /api/invites`, which replaces that member’s previous unused
    link). If the review must not write, mark skipped: needs data.
  - `library-invite-copy-failed`, route `/`, `needsData: true`. Setup:
    signed in, after Invite, clipboard write failed, so the
    created-but-not-copied toast, the readonly URL, and Copy are showing.
    Reaching it writes an invite. If the clipboard accepts the write, mark
    skipped: needs data. Do not mint again to force it.

Do not run the visual review.

### 3. [core] Docs

Files: `AGENTS.md`, `docs/handoff-invitation-only.md`.

In the Auth two-tier bullet, immediately after the sentence that ends
“they do not see `/admin`.”, add:

`A signed-in person can also mint from the library header: an owner uses the admin mint (POST /api/admin/invites), and a member uses POST /api/invites.`

In `## Invite links`, immediately after the sentence that begins “An
admitted member who is not an owner can mint one from Settings”, add:

`A signed-in person can also mint from the library header: an owner uses the admin mint, and a member uses POST /api/invites.`

Do not change the plans table, privacy, terms, server invite rules, or
`docs/plans/member-invite-links.md`.

## Verification

From the repo root:

- `npx tsc -b`
- `npm test` (includes `src/lib/inviteMint.test.ts` and catalog parity)

Browser, `npm run dev` and `npm run dev:api`, `http://localhost:5173` (Vite
may be IPv6-only; do not use `127.0.0.1`):

- Signed out (`user` null): header shows Cooks and Settings and does not
  show Invite. Empty-library signed-out copy is unchanged. Do not sign in.
- Do not click Invite. Local dev writes production Firestore. Do not mint,
  do not copy, and do not sign out an existing owner session to force the
  signed-out view. If a cached user is already present, confirm Invite is
  visible before Cooks and stop without clicking it.
- No production deploy.
