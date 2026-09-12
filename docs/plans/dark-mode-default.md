# Dark mode as the default

Add a persisted light/dark theme. Dark is the default for new visitors and anyone without a stored preference. Light keeps the current cream/stone cookbook look. No new dependencies, no React Context, no Dexie/API changes.

## Decisions (not blocking)

- Values: `'dark' | 'light'` only. No system/OS option.
- Toggle lives on Settings under Appearance. Library does not get a second control.
- Semantic CSS variables on `:root` / `html.dark` so screens keep one class per role (`bg-page`, `bg-surface`) instead of a `dark:` pair on every utility.
- Theme class + `theme-color` applied before first paint via a tiny inline script in `index.html`.
- Persistence follows `src/lib/settings.ts` (`localStorage`).

## Token map

Define these in `src/index.css` `@theme` so Tailwind emits utilities (`bg-page`, `text-ink`, …). Light values match today’s cream/stone. Dark values are warm stone, not `#000`.

| Token | Light (today) | Dark |
|---|---|---|
| `--color-page` | `#faf7f2` (cream) | `#1c1917` (stone-900) |
| `--color-surface` | `#ffffff` | `#292524` (stone-800) |
| `--color-surface-muted` | `#f5f5f4` (stone-100) | `#44403c` (stone-700) |
| `--color-ink` | `#292524` (stone-800) | `#f5f5f4` (stone-100) |
| `--color-ink-muted` | `#78716c` (stone-500) | `#a8a29e` (stone-400) |
| `--color-ink-subtle` | `#a8a29e` (stone-400) | `#78716c` (stone-500) |
| `--color-line` | `#e7e5e4` (stone-200) | `#44403c` (stone-700) |
| `--color-line-strong` | `#d6d3d1` (stone-300) | `#57534e` (stone-600) |
| `--color-danger-bg` | `#fef2f2` (red-50) | `#450a0a` (red-950) |
| `--color-danger` | `#dc2626` (red-600) | `#fca5a5` (red-300) |
| `--color-accent-soft` | `#fef3c7` (amber-100) | `#78350f` (amber-900) |

Keep `--color-cream` as an alias of the light page color for any leftover use. Amber CTAs (`bg-amber-500`, cook FAB, current-step ring) stay amber — they already read on both backgrounds.

Primary actions that are currently `bg-stone-800 text-white` become `bg-ink text-page` so they invert with the theme (dark pill on cream, light pill on dark).

Also add `--color-success: #15803d` (green-700) light / `#4ade80` (green-400) dark, used for chat proposal added-lines (`text-green-700` is unreadable on a dark surface).

`html.dark` also sets `color-scheme: dark` so native inputs/scrollbars match.

**Tailwind v4 override rule:** `@theme { --color-page: … }` emits those variables on `:root`. Dark values must be reassigned in `@layer theme { html.dark { --color-page: … } }` so they win on specificity and stay in the theme layer. Do not put dark assignments only in a raw `html.dark` block outside a layer — that can lose to `:root` depending on emit order.

Hex `#1c1917` / `#faf7f2` is copied in three places on purpose (`src/lib/theme.ts`, the `index.html` inline script, `vite.config.ts`). Keep them identical. Do not import `theme.ts` from the inline script.

Class replacement (every UI file below — including shared class-string constants in `RecipeForm.tsx`):

- `bg-cream` → `bg-page`
- `bg-white` → `bg-surface`
- `bg-stone-50` / `bg-stone-100` / `active:bg-stone-50` / `active:bg-stone-100` → `bg-surface-muted` / `active:bg-surface-muted`
- `text-stone-800` (body) → `text-ink`
- `text-stone-700` / `text-stone-600` / `text-stone-500` → `text-ink-muted`
- `text-stone-400` → `text-ink-subtle`
- `border-stone-100` / `border-stone-200` → `border-line`
- `border-stone-300` → `border-line-strong`
- `focus:border-stone-400` → `focus:border-ink-subtle`
- `bg-stone-800 text-white` and `active:bg-stone-700` primary actions / Library FAB → `bg-ink text-page active:opacity-90`
- RecipeView checked-circle fill `bg-stone-300` → `bg-ink-subtle`
- `bg-red-50 text-red-600` → `bg-danger-bg text-danger` (keep `text-red-500` / `text-red-600` on delete / strikethrough if they still contrast; otherwise `text-danger`)
- `text-green-700` → `text-success`
- Chat user bubble `bg-amber-100` → `bg-accent-soft`
- Proposal / import warning `border-amber-200 bg-amber-50` / `bg-white` cards → `border-line bg-surface` (or `bg-accent-soft` for the import notice)

Do not blindly replace `text-white` on amber/red buttons or `bg-black/20` sheet scrims. Keep `ring-amber-400`, `text-amber-500`, `bg-amber-500` cook FAB, and `text-amber-600` “Done — enjoy!” — those already read on dark page.

**First-paint flash:** CSS loads after HTML. Default `<html class="dark">` is not enough — the browser paints white before `index.css` arrives. The inline script (and/or an inline `style` on `<html>`) must set `background-color: #1c1917` immediately, then switch it to `#faf7f2` if the stored theme is light.

## Steps

### 1. [core] Persist theme on settings

File: `src/lib/settings.ts`

- Export `type Theme = 'dark' | 'light'`.
- Add `THEME_KEY = 'cook.theme'`.
- `getTheme(): Theme` — return `'light'` only when stored value is `'light'`; otherwise `'dark'` (missing, empty, or garbage).
- `setTheme(value: Theme)` — write the key.

