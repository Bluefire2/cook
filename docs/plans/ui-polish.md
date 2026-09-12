# UI polish

Make Cook feel like a finished desktop-and-touch cookbook PWA. This is interaction and visual consistency only — no new screens, data models, APIs, Dexie fields, or chat capabilities. Dark/light tokens and persistence in `docs/plans/dark-mode-default.md` stay as-is; reuse them.

## Decisions (not blocking)

- **Hover fill:** `hover:bg-surface-muted` on cards, ghost/icon/secondary buttons, and default menu items. Keep existing `active:bg-surface-muted` so touch still flashes. **Every new fill or opacity hover must have the same `active:` twin** — including Settings theme outlines, RecipeView cook rows / servings, Chat attach, and photo ✕. Do not ship hover-only color. Text-only `hover:text-ink` on `backLink` / source / not-found links may stay text-only.
- **Danger hover:** overflow “Delete” and other danger *rows* use `hover:bg-danger-bg active:bg-danger-bg` (not the same muted gray as Edit). Filled destructive confirms use the new fill tokens below, not `bg-danger` (`--color-danger` is a *text* color and is too pale as a dark-mode fill).
- **Primary hover:** `hover:opacity-90 active:opacity-90` on `bg-ink` / filled ink buttons. Amber Ask FAB uses `hover:bg-amber-600 active:bg-amber-600` (already has `active:`).
- **Focus:** keyboard only. Global `:focus-visible` outline on links, buttons, and `role="menuitem"` (`2px solid var(--color-ink)`, offset 2px). Inputs keep `outline-none` **and** must restore a solid outline on `:focus-visible` (`focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink`). Do not add `focus:` rings that appear on mouse click.
- **Overflow menu keyboard:** Escape closes and returns focus to the ⋯ trigger. Opening focuses the first `menuitem` **after the panel mounts** (see step 3). Backdrop click still closes. **No** arrow-key roving tabindex and **no** new menu library.
- **Menu ARIA:** trigger gets `aria-expanded`, `aria-haspopup="menu"`. Panel gets `role="menu"`. Edit/Delete get `role="menuitem"`.
- **Library Escape (one listener):** Use **one** `document` `keydown` in `Library`. The effect **must depend on `[menuId, pendingDeleteId, addOpen]`** and re-bind the listener when those change (or keep a long-lived listener that reads those three from refs updated every render). Do **not** close over state in a mount-only `[]` effect — Library stays mounted, so that listener forever sees all overlays closed. Priority: **menu → delete sheet → add sheet**. `preventDefault` when handling. Restore focus to ⋯ **only** for menu Escape. Backdrop / pointer dismiss still skips focus restore. Search `type="search"` browser Escape-to-clear is fine: the handler no-ops when no overlay is open. The Add `Sheet` is `fixed inset-0 z-30` and covers cards / ⋯ / FAB — do not claim they stay clickable through it, and do not raise their z-index. Escape priority is defensive only (menu and Add cannot both be pointer-reachable).
- **Sheets / chat:** Backdrop `bg-black/40` (today’s `/20` is faint on dark). Keep `md:max-w-xl` centering. Add a `h-1 w-10` (`40×4px`) `bg-line-strong` handle bar on Library sheets only (chat already has a titled header). Chat Escape is its own `document` listener in `ChatPanel` (step 9) — not a panel `onKeyDown`.
- **Shared classes, not components:** put repeated class strings in `src/lib/uiClasses.ts`. Do **not** add a `<Button>` component, React Context, or new CSS `@utility` framework. Screens keep Tailwind in `className`. **Never concatenate two utilities that set the same CSS property** (e.g. do not put `px-4 py-3` on `inputClass`, or `hover:bg-danger-bg` on `addBtn`). Layout extras that do not conflict (`mt-2`, `mb-4`, `flex-1`, `w-full`, `text-center`) stay at the call site.
- **Amber cook chrome stays amber:** RecipeView current-step `ring-amber-400` / `text-amber-500`, “Done — enjoy!” `text-amber-600`, Ask FAB `bg-amber-500` — already decided in the dark-mode plan.
- **No theme work:** do not retune `--color-*` page/surface/ink tokens or `theme.ts` / `index.html` persistence.

