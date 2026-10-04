# New-member intro

Status: planned, not built.

## Goal

The first time a new member reaches their library, a short intro (three steps
in a sheet) says what Sous can do, then gets out of the way:

1. **Bring your recipes in.** Paste a link or recipe text, or take up to four
   photos of handwritten notes; Sous turns it into a clean recipe.
2. **Cook with help.** Ask on any recipe answers questions, scales, swaps
   ingredients and suggests edits; you can dictate instead of typing. The
   assistant works across your whole library, for example to make a shopping
   list. Cooks keeps a log of what you made and how it went.
3. **Organise and share.** Put recipes in collections, share a collection with
   people who use Sous, and invite friends.

The last step ends with **Import a recipe** (primary) and **Look around**
(secondary). Every step has **Skip**. The intro can be reopened from Settings.

Why: today a new member lands on "No recipes yet. Import your first one!" and
an add button. Ask, the assistant, collections, sharing and the cook log aren't
visible until there is a recipe, so new members don't find them.

## Out of scope

- A guided tour that highlights real controls (coach marks, spotlights).
- Server state: no Firestore field, no route, no log line. See D2.
- Sample or seeded recipes in a new library.
- Changing the empty-library sentence, the add sheet, or `/about`.
- Mentioning the Chrome extension (not offered beyond the owner) or connected
  AI apps (a niche Settings feature with its own explanation there).
- Signed-out, public (`/p/...`), and non-member screens.

## Constitutions applied

- **Client state** (`docs/constitutions/client-state.md`): principle 6 (the
  intro is a Library sheet in the `libraryFlow` reducer) and principles 3 and 5
  (the "seen" flag is read only in an effect or handler, never during render).
- **i18n** (`docs/constitutions/i18n.md`): all copy goes in every catalog, and
  the new screens are added to `docs/i18n-review/screens.json`.

No principle is broken, so no amendment is needed.

## Decisions

**D1. Who sees it.** The intro opens on Library when all of these are true:

- the session is `signedIn`;
- the owned pull has finished without an error (`recipes !== undefined` and
  sync status is not an error);
