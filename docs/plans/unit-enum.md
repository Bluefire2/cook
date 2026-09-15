# Unit enum with custom option + honest empty state

## Goal

Replace the freeform unit text input in the recipe form with a native `<select>` offering an explicit "no unit" option, ten canonical units (including `piece`), and a `Custom…` escape hatch that reveals a small text field. Nudge the Gemini prompts toward the same canonical units. Storage stays `unit?: string` — the enum is a UI concern only, so there is no migration and no data loss for off-list values already stored.

Requirements baseline: the user-approved UX plan `unit_enum_with_custom_option_db4325d3`. Its decisions are confirmed and must not be reopened:

- Control is a native `<select>`: `—` (no unit), the ten common units, `Custom…`.
- Both empty-state fixes ship: `piece` joins the list **and** the misleading `placeholder="cup"` is replaced by the select's explicit `—` option.

## Assumptions

- `Ingredient.unit` stays `unit?: string` in `src/lib/types.ts`. No change to `src/lib/recipeShape.ts`, `src/lib/backup.ts`, or `src/screens/RecipeView.tsx`.
- `RecipeForm` is the only unit editor in the app. It is mounted by `src/screens/RecipeEdit.tsx` (new + edit) and by `src/screens/ImportScreen.tsx` (import preview), so one change covers all three entry points. Neither caller passes a `key`, and `ImportScreen` mounts/unmounts the form around `preview`, so no caller depends on unit-specific form internals.
- `RecipeForm` keeps units in form state as `ItemFields.unit: string` (never `undefined`); `toIngredient` already trims it and drops the key when empty (`src/components/RecipeForm.tsx` lines 89–99). That trim-on-submit stays the single normalization point — the custom text input must **not** trim per keystroke (see Edge cases).
- Ingredient rows are keyed positionally (`key={ii}`, `key={si}`) and reorder via `moved()`, which mutates the array while React keeps DOM by position. Custom-mode UI state is therefore positional too, per the confirmed decision.
- `tsconfig.app.json` has `include: ["src"]`, `strict`, `noUnusedLocals`, `noUnusedParameters`, and `verbatimModuleSyntax`. So `npm run build` (`tsc -b && vite build`) type-checks the new test file too, and type-only imports must use `import type`.
- Vitest has no config block in `vite.config.ts` — defaults apply, and the new test must be pure logic with no DOM/`localStorage` dependency (consistent with `src/lib/quantity.test.ts`).
- No lint script exists; `npm test` and `npm run build` are the full gate.
- The Gemini `RECIPE_SCHEMA` is duplicated verbatim in `api/chat.ts` and `api/import.ts` (both at lines 6–55, unit description at line 28) with a "Keep both copies in sync" comment. `unit` stays `Type.STRING`; only the `description` string changes.

## Open Questions

None blocking. Recorded judgement calls, each already decided in this plan so implementation is not blocked:

- The `—` option label is the bare em dash (U+2014), matching the confirmed decision literally. A screen reader may announce it as nothing or "em dash"; the `aria-label="Unit"` on the select still identifies the control. If the user later wants it spoken, `— no unit` is a one-token change (but it widens the select).
- Picking `Custom…` while a listed unit is selected carries that unit into the custom box (e.g. `cup`, editable to `cups`) rather than clearing it. This falls out of the uniform `resolveUnit` call in step 2 with no special case; clearing instead would need an extra branch.
- `unitChoice` matches the stored string exactly: no case folding, no trimming. `Cup` and ` cup ` therefore open as `Custom…` with the value intact (no data loss), and saving trims. Case folding was rejected because it would silently rewrite stored casing on save.

## Files to change

| File | Change |
|---|---|
| `src/lib/units.ts` | New. Canonical unit list, custom sentinel, two pure resolvers. |
| `src/components/RecipeForm.tsx` | Unit text input (lines 482–491) becomes select + conditional custom input; positional custom-mode state; Enter-key guard extended to `<select>`. |
| `api/chat.ts` | `unit` description text only (line 28). |
| `api/import.ts` | Byte-identical copy of the same change. |
| `src/lib/units.test.ts` | New. Pure-logic coverage of the resolvers. |