## Goal

Desktop pointer users get hover and focus-visible on every existing control. Touch users keep the same tap targets and `active:` feedback. Primary / secondary / danger / ghost / icon treatments look the same on every screen. The Library overflow menu behaves like a normal web dropdown.

## Assumptions

- Implementers can run `npm run build` and click through `npm run dev` on a desktop browser (hover + Tab) and a narrow viewport (touch `active:`).
- Existing semantic tokens in `src/index.css` are sufficient except one filled-danger pair (see step 1).
- `src/App.tsx`, `src/main.tsx`, and `index.html` need no polish edits (routing and first-paint theme only).
- RecipeForm already centralizes `inputClass` / `cellClass` / `iconButtonClass` / `addButtonClass` — replace those locals with the shared exports rather than inventing a second set.

## Inventory (what is actually unfinished)

Verified by reading the listed UI files. Nothing below is a new screen.

| Gap | Where |
|---|---|
| No `hover:` anywhere in `src/` | All interactive controls |
| No `focus-visible` anywhere | Same |
| Overflow Edit/Delete are `active:` only | `Library.tsx` menu |
| Menu has no `role` / Escape / focus restore | `Library.tsx` |
| Header back-links are muted text, no hover | RecipeView, RecipeEdit, Import, Settings |
| Ghost pills (Settings, Edit, Chat Close) have no hover | Library, RecipeView, ChatPanel |
| Delete confirm is hardcoded `bg-red-600 text-white` | Library delete sheet |
| Sheet/chat scrim is `bg-black/20` | Library `Sheet`, ChatPanel |
| Form/icon/add/cancel/save lack hover | RecipeForm, Import, Settings |
| Recipe cards, ⋯, FAB lack hover | Library |
| Ingredient/step rows and servings ± lack hover | RecipeView |
| Theme outline option and backup buttons lack hover | Settings |
| Settings Save is `py-2` vs other primaries `py-3` | Settings |
| Settings import status is always `text-ink-muted` | Settings |
| Chat composer/attach/send/proposal/photo-remove lack hover | ChatPanel |
| Inputs are `outline-none` with only a border color change | Library search, RecipeForm, Import, Settings, Chat |

## Files to change

- `src/index.css` — danger-fill tokens; global focus-visible; disabled cursor
- `src/lib/uiClasses.ts` — **new**, class-string exports only
- `src/screens/Library.tsx`
- `src/screens/RecipeView.tsx`
- `src/screens/RecipeEdit.tsx`
- `src/screens/ImportScreen.tsx`
- `src/screens/Settings.tsx`
- `src/components/RecipeForm.tsx`
- `src/components/ChatPanel.tsx`

Do not change `src/App.tsx`, `src/main.tsx`, `index.html`, stores, APIs, or `docs/plans/dark-mode-default.md`.

## Steps

### 1. [core] Shared class strings and danger-fill tokens

Files: `src/lib/uiClasses.ts` (new), `src/index.css`

In `@theme` **and** the existing `@layer theme { html.dark { … } }` block, add the same pair on both themes (a filled red button should not invert to pale pink). Same hex in both places; do not add a new unlayered `html.dark` block:

| Token | Value | Utility |
|---|---|---|
| `--color-danger-fill` | `#dc2626` | `bg-danger-fill` |
| `--color-danger-fill-hover` | `#b91c1c` | `bg-danger-fill-hover` / `hover:bg-danger-fill-hover` |

Do not change any existing token.

Export these strings from `uiClasses.ts`. **Composition rule:** a call site may append only non-conflicting extras (`mt-*`, `mb-*`, `flex-1`, `w-full`, `text-center`, `block`). If a control needs different padding, radius, background, or hover fill than the shared string, use `inputFocus` / a dedicated export — do not stack a second utility for the same property.