- the member has **no live recipes of their own** (shared rows don't count);
- `cook.introSeen` is not set in this browser;
- no other Library sheet is open.

This covers every way a person becomes a member: an invite link, an approved
access request, and owners. It also covers someone whose first visit is to
join a shared collection (`/c/join`, `/p` join): they have shared recipes but
none of their own, and the intro is still useful to them. Existing members
never see it, because they have recipes.

**D2. Store the "seen" flag on the device, not on the server.** We considered
storing it as `introSeenAt` on `users/{sub}`, returned by `/api/auth/session`
and set by a new route. Rejected because:

- `authSession` would need a Firestore profile read on every call (today it
  only checks cached membership), or the client would need a separate fetch;
- existing members would need a backfill or a launch-date cutoff to avoid
  seeing it;
- it adds a route, a new profile field, and new copy in `/privacy`.

"No recipes of your own yet" is when an intro helps anyway. The cost of the
device flag: a member whose library is still empty sees the intro once more on
each new browser. A second person who signs in on the same browser won't see
it. Both are rare in an invitation-only app, and the Settings link (D6)
covers them.

**D3. A Library sheet, not a route.** The intro is
`{ kind: 'intro'; step: 0 | 1 | 2 }` in `LibrarySheet`
(`src/lib/libraryFlow.ts`), drawn with the existing `Sheet` (`DialogShell`
already handles the focus trap, initial focus, restoring focus on close, and
Escape). A `/welcome` route was rejected: the OAuth `returnTo` flows
(`/c/join`, `/p`) would each need to know about it, and the back button would
return to the intro.

**D4. Opening it is an effect; the reducer stays pure.** A Library effect checks
`shouldOfferIntro(...)` (pure, in `src/lib/intro.ts`) and the `readIntroSeen()`
value, and dispatches `openIntro`. The reducer ignores `openIntro` unless the
sheet is `closed`, so it never replaces a sheet the person opened in the
meantime. The localStorage read happens in the effect, not during render
(client-state principle 5).

**D5. Every close marks it as seen.** Skip, the backdrop, Escape, Look around,
and Import a recipe all call `markIntroSeen()`, then close. Import a recipe
then goes to `importHref(currentCollectionId)`, the same destination as the add
sheet's first button. Reloading in the middle of the intro shows it again;
that's fine.

**D6. Reopening.** Settings gets a **Show the intro** link in the Feedback
section, above About. It goes to `/` with router state `{ intro: true }`.
Library opens the intro when it sees that state, whatever the library holds,
then clears the state with `navigate(location.pathname, { replace: true,
state: null })` so a reload doesn't reopen it.

**D7. Storage key.** `cook.introSeen`, value `'1'`, alongside the other
`cook.*` keys. Reads and writes are in try/catch. If the read throws, the
intro is not offered (in a browser that blocks storage, it would otherwise
reopen on every visit). Sign-out doesn't clear the key.

**D8. Copy describes only what production has.** Several features the steps
mention are merged but not deployed (photo import, the library assistant,
member invite links). Before the deploy that ships the intro, check each
sentence against what that deploy includes, and remove any clause it doesn't.
Keep each step to a heading and at most two sentences.

**D9. Steps are text, with one icon from `src/lib/icons.tsx`** (`CameraIcon`,
`ChatBubbleIcon`, `FolderIcon`). No images or illustrations, so nothing needs
translating per locale and nothing grows the bundle.

## Steps

1. **[core]** `src/lib/intro.ts`: `INTRO_SEEN_KEY`, `readIntroSeen()`,
   `markIntroSeen()` (both with try/catch, as `readStorage` does in
   `settings.ts`), and a pure `shouldOfferIntro({ sessionStatus, recipes,
   syncError, seen })` that implements D1. Unit tests cover every condition,
   including "only shared recipes" (offered) and "one own recipe" (not offered).
2. **[core]** `src/lib/libraryFlow.ts`: add the `intro` sheet kind, plus
   `openIntro` (only from `closed`) and `introStep { step }` (clamped to 0–2).
   Opening it bumps `token` like any other sheet. Add reducer tests in
   `libraryFlow.test.ts`, including `openIntro` while `add` is open (no
   change).
3. **[ui]** `src/components/IntroSheet.tsx`: one step at a time (icon, heading,
   body), "Step {n} of {total}", Back / Next, and Skip; the last step shows
   Import a recipe and Look around instead of Next. On a step change, focus
   moves to the step heading (`tabIndex={-1}`) so screen readers read it. No
   animation.
4. **[ui]** `src/screens/Library.tsx`: the effect from D4 and the router-state
   handling from D6, render `IntroSheet` for `sheet.kind === 'intro'`, and a
   close handler that calls `markIntroSeen()` then dispatches `close`.
5. **[ui]** `src/screens/Settings.tsx`: the Show the intro link (D6), shown
   only when signed in.
6. **[ui]** `intro.*` keys and `settings.showIntro` in `src/i18n/en.ts`, `uk.ts`,
   `ru.ts` and `zh-Hans.ts`. Each sentence is one catalog string; "Step {n} of
   {total}" is one string with params. Add `intro-step-1`, `intro-step-2` and
   `intro-step-3` to `docs/i18n-review/screens.json`, with setup notes
   ("signed in as a member with no recipes of their own, on a browser that
   hasn't seen the intro; or Settings → Show the intro").
7. **[ui]** `public/privacy.html` and `public/terms.html`: where they list
   `cook.locale`, also say that whether this browser has shown the intro is
   kept under `cook.introSeen`.
8. **[ui]** Add a row to the Plans table in `AGENTS.md`.

## Verification

- `npm test` and `npm run build`.
- In test mode (`npm run dev:test` + `npm run dev`):
  - `empty`: the intro opens once the library loads. Step through it, check
    Back, Next and focus, and use Import a recipe to land on `/import`.
    Reload: it doesn't reopen. Clear `cook.introSeen` and reload: it opens
    again. Skip, Escape and the backdrop each mark it as seen.
  - `member`, `owner`, `viewer` (each has recipes of their own): it never
    opens. Settings → Show the intro opens it on `/`, and reloading doesn't
    reopen it.
  - `empty` joining `member`'s public "Weeknights" link from `/p` (an account
    with only shared recipes): the intro opens on the library.
  - With the intro open, the add button and header controls can't be reached
    (the sheet is modal). With the add sheet already open, the intro waits.
- `npm run click:library` still passes (it signs in as `member`).
- Narrow phone width and dark mode: the sheet fits without horizontal scroll,
  and the buttons don't wrap awkwardly in `uk`/`ru` (the longest strings).
- Before the PR: the in-context translation review
  (`docs/i18n-review/README.md`) for the three intro screens and Settings in
  `uk`, `ru` and `zh-Hans`.

No check here needs `dev:api` or a real Google sign-in.

## Open questions

- Should someone who arrives only to view a shared collection see the intro?
  This plan says yes (D1). Changing it means also requiring "no shared rows"
  in `shouldOfferIntro`.
- If the owner later wants the intro to mention new features to existing
  members ("what's new"), that's a different trigger (a version number in
  storage) and a separate plan.