Explicitly unchanged: `src/lib/types.ts`, `src/lib/recipeShape.ts`, `src/lib/backup.ts`, `src/screens/RecipeView.tsx`, `src/screens/ImportScreen.tsx`, `src/screens/RecipeEdit.tsx`, `src/lib/uiClasses.ts`.

## Steps

### 1. [core] New `src/lib/units.ts`

Create the module with exactly these exports and signatures:

```ts
export const COMMON_UNITS = [
  'piece',
  'tsp',
  'tbsp',
  'cup',
  'ml',
  'l',
  'g',
  'kg',
  'oz',
  'lb',
] as const;

export type CommonUnit = (typeof COMMON_UNITS)[number];

/** Sentinel select value for "off-list unit, typed by hand". */
export const CUSTOM_UNIT = '__custom__';

/** What the unit `<select>` is showing: no unit, a listed unit, or custom. */
export type UnitChoice = '' | CommonUnit | typeof CUSTOM_UNIT;

export function unitChoice(unit: string | undefined): UnitChoice;

export function resolveUnit(
  choice: UnitChoice,
  customText: string,
): string | undefined;
```

Order is count → volume → weight (as in the UX plan); do not re-sort.

`unitChoice(unit)` behaviour, exhaustively:

- `undefined` → `''`
- `''` → `''`
- a member of `COMMON_UNITS` (exact string match) → that member
- anything else non-empty (`'knob'`, `'Cup'`, `' cup '`, `'__custom__'`) → `CUSTOM_UNIT`

No trimming, no lowercasing. Implement the membership test in a way that type-narrows to `CommonUnit` (e.g. a `readonly string[]` widening or a small type guard) — `COMMON_UNITS.includes(unit)` on the `as const` tuple will not type-check against a `string`.

`resolveUnit(choice, customText)` behaviour, exhaustively:

- `choice === ''` → `undefined` (ignores `customText`)
- `choice === CUSTOM_UNIT` → `customText.trim()`, or `undefined` when that trims to `''`
- otherwise (a listed unit) → `choice` (ignores `customText`)

Keep the module pure: no React, no imports from other project modules. Add a short doc comment stating that storage is still a freeform string and this list is a UI affordance only — that is the fact a future reader will otherwise get wrong.

**Verification:** `npm run build` succeeds (module is not yet imported anywhere, so this only proves it type-checks; `noUnusedLocals` applies inside the file).

### 2. [ui] `src/components/RecipeForm.tsx`: select + conditional custom input

Replace the unit `<input>` at lines 482–491 (the one with `aria-label="Unit"`, `placeholder="cup"`, `className={`w-16 ${cellClass}`}`). `placeholder="cup"` is deleted, not moved.

**Imports.** Add `import { COMMON_UNITS, CUSTOM_UNIT, resolveUnit, unitChoice, type UnitChoice } from '../lib/units';` (`UnitChoice` is used in the `e.target.value as UnitChoice` cast, and `verbatimModuleSyntax` requires the inline `type` modifier — omitting it fails `npm run build`).

**Positional custom-mode state.** Add to the component body, next to the other `useState` calls:

- `const [customUnits, setCustomUnits] = useState<ReadonlySet<string>>(new Set());`
- A module-level `function unitKey(sectionIndex: number, itemIndex: number): string` returning `` `${sectionIndex}-${itemIndex}` ``.

Every update must build a **new** `Set` (never mutate state in place).

This state exists for one reason: `resolveUnit(CUSTOM_UNIT, '')` is `undefined`, so a row in custom mode with an empty or listed unit string would otherwise snap back to `—` and hide the text field mid-typing. Say so in a comment.

**Effective choice per row** (inside the `section.items.map((item, ii) => …)` body):

```
const key = unitKey(si, ii);
const choice = customUnits.has(key) ? CUSTOM_UNIT : unitChoice(item.unit);
```

So an off-list stored value (`'knob'`) opens in `Custom…` with no state entry required — the resolver alone handles reload.

**The select.** Replaces the old input in the same flex row, keeping `aria-label="Unit"`:

- `value={choice}`
- `onChange`: `const next = e.target.value as UnitChoice;` then
  - `patchItem(si, ii, { unit: resolveUnit(next, item.unit) ?? '' })` — one uniform call, no per-choice branch: `—` clears, a listed unit writes itself, `Custom…` carries the current text through (`'knob'` survives, `''` stays `''`).
  - update `customUnits`: add `key` when `next === CUSTOM_UNIT`, else remove it.
- Options, in this exact order, with these exact values and labels:

| value | label |
|---|---|
| `''` | `—` (U+2014 em dash) |
| each of `COMMON_UNITS` | the unit itself (`piece`, `tsp`, `tbsp`, `cup`, `ml`, `l`, `g`, `kg`, `oz`, `lb`) |
| `CUSTOM_UNIT` | `Custom…` (U+2026 horizontal ellipsis) |

Render the ten via `COMMON_UNITS.map(...)` with `key={u}` so the list stays single-sourced.

- Classes: `className={`w-24 ${cellClass} bg-surface text-ink`}`. `cellClass` (`src/lib/uiClasses.ts`) sets no background, and the surrounding `<li>` background does not paint a native select — hence the explicit `bg-surface text-ink`. `html.dark` already sets `color-scheme: dark`, so the native arrow follows the theme; do not add `appearance-none` (the arrow is the affordance that tells the user it is a dropdown).

**Row width.** First row becomes quantity `w-14` (unchanged) + unit select `w-24` + ingredient `flex-1`, keeping `flex gap-1.5`. `w-16` cannot fit `Custom…` plus the native arrow. Acceptance: at a 360px viewport there is no horizontal overflow and the ingredient field stays at least ~140px wide.

**The custom text input.** Rendered only when `choice === CUSTOM_UNIT`, in its own row between the first row and the existing note row, so the mobile row never holds four controls:

- Wrapper `<div className="mt-1.5 flex gap-1.5">`
- `<input type="text" aria-label="Custom unit" placeholder="unit" value={item.unit} className={`w-24 ${cellClass}`} />`
- The input's `onChange` does **two** things: `patchItem(si, ii, { unit: e.target.value })`, and adds `unitKey(si, ii)` to `customUnits` (building a new `Set`). The state add is mandatory, not optional: a row that entered custom mode purely via the resolver (a stored off-list value like `'knob'`, with no `customUnits` entry) would otherwise snap out of custom mode the moment an edit makes the text empty (`unitChoice('')` → `''`) or exactly a listed unit (`unitChoice('cup')` → `'cup'`), hiding the field mid-typing. Pinning the key on first edit keeps the row in custom mode until the user picks something else from the select.
- The raw `e.target.value` is written **untrimmed** — trimming per keystroke makes a space impossible to type, so a two-word unit could never be entered. `toIngredient` already trims on submit.
- Keep `aria-label="Unit"` on the select; the text field gets its own distinct `aria-label="Custom unit"` so the two controls are not ambiguous.

**Keep `customUnits` aligned with positions.** The keys are positional, so every structural mutation must move or prune them in the same way it moves items. Update these existing handlers:

- `moveItem(sectionIndex, from, to)`: swap membership of `unitKey(sectionIndex, from)` and `unitKey(sectionIndex, to)`. Guard with the same bounds check `moved()` uses (`to >= 0 && to < section.items.length`) so the flag does not move when the item did not — the ↑/↓ buttons are already `disabled` at the ends, and only adjacent moves exist, so an adjacent `moved()` is exactly a swap.
- Remove ingredient (the inline `items: s.items.filter((_, i) => i !== ii)` handler): drop `unitKey(si, ii)` and shift every `unitKey(si, j)` with `j > ii` down to `j - 1`.
- Remove section (the inline `sections.filter((_, i) => i !== si)` handler): drop all keys for section `si` and shift keys for sections `> si` down by one.
- `+ Ingredient` and `+ Section` append at the end, so no key can collide — no change needed.

Extract one small local helper for the remapping rather than inlining three `Set` rebuilds. Without this, a `Custom…` row with an empty box would visually jump to a neighbouring ingredient after a reorder or delete.

**Enter-key guard.** The form's `onKeyDown` (lines 344–350) only prevents default for `HTMLInputElement`, so Enter on a focused `<select>` can submit the recipe in some browsers. Extend the guard to also cover `HTMLSelectElement`.