```
inputFocus
  outline-none focus:border-ink-subtle focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink

inputClass
  w-full rounded-xl border border-line bg-surface px-3 py-2.5 shadow-sm ${inputFocus}

cellClass
  min-w-0 rounded-lg border border-line px-2 py-1.5 ${inputFocus}

primaryBtn
  rounded-full bg-ink font-medium text-page hover:enabled:opacity-90 active:enabled:opacity-90 disabled:opacity-40

secondaryBtn
  rounded-full border border-line-strong font-medium text-ink-muted hover:bg-surface-muted active:bg-surface-muted

ghostBtn
  rounded-full px-3 py-1 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink active:bg-surface-muted

backLink
  text-sm text-ink-muted hover:text-ink

iconBtn
  flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-muted active:bg-surface-muted disabled:opacity-30

addBtn
  rounded-full border border-line-strong px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-muted active:bg-surface-muted

addBtnDanger
  rounded-full border border-line-strong px-3 py-1.5 text-sm text-danger hover:bg-danger-bg active:bg-danger-bg

menuItem
  block w-full px-4 py-3 text-left hover:bg-surface-muted active:bg-surface-muted

menuItemDanger
  block w-full px-4 py-3 text-left text-danger hover:bg-danger-bg active:bg-danger-bg

dangerBtn
  rounded-full bg-danger-fill font-medium text-white hover:bg-danger-fill-hover active:bg-danger-fill-hover
```

`inputClass` / `cellClass` include `focus-visible:outline-solid` because `outline-none` sets `outline-style: none`; `outline-2` alone does not restore a visible ring in Tailwind v4.

No React in this file. No tests required (string constants). Later steps import these instead of restating the hover/focus set.

**Verify:** `npm run build` (new file typechecks; tokens emit `bg-danger-fill`).

### 2. [ui] Global focus-visible and disabled cursor

File: `src/index.css`

Keep `button:not(:disabled) { cursor: pointer; }`. Add:

- `button:disabled { cursor: not-allowed; }`
- `:where(a, button, [role="menuitem"]):focus-visible { outline: 2px solid var(--color-ink); outline-offset: 2px; }`

Do not set `outline` on `:focus` (mouse). Do not restyle page/surface/ink tokens. Do **not** add `input` / `textarea` to this `:where` — those keep `outline-none` plus the `inputFocus` utilities from step 1.

**Verify:** `npm run build`. Tab through Library header (Settings first) → search → a card; a 2px ink outline appears only from the keyboard.

### 3. [ui] Library overflow menu (hover, ARIA, focus after mount)

File: `src/screens/Library.tsx`

This is the user’s concrete example. Escape wiring for the menu lives in the **single** Library listener specified in step 4 — do not add a second `keydown` here.

- Edit `Link` and Delete `button`: `menuItem` / `menuItemDanger`, and **`role="menuitem"` on both** (the focus query depends on it). Delete keeps `border-t border-line`.
- Panel: `role="menu"` and `aria-label={`Actions for ${recipe.title}`}`. Keep `z-20` (above the z-10 backdrop). Bind a `menuPanelRef` on this node.
- ⋯ trigger: `aria-expanded={menuId === recipe.id}`, `aria-haspopup="menu"`, plus `hover:bg-surface-muted active:bg-surface-muted` (keep `h-11 w-11`).
- **Focus after mount (do not query in the ⋯ `onClick`):** the panel is not in the DOM until after `setMenuId`. On ⋯ click, save `event.currentTarget` into a `menuTriggerRef`. A `useEffect` that depends on `menuId` runs after the panel mounts: `if (!menuId) return`; then `menuPanelRef.current?.querySelector('[role="menuitem"]')` and `.focus({ preventScroll: true })`. One trigger ref plus one panel ref — no ref-per-row map.
- Backdrop click still closes (no focus restore on pointer dismiss).
- Do not add arrow-key navigation.

