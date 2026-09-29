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
When `ClipboardItem` exists, the click that mints calls
`navigator.clipboard.write` synchronously, before any `await`, with a
`ClipboardItem` whose `text/plain` body is the mint promise. `writeText`
after that `await` is only the fallback once the mint has succeeded, and
the revealed-URL Copy button still uses `writeText` because that URL is
already known and the click is a fresh gesture.

## Review fixes

This slice replaces the old one-tap-for-everyone decision and the decision
that `writeText` after `await` was not a reason to use `ClipboardItem`.

- A member confirms in the existing `Sheet` before the header mint. An
  owner still mints in one tap. Settings `MemberInvite` and `/admin` stay
  as they are.
- The minting click uses `ClipboardItem` inside the gesture when it
  exists. `writeText` is the fallback after a successful mint.
- Docs: wrap the library-header sentence in `AGENTS.md`, and move the
  handoff sentence to after “in one transaction.”
- `screens.json`: add `library-invite-confirm`. Prefer zero new catalog
  keys.

No server changes, no new env, no mail, no production deploy. Quota
behavior, the fallback URL panel, mounted-ref guards, the toast, and the
header wrap stay.

## Decisions

1. The control is a `type="button"` in the library header cluster, before
   Cooks, using `ghostBtn`. No app-wide chrome. No control on Cooks,
   Settings, Admin, or recipe screens. Do not remove Settings `MemberInvite`
   or the `/admin` mint.
2. Render it only when `useSession().user` is non-null (signed in, and
   offline with a cached user). Hide it when `user` is null (signed out, or
   still loading). Do not also require `status === 'signedIn'`.
3. A member does not mint from the header. When
   `inviteMintClient(user) === 'member'`, the header Invite button only
   opens the existing `Sheet` (`src/components/Sheet.tsx`). The body
   reuses `settings.inviteIntro` (new link replaces the previous unused
   one, the 5-person limit, once, 7 days, copy it now). Do not add a
   near-duplicate intro string. Title reuses `settings.inviteTitle`.
   Primary action reuses `admin.createLink`. Cancel reuses `common.cancel`.
   Create is the only control that starts the mint. Cancel, backdrop
   dismiss, and Escape close the sheet and mint nothing. While a mint is
   in flight, keep the sheet open: Create is disabled and labeled
   `admin.creating`, Cancel is disabled, and the sheet is not dismissible,
   so backdrop and Escape do not close it mid-request. When the mint
   settles, close the sheet. Owners
   (`inviteMintClient(user) === 'admin'`) keep the one-tap flow: header
   Invite calls mint immediately and does not open the sheet. Do not
   change Settings `MemberInvite` or `/admin`. Classes match the create
   collection sheet: `h2` `text-lg font-semibold`, body `p` `mt-1 text-sm
   text-ink-muted`, primary `${primaryBtn} mt-3 w-full py-3`, cancel
   `${secondaryBtn} mt-2 w-full py-3`.
4. `user.isOwner === true` calls `createInvite()` (`POST /api/admin/invites`).
   Any other `isOwner` (`false` or missing) calls `createMemberInvite()`
   (`POST /api/invites`). Owners are 403 on the member route. Use only
   `created.url`. A stale cached `isOwner` can pick the wrong helper; the
   server still refuses, and the toast shows that `Error`. Do not refresh
   the session first and do not add a third client.
