# Approval email

When an owner approves an access request, email the person who asked.
The address is the one already stored on the request. Deny, revoke, and
invite-link admission send nothing.

This plan supersedes `docs/plans/invitation-flow.md` **D14** for that
approval email only. D14 stays in that file as history. Do not edit
`docs/plans/invitation-flow.md`. `scripts/invariants.test.ts` does not
require a change there.

Mail still goes through the existing Resend seam. `sendMail` still never
throws and still returns a boolean (**D15** in `docs/plans/invitation-flow.md`).
A mail failure leaves the approval in place. The admin JSON response stays
the response `adminDecisionPost` already returns.

## Constitutions

- **i18n** (`docs/constitutions/i18n.md`), principle 9. Server-rendered
  access HTML, `/privacy`, and the owner notification email are already
  English and outside the catalogs. This slice amends principle 9 so the
  approval email to the requester is named in that same exception list,
  and adds an Amendments row dated 2026-09-30. No catalog keys. No
  `docs/i18n-review/` change. No in-context translation review.
  Principle 16 already defers to principle 9's exception list, so it
  needs no rewrite. The constitution frontmatter `description` stays as
  it is, and the Feature constitutions index line in `AGENTS.md` stays
  as it is. `scripts/constitutions.test.ts` compares that index line to
  the frontmatter description.
- **Cook log** does not apply. This slice does not touch cook-log data,
  sync, photos, backup, or those screens.
- **Image import** does not apply. The privacy edit adds approval-mail
  sentences in the existing Third parties paragraph. The photo-import
  sentences in that paragraph stay word for word.

## Decisions

1. Send only from `adminDecisionPost` in `server/admin.ts`, and only after
   `applyDecision` (`server/members.ts`) has returned. `applyDecision`
   awaits its Firestore transaction and returns the committed
   `DecisionTransitionResult`, so a return of `{ kind: 'ok' }` means the
   transaction has committed. Call the mail helper only when
   `body.action === 'approve'` and `result.kind === 'ok'`. Approve is
   legal from `pending` or `denied` (`decisionTransition`). Both of those
   successful approve transitions send. Do not also require a previous
   status, and do not consult `lastNotifiedAt` or
   `accessRequestMeta/notifications`. Those belong to the owner
   notification on request. A later approve after a deny sends again.
2. The recipient is `result.request.email` on that ok result. Ignore any
   email field on the HTTP body. `parseDecisionBody` already keeps only
   `sub` and `action`.
3. Mail failure does not change the HTTP status or body and does not roll
   back the approval. The approval is already committed before the send.
   `sendMail` never throws. The caller still catches a rejection and
   continues, so a future throw from `sendMail` cannot turn the handler's
   `try` into `storeUnavailable()` (503). The JSON body stays
   `serializeAccessRequestLists` of the follow-up `listAccessRequests()`
   read, with the same status codes as today (200 on success, and the
   existing 409 / 404 / 400 / 401 / 403 / 413 / 415 / 503 paths).
4. `server/mail.ts` `MailMessage` gains an optional `to?: string`. When
   the property is omitted, `sendMail` still sets the Resend `to` array
   from `ownerNotifyEmail()`. When `to` is present, that string is the
   sole recipient and `ownerNotifyEmail()` is not called. `accessRequestPost`
   keeps calling `sendMail({ subject, text })` with no `to`. One provider
   (Resend). No new env var. The disabled-key log line stays
   `RESEND_API_KEY unset — access-request notifications are disabled`.
5. Before calling `sendMail` for an approval, classify the stored email
   with a pure helper. Any non-null `approvalRecipientProblem` result
   skips the send and logs `approval email skipped: invalid recipient`.
   One branch covers both `'invalid'` (whitespace inside the address, a
   newline, a comma, or not exactly one `@`) and `'missing'` (`''` or
   whitespace-only). `parseAccessRequestDoc` rejects `''`, but a
   whitespace-only email still parses. The log line does not include the
   address. Do not throw. Do not trim a dirty address and send the
   trimmed form. `a@b` (one `@`, no whitespace, no comma) is deliverable
   under this rule. Do not add a stricter pattern. `sendMail` still
   refuses any explicit `to` the helper flags.
6. The message is plain text, English, passed as Resend `text`.
   Subject: `Your Sous access was approved`.
   Body:

   ```
   Your request for Sous was approved.
   Sign in again at <origin>
   ```

   `<origin>` is the string `publicOrigin()` (`server/env.ts`) returns
   (trimmed `PUBLIC_ORIGIN`, trailing slashes removed). No path, query, or
   token. If `publicOrigin()` throws, skip the send and log
   `approval email skipped: PUBLIC_ORIGIN unset`. Do not send a body
   without the sign-in link. The admin JSON is unchanged.
   Subject and body contain no name, no email address, and no token.
   There is no one-click approval link. Do not log the body or the address.