**Verify:** `npm run build`. Desktop: hover Edit → `surface-muted`; hover Delete → `danger-bg`. Tab to ⋯, Enter, first item focused (after paint). Touch: tap still highlights via `active:`.

### 4. [ui] Library cards, FAB, header, sheets, and one Escape listener

File: `src/screens/Library.tsx`

- Settings header `Link`: `ghostBtn`.
- Search: `inputClass` plus existing non-conflicting extras only (`mb-4`). Today’s search is `px-4 py-2.5`; shared `inputClass` is `px-3 py-2.5` — **accept the shared padding**. Do not append `px-4`.
- Recipe card `Link`: add `hover:bg-surface-muted hover:border-line-strong` next to existing `active:bg-surface-muted`. Optional `transition-colors`.
- Add FAB: `hover:opacity-90` (already has `active:opacity-90`).
- `Sheet` backdrop: `bg-black/40`. Add a centered handle `mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong` above the title. Keep `md:max-w-xl`.
- Add-sheet actions (keep today’s `mt-3` / `mt-2` / `block` / `text-center`):
  - Import: `primaryBtn mt-3 block py-3 text-center`
  - Scratch: `secondaryBtn mt-2 block py-3 text-center`
  - Cancel: keep `mt-2 w-full py-2.5 text-sm text-ink-muted hover:text-ink` (ad-hoc ghost; do not force `ghostBtn`)
- Delete confirm: `dangerBtn mt-3 w-full py-3` (replaces `bg-red-600 text-white active:bg-red-700`). Cancel: `secondaryBtn mt-2 w-full py-3`.
- Pointer-only scrims (the `fixed inset-0` menu closer and the `Sheet` dismiss button): `tabIndex={-1}` so the step 2 `:focus-visible` rule does not ring a full-screen backdrop. Keyboard dismiss is Escape.
- **One `document` `keydown` `useEffect` whose dependency array is `[menuId, pendingDeleteId, addOpen]`** (re-bind when overlays change). Do not use `[]`. On `Escape`:
  1. If `menuId !== null`: `preventDefault`, close the menu, focus `menuTriggerRef.current`.
  2. Else if `pendingDeleteId !== null`: `preventDefault`, close the delete sheet (no focus restore).
  3. Else if `addOpen`: `preventDefault`, close the add sheet (no focus restore).
  4. Else: do nothing (let search-clear / browser defaults run).
- Do not put `onKeyDown` on `Sheet` — focus often stays on the FAB or a card, which are siblings, not descendants. Do not add a second Escape listener in this file. Do not raise card / ⋯ / menu z-index so they poke through the Add sheet.

**Verify:** Hover Settings, a card, the FAB, and every sheet action. Delete confirm is token red (`bg-danger-fill`), not raw `bg-red-600`. Escape sequentially: open menu → Esc (focus returns to ⋯); open delete → Esc; open add → Esc. Backdrop is visibly dimmer. Do not try to open ⋯ through the Add sheet.

### 5. [ui] Header back-links and ghost chrome on other screens

Files: `src/screens/RecipeView.tsx`, `src/screens/RecipeEdit.tsx`, `src/screens/ImportScreen.tsx`, `src/screens/Settings.tsx`

- Every `&larr; …` `Link` uses `backLink`.
- RecipeView header Edit uses `ghostBtn`.
- Not-found “Back to library” links (`RecipeView`, `RecipeEdit`): `underline` plus `hover:text-ink` (keep the sentence layout).
- RecipeView source hostname `<a>`: keep `underline`, add `hover:text-ink`.

Do not restyle RecipeView cook controls here (step 8).

**Verify:** Hover/Tab the back link on Recipe, Edit, New, Import, and Settings. Edit pill on RecipeView highlights. Not-found and source links darken on hover.

### 6. [ui] RecipeForm and Import controls

Files: `src/components/RecipeForm.tsx`, `src/screens/ImportScreen.tsx`

RecipeForm:

- Delete local `inputClass` / `cellClass` / `iconButtonClass` / `addButtonClass`; import the shared exports (`iconBtn` replaces `iconButtonClass`, `addBtn` replaces `addButtonClass`).
- Keep existing layout wrappers: `` `mt-1 ${inputClass}` ``, `` `flex-1 ${inputClass}` ``, `` `w-14 ${cellClass}` ``, `` `mt-1 w-full ${cellClass}` `` — those extras do not conflict.
- Photo Replace: `addBtn` (no extra hover). Photo Remove: **`addBtnDanger` only** — do not compose `addBtn` + `hover:bg-danger-bg`.
- “+ Photo” / “+ Ingredient” / “+ Section” / “+ Step”: `` `mt-2 block ${addBtn}` `` (today’s `addButtonClass` included `mt-2`; “+ Photo” also needs `block` or it sits on the same line as the “Photo” label).
- Footer Cancel: `secondaryBtn flex-1 py-3`. Save: `primaryBtn flex-1 py-3`.
- Icon buttons become `h-10 w-10` via `iconBtn` (today `h-9 w-9`).

Import:

- Textarea: do **not** put `inputClass` + `px-4 py-3` together. Use `inputClass` as-is (accept `px-3 py-2.5`) **or** compose only non-conflicting pieces: `w-full rounded-xl border border-line bg-surface px-4 py-3 shadow-sm` + `inputFocus`. Prefer the second so the current taller textarea padding stays. Keep `rows={5}`.
- Extract: `primaryBtn mt-3 w-full py-3`.
- Leave the accent-soft preview notice as-is.

**Verify:** `npm run build`. On New / Edit / Import, hover every add/icon/photo/footer button; Tab shows input outlines; disabled Save/Extract stay `opacity-40` with `not-allowed`. Photo Remove hovers danger-bg, not muted.

### 7. [ui] Settings actions and status color

File: `src/screens/Settings.tsx`

- Password field: `mt-1` + `inputClass` (accept shared `px-3`; do not also set `px-4`).
- Save: `primaryBtn mt-3 px-5 py-3` (normalize from `py-2`).
- Unselected theme option: `hover:bg-surface-muted active:bg-surface-muted` on the outline (`border-line-strong text-ink-muted`) branch. Selected stays `bg-ink text-page` (no extra hover).
- Export / Import backup: `secondaryBtn flex-1 py-2.5`.
- Status line: success (`Imported …`) uses `text-success`; failure uses `text-danger`. Track a local `'ok' | 'err'` (or equivalent) next to the message — presentation state only, no settings/backup API change.

**Verify:** Hover/press Dark/Light (unselected), Export, Import, Save. Failed backup import is danger-colored; successful import is success-colored. Theme still persists (do not regress step 8 of the dark-mode plan).

### 8. [ui] RecipeView cook controls and Ask FAB

File: `src/screens/RecipeView.tsx`

- Servings −/+: `hover:bg-surface-muted active:bg-surface-muted` (keep `disabled:opacity-30` on minus).
- Unchecked ingredient / todo step: `hover:bg-surface-muted active:bg-surface-muted`.
- Checked ingredient: `hover:bg-surface active:bg-surface` (hint that tap unchecks).
- Current step: keep `ring-2 ring-amber-400`; no extra hover fill.
- Done step: leave `bg-surface-muted`; optional `hover:bg-surface active:bg-surface`.
- Ask FAB: add `hover:bg-amber-600` beside existing `active:bg-amber-600`. Keep `bg-amber-500 text-white`.
- Do not retokenize amber.

**Verify:** Hover and tap servings, an unchecked ingredient, a todo step, and Ask. Current step ring unchanged. Tap-to-check and tap-to-advance still work on a narrow viewport.

### 9. [ui] ChatPanel sheet and composer

File: `src/components/ChatPanel.tsx`