5. The click that mints (owner header Invite, or member Create) builds the
   mint promise and does not `await` it before copying. `urlPromise`
   resolves to the URL string (`created.url`). Choose the strategy with
   `copyStrategy({ hasClipboardItem })` in `src/lib/inviteMint.ts`,
   returning `'clipboard-item' | 'write-text'`. Pass
   `typeof ClipboardItem !== 'undefined'`. The helper is pure. Test it in
   `src/lib/inviteMint.test.ts`. Do not unit-test the browser.
   When the strategy is `'clipboard-item'`, that same click handler calls
   `navigator.clipboard.write` synchronously, before any `await`:

   ```ts
   navigator.clipboard.write([
     new ClipboardItem({
       'text/plain': urlPromise.then((u) => new Blob([u], { type: 'text/plain' })),
     }),
   ])
   ```

   Do not call `write` after an `await`. Calling `createInvite` or
   `createMemberInvite` returns a promise in that same turn; do not
   `await` it first. When the strategy is `'write-text'`, do not call
   `write`.
   Await `urlPromise` separately and handle its rejection first. A mint
   failure must not surface only as a clipboard rejection. Catch the
   `write` promise in that failure path so it is not an unhandled
   rejection and does not show `library.inviteCopyFailed`. Quota codes
   stay Decision 7 (persistent `role="alert"`, no toast, no URL, nothing
   created). Other mint errors still toast. Keep `inviteMountedRef`
   guards. A mint error leaves an already revealed URL in place.
   If `write` rejects after a successful mint, or the strategy is
   `'write-text'`, try `writeText(url)`. If that also fails, Decision 8.
   If the copy fulfills, clear any revealed URL and toast
   `library.inviteCopied`. Do not toast `admin.copied`. Do not call
   `writeText` when `write` already fulfilled.
6. Header label stays `library.inviteLink`, and `admin.creating` while
   `invitePending`. Keep `disabled:opacity-40` and the cluster
   `flex-wrap justify-end`. Disable the header button while the confirm
   sheet is open or `invitePending`, so a second tap does not stack
   sheets. Member `onClick` only opens the sheet. Owner `onClick` starts
   mint and the `ClipboardItem` write immediately. Do not lock the button
   after success: an owner’s later tap mints again, and a member’s later
   tap opens the sheet again. A member’s next successful mint still
   replaces their previous unused link.
7. API failures other than a quota refusal toast `error.message` from the
   helpers (`error.sessionExpired`, `error.adminUnavailable`,
   `error.adminForbidden`, `error.requestFailed`, and the same for any other
   code those helpers already map). A non-`Error` throw toasts
   `common.somethingWentWrong`. A rejected `fetch` is an `Error`; toast its
   message and do not add a catalog key for it. No new error codes, no
   server changes.
   A quota refusal (`member-invite-limit`, `member-invite-cap`, or
   `invite-cap`) does not toast and does not reveal a URL. The same catalog
   sentence stays under the header until a later mint succeeds. Nothing was
   created, and a member's current unused link is left in place.
8. The first copy attempt is Decision 5 (`clipboard.write` with a
   `ClipboardItem`, or `writeText` when `ClipboardItem` is absent).
   `writeText(url)` is the fallback after a successful mint when `write`
   rejects. If that fallback `writeText` rejects, or `writeText` was the
   first attempt and it rejects: do not show the success toast. Toast
   `library.inviteCopyFailed` (error color) and reveal that URL in a
   readonly input plus Copy, matching Settings `MemberInvite`: label
   `admin.newInviteLink`, input `readOnly` with `onFocus` select, button
   `admin.copy` / `admin.copied`. Keep the panel until a `writeText` of
   that URL fulfills or `Library` unmounts. A fulfilled fallback copy
   closes the panel in the same update and then shows `library.inviteCopied`.
   The toast is the confirmation; do not delay unmount to paint `Copied`.
   A rejected fallback copy leaves the panel and `admin.copy`.
   `copyRevealedUrl` still uses `writeText` only, on the revealed URL,
   because that URL is already known and the click is a fresh gesture.
   Do not clear the panel when the toast fades, when an API error happens
   on a later click, or when the person switches collection (`/?c=` stays
   on `Library`). A later click that mints a new URL replaces the revealed
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
    key set. No hardcoded screen strings. The three keys in Copy are
    already in the catalogs. This slice prefers zero new keys: the sheet
    reuses `settings.inviteTitle`, `settings.inviteIntro`,
    `admin.createLink`, `admin.creating`, and `common.cancel`. Add a key
    only if a string is unavoidable. Add `library-invite-confirm` to
    `screens.json` (`needsData: true`). Update the setup notes on
    `library-invite-copied` and `library-invite-copy-failed` so a member
    reaches them via Create link in the sheet and an owner via the header
    button. Leave the `library-empty` and `library-populated` notes that
    say not to click Invite. Do not run the in-context review.
11. `Library` calls the existing lib functions only. It does not `fetch`.
12. One pure helper for which client to call, with a unit test. No DOM
    test, Firestore emulator, or fake IndexedDB. No production deploy.