**Verification:** `npm run build`. Manual, at a ~360px viewport:

1. New recipe: unit shows `—`, no `cup` ghost text anywhere; save with `—` and the ingredient stores no unit.
2. Pick `piece`, save, reopen — select shows `piece`.
3. Pick `Custom…` on an empty row: the text field appears and stays visible while empty; type `knob`, save, reopen the edit form — select shows `Custom…` and the box shows `knob`.
4. Open an existing recipe whose unit is off-list (seed one via edit + save if needed): `Custom…` is pre-selected with the value intact.
5. Put row 2 in `Custom…` with an empty box, press ↑, and confirm the custom box follows the row it belongs to.
6. Delete a row above a `Custom…` row and confirm the same.
7. Import preview (`/import`) shows the same control.
8. Enter pressed with the unit select focused does not submit the form.
9. Open an existing off-list unit (`knob`), edit the text to empty: the field stays visible and the select stays on `Custom…` while empty; save — the ingredient is stored with no `unit` key.
10. Open an existing off-list unit (`knob`), edit the text to exactly `cup`: the field stays visible mid-edit (no snap-out); save and reopen — the select now shows the listed `cup` (documented normalization on reload).
11. With an empty `Custom…` row in section 2, remove section 1: the custom box stays with its row (section-removal key remap).

### 3. [core] Nudge the unit description in both Gemini schemas

In `api/chat.ts` **and** `api/import.ts`, replace line 28:

```ts
                unit: { type: Type.STRING, description: 'e.g. g, tbsp, cup' },
```

with exactly this, byte-identical in both files (16-space indent on `unit:`, 18 on the members, 20 on the string):

```ts
                unit: {
                  type: Type.STRING,
                  description:
                    'Prefer one of: piece, tsp, tbsp, cup, ml, l, g, kg, oz, lb. Use "piece" for countable items when a unit reads naturally; omit the unit entirely for items counted without one. If none of these fit, use a short lowercase unit.',
                },
```

Constraints:

- `unit` stays `Type.STRING`. Do not add `enum`, `format`, or `required` entries — off-list values must remain expressible, and `recipeShape.ts` validation is untouched.
- Change nothing else in either schema, and do not touch the "Keep both copies in sync" comment.
- These are the only two occurrences of unit-related prompt text in `api/` (verified: no other file mentions unit/tbsp/measure).

**Verification:** both copies of the schema are still identical —

```
node --input-type=commonjs -e "const fs=require('fs');const re=/const RECIPE_SCHEMA[\s\S]*?\n};/;const g=p=>re.exec(fs.readFileSync(p,'utf8'))[0];console.log(g('api/chat.ts')===g('api/import.ts'))"
```

must print `true`. Then `npm run build`. Also eyeball `git diff -- api/chat.ts api/import.ts`: the two hunks must be character-for-character the same.

### 4. [core] New `src/lib/units.test.ts`

Pure vitest, `import { describe, expect, it } from 'vitest';` plus the module under test — same shape as `src/lib/quantity.test.ts`. No testing-library, no DOM, no `RecipeForm` import.

Cover:

- `COMMON_UNITS` is the exact ten in the exact documented order, and contains `piece`.
- `unitChoice(undefined)` and `unitChoice('')` are both `''`.
- `it.each` over `COMMON_UNITS`: `unitChoice(u) === u`.
- Off-list values map to `CUSTOM_UNIT`: `'knob'`, `'sprig'`, and — as documented no-normalization behaviour — `'Cup'` and `' cup '`.
- `unitChoice(CUSTOM_UNIT)` is `CUSTOM_UNIT` (the sentinel is not special-cased as a stored value; the text survives as custom).
- `resolveUnit('', 'knob')` is `undefined` (custom text ignored when no unit is chosen).
- `resolveUnit('cup', 'knob')` is `'cup'` (listed choice wins over stale text).
- `resolveUnit(CUSTOM_UNIT, 'knob')` is `'knob'`; `resolveUnit(CUSTOM_UNIT, '  knob  ')` is `'knob'`.
- `resolveUnit(CUSTOM_UNIT, '')` and `resolveUnit(CUSTOM_UNIT, '   ')` are `undefined` — the "custom text emptied" case.
- Round-trip: for each `COMMON_UNITS` member, `resolveUnit(unitChoice(u), u) === u`; for `'knob'`, `resolveUnit(unitChoice('knob'), 'knob') === 'knob'`; for `undefined`, `resolveUnit(unitChoice(undefined), '') === undefined`.
- Round-trip normalizes a custom value that happens to be listed: `resolveUnit(CUSTOM_UNIT, 'cup')` is `'cup'`, and `unitChoice('cup')` is then `'cup'` (next open shows the listed option, not `Custom…`).