- Backdrop: `bg-black/40` (match Library sheets). Chat backdrop button: `tabIndex={-1}` (same as Library scrims).
- Close: `ghostBtn`.
- **Escape:** a `document` `keydown` `useEffect` in `ChatPanel` (add on mount, remove on unmount) calls `onClose` and `preventDefault`. Do **not** rely on the panel `onKeyDown` — opening chat unmounts the Ask FAB (`{!chatOpen && …}` in `RecipeView`), so focus is often on `body`. Do not add `tabIndex={-1}` autofocus on the sheet (that would steal the composer). Existing abort-on-unmount stays.
- Proposal Apply: `primaryBtn flex-1 py-2 text-sm`. Variant: `secondaryBtn flex-1 py-2 text-sm`.
- Attach: today’s `bg-surface-muted` circle gets `hover:bg-line-strong active:bg-line-strong`. Do **not** use `hover:bg-line` — in dark mode `--color-line` and `--color-surface-muted` are the same `#44403c`.
- Send: `primaryBtn h-10 px-4`.
- Pending photo ✕: `hover:opacity-80 active:opacity-80` (keep the small chip; do not inflate to 44px).
- Composer textarea: keep today’s layout classes exactly (`max-h-32 flex-1 resize-none rounded-2xl border border-line bg-page px-3.5 py-2`) and append **`inputFocus` only**. Do not use `inputClass` here (`rounded-xl bg-surface px-3 py-2.5` would fight).

Do not change send/stream/photo store behavior.

**Verify:** Open Ask and press Escape immediately (do not Tab to Close first) — sheet closes. Hover Close / attach / Send / proposal actions; attach fill is visibly stronger in **both** themes. Tab outline visible on composer controls. Existing send and photo-attach still work.

## Out of scope

- New screens, routes, or chat features
- Dexie / recipe / settings / chat data contracts
- Theme token redesign or persistence (already done)
- Arrow-key menu widget, focus trap, or a modal library
- New npm dependencies or React Context
- A shared `<Button>` / `<Sheet>` package
- Changing amber cook-mode accents to ink
- Playwright / visual-regression suite
- Raising card / ⋯ z-index so the overflow menu works through the Add sheet
- Closing the Add sheet when Delete opens (they cannot stack via pointer; Escape priority is defensive only)

## Risks

- **Global focus-visible vs `outline-none`:** `outline-none` zeros `outline-style`. Shared `inputFocus` must include `focus-visible:outline-solid` (step 1). Global `:where` omits inputs on purpose.
- **`bg-danger` as a fill:** using the text token as a button background fails in dark mode. Step 1’s `danger-fill` exists so step 4 does not do that.
- **Tailwind v4 class conflicts:** later source-order utilities win, not `className` order. Shared strings plus a second `px-*` / `hover:bg-*` / `rounded-*` will drop spacing or hide the intended hover. Follow the composition rule in Decisions.
- **Menu focus vs card Link:** focusing a menuitem must not also activate the recipe card. Keep the menu `z-20` above the card and the invisible backdrop at `z-10`. Focus the first item in `useEffect` after mount, not in the ⋯ click handler.
- **Hover on touch:** some mobile browsers fire a sticky hover after tap. Always pairing `hover:` with the same `active:` fill avoids a “dead” first tap. Do not use `@media (hover: hover)` unless a sticky-hover bug shows up in verification.
- **Escape listeners:** Library has one listener (menu / delete / add). ChatPanel has its own. Do not add a global app-level handler. When no overlay is open, Library’s handler must not `preventDefault`.

## Open Questions

None. Defaults above cover hover color, danger fill, focus-visible, menu keyboard scope, Escape priority, and class composition.

## Status

- [x] 1. [core] Shared class strings and danger-fill tokens
- [x] 2. [ui] Global focus-visible and disabled cursor
- [x] 3. [ui] Library overflow menu (hover, ARIA, focus after mount)
- [x] 4. [ui] Library cards, FAB, header, sheets, and one Escape listener
- [x] 5. [ui] Header back-links and ghost chrome on other screens
- [x] 6. [ui] RecipeForm and Import controls
- [x] 7. [ui] Settings actions and status color
- [x] 8. [ui] RecipeView cook controls and Ask FAB
- [x] 9. [ui] ChatPanel sheet and composer