13. The Auth bullet in `AGENTS.md` and the Invite links section of
    `docs/handoff-invitation-only.md` already mention the library header.
    This slice only fixes those two sentences (step 6): wrap the
    `AGENTS.md` sentence at about 76 columns, backtick both routes, and
    say a member confirms in a sheet; in the handoff, move that sentence
    to just after “in one transaction.” and state that a member confirms
    and an owner still mints in one tap. Do not edit the plans table,
    privacy, terms, or invite server rules.
14. Do not edit `docs/plans/member-invite-links.md`.

## Copy

New keys, inserted next to `library.cooks` in each catalog. No placeholders.
`src/i18n/messages.test.ts` rejects a non-English value equal to the English
string, so use these translations. Steps 1–3 added these keys. This slice
adds none unless a string is unavoidable.

| Key | `en` | `uk` | `ru` | `zh-Hans` |
| --- | --- | --- | --- | --- |
| `library.inviteLink` | Invite | Запросити | Пригласить | 邀请 |
| `library.inviteCopied` | Invite link copied | Посилання-запрошення скопійовано | Ссылка-приглашение скопирована | 邀请链接已复制 |
| `library.inviteCopyFailed` | Invite link created, but it could not be copied | Посилання-запрошення створено, але його не вдалося скопіювати | Ссылка-приглашение создана, но её не удалось скопировать | 邀请链接已创建，但无法复制 |

Reused, not new: `admin.creating`, `admin.copy`, `admin.copied`,
`admin.newInviteLink`, `common.somethingWentWrong`, `settings.inviteTitle`,
`settings.inviteIntro`, `admin.createLink`, `common.cancel`.

## Steps

Steps 1–3 are done on this branch (mint client, header, toast, quota
panel, fallback URL, catalogs, and the first docs sentences). Do not redo
them. The one-tap handler and the `writeText`-after-`await` path in step 2
are superseded by steps 4–6. Run “Verification (review fixes)”, not the
earlier Verification section.

### 1. [core] Which mint client

Done.

Files: `src/lib/inviteMint.ts`, `src/lib/inviteMint.test.ts`.

Export `inviteMintClient(user: { isOwner?: boolean }): 'admin' | 'member'`.
Return `'admin'` only when `isOwner === true`; otherwise `'member'`. The
function does not `fetch`. Test `true`, `false`, and omitted `isOwner`.

### 2. [ui] Header, toast, failure panel, catalogs, manifest

Done.

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

Done.

Files: `AGENTS.md`, `docs/handoff-invitation-only.md`.

In the Auth two-tier bullet, immediately after the sentence that ends
“they do not see `/admin`.”, add:

`A signed-in person can also mint from the library header: an owner uses the admin mint (POST /api/admin/invites), and a member uses POST /api/invites.`

In `## Invite links`, immediately after the sentence that begins “An
admitted member who is not an owner can mint one from Settings”, add:

`A signed-in person can also mint from the library header: an owner uses the admin mint, and a member uses POST /api/invites.`

Do not change the plans table, privacy, terms, server invite rules, or
`docs/plans/member-invite-links.md`.

### 4. [core] `copyStrategy`

Files: `src/lib/inviteMint.ts`, `src/lib/inviteMint.test.ts`.

Export:

```ts
export function copyStrategy(input: {
  hasClipboardItem: boolean;
}): 'clipboard-item' | 'write-text' {
  return input.hasClipboardItem ? 'clipboard-item' : 'write-text';
}
```

The function does not read `navigator` and does not `fetch`. In
`src/lib/inviteMint.test.ts`, assert `true` → `'clipboard-item'` and
`false` → `'write-text'`. Do not unit-test `clipboard.write` or
`writeText`.

### 5. [ui] Confirm sheet, `ClipboardItem` mint, manifest

Files: `src/screens/Library.tsx`, `docs/i18n-review/screens.json`.
Catalogs only if a new string is unavoidable (prefer zero new keys).

No server files. Do not change Settings `MemberInvite` or `/admin`. Keep
the quota panel, the revealed-URL panel, `copyRevealedUrl` (`writeText`
only), `inviteMountedRef`, `LibraryInviteToast`, and the header
`flex-wrap justify-end`.