7. Copy in `server/access.ts` (English, outside `src/i18n/`):
   - Form paragraph, inside the existing `<p class="muted">`:
     `Your request goes to the owner of this app. Once it is approved, we'll email you, and you can sign in again.`
   - Token-mint-failure paragraph, still inside `<p class="muted">`, still
     without the form:
     `Your request could not be started right now — signing in again will offer it once more. Once you have been approved, we'll email you, and you can try signing in again.`
   - Recorded page title stays `Request sent`. Body paragraph:
     `Your request was recorded. Once it is approved, we'll email you.`
     Future tense: the page does not say an email was delivered.

   Update the comment above `invitationOnlyPage` that still says nobody is
   emailed back. Leave `docs/plans/invitation-flow.md` unchanged.
8. In `public/privacy.html`, in the Third parties paragraph, after the
   sentence that ends with "owner's own signed-in screen." and before
   "Hosting is on Google Cloud.", add:

   `If the owner approves that request, Sous sends an email through Resend to the address on the request. The email says the request was approved and links to the app so you can sign in. It includes no secret and no one-click approval.`

   Leave every other sentence in that paragraph, including the
   photo-import sentences, unchanged. Do not edit other privacy
   paragraphs, `public/terms.html`, or `public/about.html`.
9. No deploy. Do not print or change secrets. Do not touch `vercel.json`,
   the Dockerfile, `0x1E` chat framing, or the `Recipe` schema. No enums
   and no constructor parameter properties (`erasableSyntaxOnly`).

10. **Review fixes (2026-09-30).**
    - *Sender.* The Resend sandbox sender (`onboarding@resend.dev`,
      `docs/plans/invitation-flow.md`) delivers only to the Resend
      account's own inbox, so every approval email would 403. Production
      `MAIL_FROM` must be on a domain verified in Resend before deploy.
      Until then `notifyApproval` skips the send and logs the fixed line
      `approval email skipped: MAIL_FROM is the Resend sandbox sender`
      (`isResendSandboxSender` in `server/mail.ts`), instead of a bare
      `resend send failed: 403`.
    - *Declined requests.* A quiet request whose stored status is
      `denied` is its own outcome, `declined` (`quietOutcome` in
      `server/members.ts`). Nothing is written and no owner is told, so
      its recorded page keeps the old copy, `Your request was recorded.`,
      with no email promise (`recordedPageHtml(false)`).
    - *Latency.* Approve no longer waits on Resend before the list reread.
      The send starts beside `listAccessRequests`, and the response waits
      on it for at most 3 s (`APPROVAL_MAIL_WAIT_MS`). A send still
      pending then finishes, or hits `sendMail`'s 10 s timeout, after the
      response. The wait attaches both fulfillment and rejection handlers
      (`promise.then(done, done)`). `promise.finally()` returns a promise
      that rejects with the original reason, and an unobserved rejection
      exits Node 22. This supersedes the "before `clearMembershipCache` and
      `listAccessRequests`" ordering in Decision 1 and step 2.
    - *Recipient check in the seam.* `sendMail` refuses any explicit `to`
      that `approvalRecipientProblem` flags (blank, whitespace, comma, or
      not exactly one `@`): it logs `resend send skipped: invalid
      recipient`, returns `false`, and never posts. `notifyApproval` keeps
      its own check for its specific log lines. This supersedes step 1's
      "Passing `to: ''` does not select the owner" posting behavior; an
      empty `to` still never falls back to the owner.
    - *Disabled-key log.* The once-per-process line is now
      `RESEND_API_KEY unset — access-request and approval emails are
      disabled`, superseding Decision 4's wording.
    - *Current address.* A refused sign-in (not admitted, invitation page)
      calls `touchRequestIdentity`, so a pending or declined request's
      stored email follows the Google account's current address. Before
      this, a declined request kept the address from the original
      request, and a later approve from Declined emailed that.
    - *Owner copy.* `admin.intro` in all four catalogs now says approving
      emails the person.

## Steps

### 1. [core] Optional recipient on `sendMail`

Files: `server/mail.ts`, `server/mail.test.ts` (new).

Extend `MailMessage`:

```ts
export interface MailMessage {
  subject: string;
  text: string;
  to?: string;
}
```

Inside the existing `try` that reads `mailFrom()` and `ownerNotifyEmail()`:

- `from` is still `mailFrom()`.
- When `msg.to` is `undefined`, the recipient is `ownerNotifyEmail()`.
  When `msg.to` is a string, the recipient is that string and
  `ownerNotifyEmail()` is not called. The owner-notification caller
  leaves `to` off the object. Passing `to: ''` does not select the owner.