**Verification:** `npm test` (all suites green, including the seven pre-existing ones) and `npm run build`.

## Edge cases this plan must satisfy

| Case | Expected behaviour | Where handled |
|---|---|---|
| Existing recipe with off-list unit (`knob`) | Edit form opens with `Custom…` selected and `knob` in the text box; saving without touching it rewrites `knob` unchanged | `unitChoice` → `CUSTOM_UNIT` (step 1), derived `choice` (step 2) |
| `Custom…` picked while unit is empty | Text field appears and stays visible; select keeps showing `Custom…` | `customUnits` positional set (step 2) |
| Custom text emptied to `''` (incl. a stored off-list value edited to empty) | Field stays visible and focused, select stays on `Custom…`, saved ingredient has no `unit` key | Custom input `onChange` pins the row's key in `customUnits` on every edit; `toIngredient` drops the empty string |
| Typing a multi-word custom unit | A space is typeable; only leading/trailing space is dropped, at submit | Untrimmed `onChange`, trim in `toIngredient` (step 2) |
| Reorder / delete with positional keys | The `Custom…` row's state follows its row, not its old index | `customUnits` remap in `moveItem` / remove-item / remove-section (step 2) |
| `—` chosen on a row that had a unit | `item.unit` becomes `''`; ingredient saves with no `unit` key | `resolveUnit('', …) → undefined`, coerced with `?? ''` |
| Import preview editor | Identical control, since `ImportScreen` renders the same `RecipeForm` | No `ImportScreen` change |
| Backup restore of a pre-change library | Unchanged: strings load, off-list ones show as `Custom…` | `types.ts`/`backup.ts` untouched |

## Risks

- **Prompt-copy drift.** The two `api/` schemas are edited by hand. The scripted identity check in step 3 is the guard; do not skip it.
- **Positional custom-mode state.** The remap bookkeeping in step 2 is the most error-prone part of the change and is not covered by tests (component tests are out of scope), so manual checks 5 and 6 are mandatory.
- **Native select styling.** Mobile Safari/Chrome render `<select>` height differently from `<input>` at the same padding, so the ingredient row may look uneven; adjust classes on the select only, never `cellClass` in `uiClasses.ts` (shared with every other row control).
- **Mobile row density.** `w-24` plus the extra custom row is the layout budget; if the ingredient field ends up cramped at 360px, shrink the custom input rather than the ingredient field.
- **Type narrowing on an `as const` tuple.** `COMMON_UNITS.includes(someString)` does not type-check; a careless fix (casting the tuple to `string[]`) loses `CommonUnit` in `UnitChoice`. Use a type guard.
- **`e.target.value as UnitChoice`.** The cast is safe only because every rendered option value is a `UnitChoice`; if options are ever generated elsewhere, that invariant breaks.

## Out of scope

Data migration, `recipeShape.ts` validation, `backup.ts`, `RecipeView.tsx` rendering, the Gemini schema *shape* (unit stays `Type.STRING`), unit conversion or scaling, component-level tests, and new dependencies.

## Status

- [x] 1. [core] `src/lib/units.ts` — `COMMON_UNITS`, `CommonUnit`, `CUSTOM_UNIT`, `UnitChoice`, `unitChoice`, `resolveUnit`
- [x] 2. [ui] `src/components/RecipeForm.tsx` — unit select + conditional custom input, positional custom-mode state and remapping, row widths, Enter guard, `placeholder="cup"` removed
- [x] 3. [core] `api/chat.ts` + `api/import.ts` — byte-identical unit description nudge, schema shape unchanged
- [x] 4. [core] `src/lib/units.test.ts` — resolver cases and round-trips; `npm test` and `npm run build` green