State: `inviteConfirmOpen`, default false. `closeSheets` sets it false.
The header button is `disabled={invitePending || inviteConfirmOpen}` and
still shows `admin.creating` only while `invitePending`.

Member header `onClick` sets `inviteConfirmOpen` true and does not mint.
Owner header `onClick` runs the mint click below and does not open the
sheet.

Confirm sheet, only when `inviteConfirmOpen` and the client is `'member'`:

```tsx
<Sheet
  dismissible={!invitePending}
  onClose={() => {
    if (!invitePending) closeSheets();
  }}
>
  <h2 className="text-lg font-semibold">{t('settings.inviteTitle')}</h2>
  <p className="mt-1 text-sm text-ink-muted">{t('settings.inviteIntro')}</p>
  <button
    type="button"
    disabled={invitePending}
    className={`${primaryBtn} mt-3 w-full py-3`}
    onClick={/* mint click; write before any await */}
  >
    {invitePending ? t('admin.creating') : t('admin.createLink')}
  </button>
  <button
    type="button"
    disabled={invitePending}
    className={`${secondaryBtn} mt-2 w-full py-3`}
    onClick={() => {
      if (!invitePending) setInviteConfirmOpen(false);
    }}
  >
    {t('common.cancel')}
  </button>
</Sheet>
```

Cancel, backdrop, and Escape mint nothing. `Sheet` already listens for
Escape in the capture phase, calls `onClose`, and
`stopImmediatePropagation`. Also add `inviteConfirmOpen` to the existing
Library `keydown` condition that calls `closeSheets`, and to that
effect’s dependency list, so the close set stays consistent. That
listener must not mint.

Mint click (owner header, or member Create), with no `await` before
`write`:

- If `user === null` or `invitePending`, return. This return stays
  before `setInvitePending(true)` and outside the `try`, so a second
  click does not clear a mint that is already in flight.
- `setInvitePending(true)`.
- Build `urlPromise` as the promise of `created.url` from
  `createInvite()` or `createMemberInvite()` per `inviteMintClient`.
  Do not `await` it yet.
- Keep `writeStarted` unset until `clipboard.write` returns a promise.
  When `copyStrategy({ hasClipboardItem: typeof ClipboardItem !== 'undefined' })`
  is `'clipboard-item'`, call `navigator.clipboard.write` in this turn,
  before any `await`, with the `ClipboardItem` in Decision 5. If
  `new ClipboardItem` or `write` throws synchronously, leave
  `writeStarted` unset and continue. That throw is not a mint failure
  and must not skip `urlPromise`. Otherwise keep the promise as
  `writeStarted` and, in that same turn, attach
  `void writeStarted.catch(() => {})` so an unmount or a mint failure
  cannot make it an unhandled rejection. That empty catch does not
  decide the UI. Awaiting the original promise still rejects, so the
  success path can still fall through to `writeText`.
- Then `await urlPromise` inside `try`. On rejection, if still mounted,
  run the existing quota branch or the existing error toast. Do not
  show `library.inviteCopyFailed`. Do not reveal a URL. Do not clear an
  already revealed URL. Close the confirm sheet. Do not await
  `writeStarted` for UI. On success, if `inviteMountedRef` is false, do
  not update state. If still mounted, clear the quota alert. If
  `writeStarted` is set, `await` it. If it rejects, or it was not
  started, `await navigator.clipboard.writeText(url)`. Do not call
  `writeText` when `write` already fulfilled. Fulfillment clears the
  revealed URL, sets the copied flag false, and toasts
  `library.inviteCopied`. Rejection stores that URL, clears the copied
  flag, and toasts `library.inviteCopyFailed`. Close the confirm sheet
  in that same settled update. In `finally`, if
  `inviteMountedRef.current`, `setInvitePending(false)`. This runs on
  success and on mint failure.

`docs/i18n-review/screens.json`: insert `library-invite-confirm` after
`library-populated` and before `library-invite-copied`. Do not change
`library-empty` or `library-populated`. Those notes already say not to
click Invite; do not tell the review to click it there. Replace the
`library-invite-quota` setup with: signed in, the refusal sentence under
the header (`role="alert"`), no toast and no URL panel. A member reaches
it by tapping Create link in the confirm sheet when the response is 409
`member-invite-limit` or `member-invite-cap`. An owner reaches it by
tapping the header Invite button when the response is 409 `invite-cap`.
Nothing was created. Do not mint a real invite to force it. If that
state is not available, mark skipped: needs data.