- The Resend JSON stays `{ from, to: [recipient], subject, text }`.
  `to` remains a one-element array.
- Unset `RESEND_API_KEY`, a throw from `mailFrom()` / `ownerNotifyEmail()`
  on the default path, a non-2xx response, and a rejected `fetch` still
  return `false` and never throw. Logs stay status codes and error names
  only.

Export a pure classifier next to `sendMail` (name it
`approvalRecipientProblem`):

```ts
export function approvalRecipientProblem(
  email: string,
): 'missing' | 'invalid' | null
```

`''` and whitespace-only return `'missing'`. A non-blank string that
matches `/[\s,]/` or whose `@` count is not 1 returns `'invalid'`.
Otherwise `null`. The helper does not log and does not throw.

`server/mail.test.ts` sets `RESEND_API_KEY`, `MAIL_FROM`, and
`OWNER_NOTIFY_EMAIL` to fake values in the test itself (never read
`.env.local`), stubs `globalThis.fetch` to a 200 JSON response, and
restores env and `fetch` afterwards.

Assert:

- `sendMail({ subject, text, to: 'person@example.com' })` posts
  `to: ['person@example.com']` and not the owner address.
- `sendMail({ subject, text })` posts `to: [<OWNER_NOTIFY_EMAIL>]`.
- `approvalRecipientProblem` returns `null` for `person@example.com` and
  `a@b`; `'missing'` for `''` and `'   '`; `'invalid'` for
  `'person @example.com'`, `'a@b.com\n'`, `'a@b.com,c@d.com'`,
  `'nodomain'`, and `'a@b@c.com'`.

Verify: `npx vitest run server/mail.test.ts`.

### 2. [core] Send after a committed approve

Files: `server/admin.ts`, `server/admin.test.ts`.

Add a private `notifyApproval(email: string): Promise<void>` in
`server/admin.ts`. It uses `approvalRecipientProblem` and `sendMail` from
`server/mail.ts`, and `publicOrigin` from `server/env.ts` (already
imported).

- Any non-null `approvalRecipientProblem` result: `console.log`
  `approval email skipped: invalid recipient`, then return. One branch
  covers both `'missing'` and `'invalid'`. The log argument must be that
  fixed string only.
- Otherwise build the subject and body from Decision 6. If
  `publicOrigin()` throws, log
  `approval email skipped: PUBLIC_ORIGIN unset` and return. Do not send a
  body without the sign-in link.
- `await sendMail({ to: email, subject, text })`. Ignore the boolean.
  Wrap that `await` in `try/catch`. On rejection, `console.log` the fixed
  string `approval email failed` (no address) and do not rethrow.

In `adminDecisionPost`, after `applyDecision` returns and after the
existing `result.kind === 'refusal'` returns, and before
`clearMembershipCache` and `listAccessRequests`:

```ts
if (body.action === 'approve' && result.kind === 'ok') {
  await notifyApproval(result.request.email);
}
```

Do not send from inside `applyDecision` or from the Firestore transaction
callback. Do not send on the refusal branch, on deny, on revoke, or when
`applyDecision` throws (the existing `catch` still returns
`storeUnavailable()`). Invite mint and redeem in `server/invites.ts` gain
no `sendMail` call.

`server/admin.test.ts` already mocks `./members.ts` with `vi.mock` and
`importOriginal`, and stubs `applyDecision`. Extend that factory with
`listAccessRequests: vi.fn(actual.listAccessRequests)` so a success-path
test does not touch Firestore. Add:

```ts
vi.mock('./mail.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mail.ts')>();
  return {
    ...actual,
    sendMail: vi.fn(actual.sendMail),
  };
});
```

Follow the existing `ownerPost` helper (session cookie for
`allowed@example.com`, JSON body). `mockClear` `sendMail` between tests.
Stub `listAccessRequests` with the empty three-section shape already used
by `serializeAccessRequestLists` in this file
(`{ rows: [], nextCursor: null }` per section). Set `PUBLIC_ORIGIN` in
the approve test and restore it afterwards, the same way this file
already saves and restores `SESSION_SECRET` and `ALLOWED_EMAILS`.

Assert:

- Successful approve (`applyDecision` resolves `{ kind: 'ok', request, member }`
  with `request.email === 'person@example.com'` and `request.name` set,
  action `approve`): `sendMail` called once with
  `to: 'person@example.com'`, subject `Your Sous access was approved`,
  and text that contains `https://sous.example` when `PUBLIC_ORIGIN` is
  `https://sous.example`. Text does not contain `person@example.com` or
  the name. Response status 200 and JSON equal to
  `serializeAccessRequestLists` of the stubbed lists. A body field
  `email: 'other@example.com'` does not change `to`.