Do not change password helpers.

### 2. [core] Apply theme to `html` and browser chrome

New file: `src/lib/theme.ts`

- `PAGE_COLORS = { dark: '#1c1917', light: '#faf7f2' }`
- `applyTheme(theme: Theme): void`:
  - `document.documentElement.classList.toggle('dark', theme === 'dark')`
  - `document.documentElement.style.backgroundColor = PAGE_COLORS[theme]` (covers the pre-CSS paint)
  - Set `meta[name="theme-color"]` to `PAGE_COLORS[theme]` (create the tag if missing)
  - Set `apple-mobile-web-app-status-bar-style` to `black` when dark, `default` when light. Do **not** use `black-translucent` — that pulls content under the iOS status bar and would change layout vs today’s `default`.
- No React, no Context.

Call `applyTheme(settings.getTheme())` once from `src/main.tsx` after CSS import so React bootstraps match storage even if the inline script is skipped.

### 3. [core] Prevent cream flash on first paint

File: `index.html`

- Default `<html class="dark" style="background-color:#1c1917">`.
- Change `theme-color` default to `#1c1917`.
- Change `apple-mobile-web-app-status-bar-style` default to `black` (not `black-translucent`).
- Add a blocking inline script in `<head>` (no module, no imports) that:
  1. Reads `localStorage.getItem('cook.theme')` inside try/catch
  2. Treats anything other than `'light'` as dark
  3. Toggles `document.documentElement.classList` `'dark'`
  4. Sets `document.documentElement.style.backgroundColor` to `#1c1917` or `#faf7f2`
  5. Updates the `theme-color` meta to the same hex
  6. Updates `apple-mobile-web-app-status-bar-style` to `black` or `default`

Key name must stay `cook.theme` (same as step 1).

### 4. [core] PWA manifest defaults

File: `vite.config.ts`

Set `theme_color` and `background_color` to `#1c1917` so a newly installed PWA splash/status bar matches the default theme. Runtime switches still go through the meta tag from step 2 (the static manifest cannot follow a live toggle).

### 5. [core] Unit-test default and persistence

New file: `src/lib/settings.test.ts` (or `src/lib/theme.test.ts` if you split apply-logic tests)

Cover:

- `getTheme()` is `'dark'` when the key is missing
- `getTheme()` is `'dark'` when the stored value is invalid
- `setTheme('light')` then `getTheme()` is `'light'`
- `setTheme('dark')` then `getTheme()` is `'dark'`

Use Vitest + existing `localStorage`. Clear the key in `beforeEach`. If `applyTheme` is easy to test with a stub `document`, assert class + theme-color; otherwise settings-only is enough.

### 6. [ui] Semantic tokens and body styles

File: `src/index.css`

- Keep `@import "tailwindcss"`.
- Declare the token table above inside `@theme` (light values — these seed `:root`).
- Reassign every `--color-*` token for dark inside `@layer theme { html.dark { … } }`.
- `html.dark { color-scheme: dark; }` (this rule can live next to the layer block).
- Body: `bg-page text-ink antialiased` (replace `bg-cream text-stone-800`).
- Leave safe-area / overscroll rules unchanged.

### 7. [ui] Restyle screens and components onto tokens

Replace hardcoded light utilities using the class map. Touch every file; do not leave a `bg-white` card that disappears in dark mode.

Files:

- `src/screens/Library.tsx` — page, search, cards, tags, overflow menu, FAB, add/delete sheets
- `src/screens/RecipeView.tsx` — chrome, servings chip, ingredient checked/unchecked, step current/done/todo, notes card, chat FAB
- `src/screens/RecipeEdit.tsx` — back link, not-found state
- `src/screens/ImportScreen.tsx` — input, error, warning, submit
- `src/screens/Settings.tsx` — inputs, secondary buttons, helper text (Appearance control is step 8)
- `src/components/RecipeForm.tsx` — shared `inputClass` / icon / chip constants, photo controls, section cards, cancel/save
- `src/components/ChatPanel.tsx` — sheet, header, bubbles, proposal card, composer, attach chip

RecipeView state styles:

- Unchecked / todo / current step card: `bg-surface` (current keeps `ring-2 ring-amber-400`)
- Checked ingredient / done step: `bg-surface-muted text-ink-subtle`
- Current step number: keep `text-amber-500`

### 8. [ui] Appearance control on Settings

File: `src/screens/Settings.tsx`

- Add an Appearance block above Backup (password stays first).
- Two-option control: Dark / Light. Selected option uses `bg-ink text-page`; the other is outline (`border-line-strong text-ink-muted`).
- Local state initialized from `settings.getTheme()`.
- On click: `settings.setTheme(next)` then `applyTheme(next)` and set local state. No Context.

Optional tiny helper `src/lib/useTheme.ts` is allowed only if Settings would otherwise duplicate more than ~10 lines. Prefer calling settings + `applyTheme` directly.

## Out of scope

- System theme follow
- Per-recipe or scheduled themes
- Changing recipe/chat/photo data
- New npm packages (`next-themes`, etc.)
- E2E / Playwright

## Verification

- `npm test` (new theme/settings cases + existing lib tests)
- `npm run build`
- Manual: cold load with empty `localStorage` is dark with no cream flash; Settings → Light restyles every route (Library, recipe view, edit, import, chat sheet, settings); reload stays light; Settings → Dark returns to dark; iOS/PWA status bar color tracks the choice