- `library-invite-confirm`, route `/`, `needsData: true`. Setup: signed
  in as a non-owner, Invite opened the sheet, the invite intro is
  showing, Create link and Cancel are showing, and the review must not
  click Create link (it writes an invite).
- Replace the `library-invite-copied` setup with: signed in, with the
  “Invite link copied” toast showing. A member reaches it by tapping
  Create link in the confirm sheet (`POST /api/invites`, which replaces
  that member’s previous unused link). An owner reaches it by tapping
  the header Invite button (`POST /api/admin/invites`). If the review
  must not write, mark skipped: needs data.
- Replace the `library-invite-copy-failed` setup with: signed in,
  clipboard write failed, so the created-but-not-copied toast, the
  readonly URL, and Copy are showing. A member reaches it via Create
  link in the sheet. An owner reaches it via the header Invite button.
  Reaching it writes an invite. If the clipboard accepts the write,
  mark skipped: needs data. Do not mint again to force it.

Do not run the in-context review.

### 6. [core] Doc nits

Files: `AGENTS.md`, `docs/handoff-invitation-only.md`.

In the Auth two-tier bullet, replace only the library-header sentence
(the long line near the “they do not see `/admin`.” sentence). Leave the
rest of that bullet as it is. Wrap at about 76 columns, backtick both
routes, and add one short clause that a member confirms in a sheet
before the header mint:

```
  A signed-in person can also mint from the library header: an owner uses
  the admin mint (`POST /api/admin/invites`), and a member confirms in a
  sheet before minting (`POST /api/invites`).
```

In `docs/handoff-invitation-only.md` `## Invite links`, cut the sentence
that begins “A signed-in person can also mint from the library header”
out from between the Settings mint sentence and “Creating another”.
“Creating another replaces that member's previous unused link, in one
transaction.” must follow the Settings sentence directly, so it still
describes Settings. Place the updated sentence immediately after
“in one transaction.” The next sentence today says “The response is the
URL only — no invite id — so they cannot revoke.” That claim must not
cover the owner one-tap: `POST /api/admin/invites` also returns
`invites`, and the owner can revoke. After the inserted header sentence,
replace that following sentence with: `A member mint’s response (`POST /api/invites`) is the URL only — no invite id — so that member cannot revoke.`

```
A signed-in person can also mint from the library header: an owner still
mints in one tap, and a member confirms in a sheet before that mint
(`POST /api/invites`).
```

Do not edit the plans table, privacy, terms, server invite rules, or
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

## Verification (review fixes)

This is the check for steps 4–6. Do not follow the earlier Verification
section’s “do not click Invite” stop.

From the repo root:

- `npx tsc -b`
- `npm test` (includes `copyStrategy` in `src/lib/inviteMint.test.ts`)

Browser, `npm run dev` and `npm run dev:api`, `http://localhost:5173`
(Vite may be IPv6-only; do not use `127.0.0.1`):

- Do not sign in with Google. Do not mint a production invite. Stub
  `POST /api/invites` and `POST /api/admin/invites` so neither write
  reaches Firestore.
- Member (`inviteMintClient` `'member'`): header Invite opens the sheet
  and does not POST. Cancel does not POST and closes the sheet. Backdrop
  and Escape close the sheet and do not POST. Create POSTs
  `POST /api/invites`. The sheet shows `settings.inviteIntro`, Create
  link, and Cancel.
- Owner (`inviteMintClient` `'admin'`): one tap POSTs
  `POST /api/admin/invites` and does not open the sheet.
- A stubbed 409 with `member-invite-limit`, `member-invite-cap`, or
  `invite-cap` shows the persistent sentence under the header
  (`role="alert"`). It does not toast, does not show the URL panel, and
  is not treated as a clipboard failure.
- After a successful stubbed mint, a rejected clipboard write still
  shows `library.inviteCopyFailed` and the readonly URL panel.
- iPhone / iOS Safari is not available in this environment.
- No production deploy.