- `sendMail` resolving `false`, and `sendMail` rejecting: response still
  200 with that same JSON.
- Stored email `''`, `'   '`, `'person @example.com'`, and
  `'a@b.com,c@d.com'`: `sendMail` not called, response 200. Spy on
  `console.log` and assert the skip line is
  `approval email skipped: invalid recipient` and does not contain the
  address.
- `PUBLIC_ORIGIN` unset: `sendMail` not called, response 200 with the
  same JSON, log line `approval email skipped: PUBLIC_ORIGIN unset`.
- Deny with `{ kind: 'ok' }`, revoke with `{ kind: 'ok' }`, and the
  existing unknown-request refusal: `sendMail` not called. On the
  refusal, status stays 404.
- `applyDecision` rejecting: status 503, `sendMail` not called.

Verify: `npx vitest run server/admin.test.ts server/mail.test.ts`.

### 3. [core] Invitation-only and recorded copy

Files: `server/access.ts`, `server/access.test.ts`.

Replace the two `invitationOnlyPage` paragraphs with the Decision 7
strings. Keep the form, the hidden `t` field, escaping, the footer, and
the no-form branch when `requestToken` is null.

`recordedPage` is private and returns a `Response`. Export the document
the same way `unavailablePageHtml` is exported, and keep the response
helper private:

```ts
export function recordedPageHtml(promiseEmail: boolean): string
```

Build the body paragraph once. `recordedPageHtml` returns
`pageHtml('Request sent', body)` and stays exported for
`server/access.test.ts`. `recordedPage()` returns
`htmlPage('Request sent', body, 200)` so its headers stay on `htmlPage`.
Do not construct a second `Response` with those headers. Do not export a
second page function.

In `server/access.test.ts`:

- The form case expects
  `Your request goes to the owner of this app. Once it is approved, we'll email you, and you can sign in again.`
  and does not contain `Nobody will email you back`.
- The null-token case still expects `could not be started right now` and
  `signing in again will offer it once more`, expects
  `Once you have been approved, we'll email you, and you can try signing in again.`,
  and does not contain `Nobody will email you back`. The existing
  no-form assertions (`not.toContain('<form')`, and the rest) stay.
- New `describe('recordedPageHtml')` expects `<h1>Request sent</h1>`,
  `Your request was recorded.`, and
  `Once it is approved, we'll email you.`

`accessRequestPost` is unchanged aside from still omitting `to`.

Verify: `npx vitest run server/access.test.ts`.

### 4. [core] Privacy disclosure

File: `public/privacy.html`.

Insert the sentences from Decision 8 in the Third parties paragraph,
between the owner-notification sentence and "Hosting is on Google Cloud."
Do not rewrite the rest of the paragraph.

Verify: `git diff -U3 -- public/privacy.html` shows only that insertion.
The photo sentences ("Photos you add on the Import screen" through "are
not stored and are not attached to the saved recipe.") are still present
unchanged.

### 5. [core] Amend i18n principle 9

File: `docs/constitutions/i18n.md`.

In principle 9's exception list, replace the bullet `the owner notification email` with `the owner notification email and the approval email to the requester`. Leave the static-pages bullet, the server-rendered access and invite HTML bullet, and the Chrome extension bullet as they are.

Append this row to the Amendments table:

| Date | Principle | Change | Why |
| --- | --- | --- | --- |
| 2026-09-30 | 9 | Named the approval email to the requester alongside the owner notification email in the English exception list. | The product now emails the requester on approval. That mail is server-sent English, the same class as the owner notification, so it stays outside the catalogs and the in-context review. |

Do not change the frontmatter `description`. Do not add keys under
`src/i18n/`. Do not edit `docs/i18n-review/screens.json`. Do not run the
in-context translation review.

Verify: `npx vitest run scripts/constitutions.test.ts`.

### 6. [core] Plans table

File: `AGENTS.md`.

Append one row to the Plans table, after the `docs/plans/collection-path.md`
row:

`| `docs/plans/approval-email.md` | Open. Email the requester after an admin approves an access request. Not deployed. |`

Do not edit the Feature constitutions index. Do not change other plan rows.

Verify: `npx vitest run scripts/invariants.test.ts scripts/constitutions.test.ts`.
Then `npm test` and `npm run build` from the repo root.

## Non-goals

- No email on deny, revoke, or invite-link redemption.
- No HTML email and no second mail provider.
- No catalog translations and no in-context translation review.
- No deploy.
- No change to the owner-notification recipient, subject, body, or dedupe
  (`notificationEligible`, the 24-hour window, `requestCount`, and the
  daily counter).
