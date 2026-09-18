import { useRef, useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import { encodeImageForStorage } from '../lib/image';
import { photoStore, useObjectUrl, usePhotoUrl } from '../lib/photoStore';
import { blankDraft } from '../lib/recipeDraft';
import type { Ingredient, IngredientSection, RecipeDraft } from '../lib/types';
import { COMMON_UNITS, CUSTOM_UNIT, resolveUnit, unitChoice, type UnitChoice } from '../lib/units';
import {
  addBtn,
  addBtnDanger,
  cellClass,
  iconBtn,
  inputClass,
  primaryBtn,
  secondaryBtn,
} from '../lib/uiClasses';

interface ItemFields {
  quantity: string;
  unit: string;
  item: string;
  note: string;
}

interface SectionFields {
  name: string;
  items: ItemFields[];
}

/**
 * Numbers live in state as raw strings so a half-typed or emptied field stays
 * exactly what the user typed; they only become numbers (or `undefined`) on
 * submit. Parsing on every keystroke is how an empty box turns into `NaN`.
 */
interface FormState {
  title: string;
  description: string;
  servings: string;
  prepMinutes: string;
  cookMinutes: string;
  tags: string;
  notes: string;
  sections: SectionFields[];
  steps: string[];
}

function numberText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function toNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fromDraft(draft: RecipeDraft): FormState {
  const fallback = blankDraft();
  const sections =
    draft.ingredientSections.length > 0
      ? draft.ingredientSections
      : fallback.ingredientSections;
  const steps = draft.steps.length > 0 ? draft.steps : fallback.steps;

  return {
    title: draft.title,
    description: draft.description ?? '',
    servings: numberText(draft.servings),
    prepMinutes: numberText(draft.prepMinutes),
    cookMinutes: numberText(draft.cookMinutes),
    tags: draft.tags.join(', '),
    notes: draft.notes ?? '',
    sections: sections.map((section) => ({
      name: section.name ?? '',
      items:
        section.items.length > 0
          ? section.items.map((item) => ({
              quantity: numberText(item.quantity),
              unit: item.unit ?? '',
              item: item.item,
              note: item.note ?? '',
            }))
          : [blankItem()],
    })),
    steps: steps.map((step) => step.text),
  };
}

function toIngredient(fields: ItemFields): Ingredient {
  const quantity = toNumber(fields.quantity);
  const unit = fields.unit.trim();
  const note = fields.note.trim();
  return {
    ...(quantity !== undefined ? { quantity } : {}),
    ...(unit !== '' ? { unit } : {}),
    item: fields.item.trim(),
    ...(note !== '' ? { note } : {}),
  };
}

function toSection(fields: SectionFields): IngredientSection {
  const name = fields.name.trim();
  return {
    ...(name !== '' ? { name } : {}),
    items: fields.items
      .filter((item) => item.item.trim() !== '')
      .map(toIngredient),
  };
}

function toTags(text: string): string[] {
  const tags = new Set<string>();
  for (const raw of text.split(',')) {
    const tag = raw.trim().toLowerCase();
    if (tag !== '') tags.add(tag);
  }
  return [...tags];
}

/**
 * Optional fields are spread in only when present, so clearing one drops the
 * key instead of storing `undefined` in a record that gets fully replaced.
 * `sourceUrl` is carried through untouched because the form has no UI for it;
 * `photoId` is passed in because it is only known once the blob is stored.
 */
function toDraft(
  form: FormState,
  initial: RecipeDraft,
  photoId: string | undefined,
): RecipeDraft {
  const description = form.description.trim();
  const notes = form.notes.trim();
  const prepMinutes = toNumber(form.prepMinutes);
  const cookMinutes = toNumber(form.cookMinutes);

  return {
    title: form.title.trim(),
    ...(description !== '' ? { description } : {}),
    ...(initial.sourceUrl !== undefined
      ? { sourceUrl: initial.sourceUrl }
      : {}),
    servings: Math.max(1, toNumber(form.servings) ?? 1),
    ...(prepMinutes !== undefined ? { prepMinutes } : {}),
    ...(cookMinutes !== undefined ? { cookMinutes } : {}),
    ingredientSections: form.sections
      .map(toSection)
      .filter((section) => section.items.length > 0),
    steps: form.steps
      .map((text) => text.trim())
      .filter((text) => text !== '')
      .map((text) => ({ text })),
    tags: toTags(form.tags),
    ...(notes !== '' ? { notes } : {}),
    ...(photoId !== undefined ? { photoId } : {}),
  };
}

function blankItem(): ItemFields {
  return { quantity: '', unit: '', item: '', note: '' };
}

function moved<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}

function unitKey(sectionIndex: number, itemIndex: number): string {
  return `${sectionIndex}-${itemIndex}`;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="mt-3 block">
      <span className="text-sm font-medium text-ink-muted">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function PhotoField({
  photoId,
  picked,
  onPick,
  onRemove,
}: {
  photoId: string | undefined;
  picked: File | undefined;
  onPick: (file: File) => void;
  onRemove: () => void;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const storedUrl = usePhotoUrl(picked ? undefined : photoId);
  const pickedUrl = useObjectUrl(picked);
  const url = pickedUrl ?? storedUrl;

  return (
    <div className="mt-3">
      <span className="text-sm font-medium text-ink-muted">Photo</span>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          e.target.value = '';
        }}
      />
      {url === undefined ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={`mt-2 block ${addBtn}`}
        >
          + Photo
        </button>
      ) : (
        <div className="mt-1">
          <img
            src={url}
            alt=""
            className="h-44 w-full rounded-xl object-cover shadow-sm"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className={addBtn}
            >
              Replace
            </button>
            <button
              type="button"
              onClick={onRemove}
              className={addBtnDanger}
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function RecipeForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  formId,
}: {
  /** Starting values. Use a blank draft for create-from-scratch. */
  initial: RecipeDraft;
  /** Label for the primary button, e.g. 'Save' or 'Save to library'. */
  submitLabel: string;
  onSubmit: (draft: RecipeDraft) => void | Promise<void>;
  onCancel: () => void;
  /** Sets the form's `id` so a `type="submit" form=…` button can live
   * outside the form (e.g. a second Save button up in the screen header). */
  formId?: string;
}): ReactElement {
  const [form, setForm] = useState(() => fromDraft(initial));
  const [photoId, setPhotoId] = useState(initial.photoId);
  const [picked, setPicked] = useState<File>();
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // resolveUnit(CUSTOM_UNIT, '') is undefined, so without this positional
  // "row is in custom mode" set, a custom row whose text is empty (or exactly
  // a listed unit) would snap back to — and hide the text field mid-typing.
  const [customUnits, setCustomUnits] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const patch = (fields: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...fields }));

  const patchSections = (next: (sections: SectionFields[]) => SectionFields[]) =>
    setForm((prev) => ({ ...prev, sections: next(prev.sections) }));

  const patchSection = (index: number, next: (s: SectionFields) => SectionFields) =>
    patchSections((sections) =>
      sections.map((section, i) => (i === index ? next(section) : section)),
    );

  const patchItem = (
    sectionIndex: number,
    itemIndex: number,
    fields: Partial<ItemFields>,
  ) =>
    patchSection(sectionIndex, (section) => ({
      ...section,
      items: section.items.map((item, i) =>
        i === itemIndex ? { ...item, ...fields } : item,
      ),
    }));

  // customUnits keys are positional, so every structural edit (move, remove
  // ingredient, remove section) must remap them exactly the way it moves the
  // rows — otherwise a Custom… row's state would jump to a neighbour. The
  // remap returns the key's new position, or null to drop it.
  const remapCustomUnits = (
    remap: (
      sectionIndex: number,
      itemIndex: number,
    ) => readonly [number, number] | null,
  ) =>
    setCustomUnits((prev) => {
      const next = new Set<string>();
      for (const key of prev) {
        const dash = key.indexOf('-');
        const mapped = remap(
          Number(key.slice(0, dash)),
          Number(key.slice(dash + 1)),
        );
        if (mapped !== null) next.add(unitKey(mapped[0], mapped[1]));
      }
      return next;
    });

  const moveItem = (sectionIndex: number, from: number, to: number) => {
    // moved() is bounds-guarded and only adjacent moves exist, so a real move
    // is exactly a swap; the positional custom-mode flags swap with it.
    if (to >= 0 && to < form.sections[sectionIndex].items.length) {
      remapCustomUnits((si, ii) => {
        if (si !== sectionIndex) return [si, ii];
        if (ii === from) return [si, to];
        if (ii === to) return [si, from];
        return [si, ii];
      });
    }
    patchSection(sectionIndex, (section) => ({
      ...section,
      items: moved(section.items, from, to),
    }));
  };

  const patchSteps = (next: (steps: string[]) => string[]) =>
    setForm((prev) => ({ ...prev, steps: next(prev.steps) }));

  // A lone unnamed section is the common case and needs no naming or removal
  // controls; they only appear once the recipe actually has sections.
  const showSectionChrome =
    form.sections.length > 1 || form.sections.some((s) => s.name.trim() !== '');

  const canSubmit = form.title.trim() !== '' && !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setPhotoError(null);
    try {
      // A draft can only carry an id, so a picked file has to become a row
      // before the caller sees it. Storing it here rather than on pick means
      // abandoning the form writes nothing at all.
      let stored: string | undefined;
      if (picked) {
        try {
          stored = await photoStore.add(await encodeImageForStorage(picked));
        } catch {
          setPhotoError("That photo couldn't be read — try a different one.");
          return;
        }
      }
      try {
        await onSubmit(toDraft(form, initial, stored ?? photoId));
      } catch (e) {
        // The recipe kept pointing at the old photo, so this one is already
        // unreachable; the store drops the old one only on a save that stuck.
        if (stored) await photoStore.remove(stored);
        throw e;
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      id={formId}
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        // Enter in any of these one-line fields would submit the whole recipe;
        // saving is explicit and only the button does it.
        if (
          e.key === 'Enter' &&
          (e.target instanceof HTMLInputElement ||
            e.target instanceof HTMLSelectElement)
        ) {
          e.preventDefault();
        }
      }}
    >
      <Field label="Title">
        <input
          type="text"
          value={form.title}
          onChange={(e) => patch({ title: e.target.value })}
          placeholder="Weeknight ragù"
          className={inputClass}
        />
      </Field>

      <Field label="Description">
        <textarea
          value={form.description}
          onChange={(e) => patch({ description: e.target.value })}
          rows={2}
          placeholder="A short line about the dish"
          className={inputClass}
        />
      </Field>

      <PhotoField
        photoId={photoId}
        picked={picked}
        onPick={(file) => {
          setPhotoError(null);
          setPicked(file);
        }}
        onRemove={() => {
          setPicked(undefined);
          setPhotoId(undefined);
        }}
      />
      {photoError && (
        <p className="mt-2 rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">
          {photoError}
        </p>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2">
        <label className="block">
          <span className="text-sm font-medium text-ink-muted">Servings</span>
          <input
            type="text"
            inputMode="numeric"
            value={form.servings}
            onChange={(e) => patch({ servings: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-muted">Prep min</span>
          <input
            type="text"
            inputMode="numeric"
            value={form.prepMinutes}
            onChange={(e) => patch({ prepMinutes: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-muted">Cook min</span>
          <input
            type="text"
            inputMode="numeric"
            value={form.cookMinutes}
            onChange={(e) => patch({ cookMinutes: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
      </div>

      <Field label="Tags">
        <input
          type="text"
          value={form.tags}
          onChange={(e) => patch({ tags: e.target.value })}
          placeholder="pasta, weeknight"
          className={inputClass}
        />
      </Field>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Ingredients</h2>
        {form.sections.map((section, si) => (
          <div key={si} className="mt-3">
            {showSectionChrome && (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  aria-label={`Section ${si + 1} name`}
                  value={section.name}
                  onChange={(e) =>
                    patchSection(si, (s) => ({ ...s, name: e.target.value }))
                  }
                  placeholder="Section name"
                  className={`flex-1 ${inputClass}`}
                />
                <button
                  type="button"
                  aria-label={`Remove section ${si + 1}`}
                  onClick={() => {
                    patchSections((sections) =>
                      sections.filter((_, i) => i !== si),
                    );
                    remapCustomUnits((s, i) => {
                      if (s === si) return null;
                      return [s > si ? s - 1 : s, i];
                    });
                  }}
                  className={iconBtn}
                >
                  ✕
                </button>
              </div>
            )}

            <ul className="mt-2 flex flex-col gap-2">
              {section.items.map((item, ii) => {
                const key = unitKey(si, ii);
                const choice = customUnits.has(key)
                  ? CUSTOM_UNIT
                  : unitChoice(item.unit);
                return (
                  <li
                    key={ii}
                    className="rounded-xl border border-line bg-surface p-2 shadow-sm"
                  >
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        inputMode="decimal"
                        aria-label="Quantity"
                        value={item.quantity}
                        onChange={(e) =>
                          patchItem(si, ii, { quantity: e.target.value })
                        }
                        placeholder="1"
                        className={`w-14 ${cellClass}`}
                      />
                      <select
                        aria-label="Unit"
                        value={choice}
                        onChange={(e) => {
                          const next = e.target.value as UnitChoice;
                          // One uniform call: — clears, a listed unit writes
                          // itself, Custom… carries the current text through.
                          patchItem(si, ii, {
                            unit: resolveUnit(next, item.unit) ?? '',
                          });
                          setCustomUnits((prev) => {
                            const updated = new Set(prev);
                            if (next === CUSTOM_UNIT) {
                              updated.add(key);
                            } else {
                              updated.delete(key);
                            }
                            return updated;
                          });
                        }}
                        className={`w-24 ${cellClass} bg-surface text-ink`}
                      >
                        <option value="">—</option>
                        {COMMON_UNITS.map((u) => (
                          <option key={u} value={u}>
                            {u}
                          </option>
                        ))}
                        <option value={CUSTOM_UNIT}>Custom…</option>
                      </select>
                      <input
                        type="text"
                        aria-label="Ingredient"
                        value={item.item}
                        onChange={(e) =>
                          patchItem(si, ii, { item: e.target.value })
                        }
                        placeholder="flour"
                        className={`flex-1 ${cellClass}`}
                      />
                    </div>
                    {choice === CUSTOM_UNIT && (
                      <div className="mt-1.5 flex gap-1.5">
                        <input
                          type="text"
                          aria-label="Custom unit"
                          placeholder="unit"
                          value={item.unit}
                          onChange={(e) => {
                            // Raw value, untrimmed — trimming per keystroke
                            // makes a space impossible to type; toIngredient
                            // trims on submit. Pinning the key keeps a
                            // resolver-entered custom row (e.g. a stored
                            // 'knob') in custom mode when an edit makes the
                            // text empty or exactly a listed unit.
                            patchItem(si, ii, { unit: e.target.value });
                            setCustomUnits((prev) => {
                              const updated = new Set(prev);
                              updated.add(key);
                              return updated;
                            });
                          }}
                          className={`w-24 ${cellClass}`}
                        />
                      </div>
                    )}
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <input
                        type="text"
                        aria-label="Ingredient note"
                        value={item.note}
                        onChange={(e) =>
                          patchItem(si, ii, { note: e.target.value })
                        }
                        placeholder="note, e.g. finely chopped"
                        className={`flex-1 text-sm ${cellClass}`}
                      />
                      <button
                        type="button"
                        aria-label="Move ingredient up"
                        disabled={ii === 0}
                        onClick={() => moveItem(si, ii, ii - 1)}
                        className={iconBtn}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label="Move ingredient down"
                        disabled={ii === section.items.length - 1}
                        onClick={() => moveItem(si, ii, ii + 1)}
                        className={iconBtn}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        aria-label="Remove ingredient"
                        onClick={() => {
                          patchSection(si, (s) => ({
                            ...s,
                            items: s.items.filter((_, i) => i !== ii),
                          }));
                          remapCustomUnits((s, i) => {
                            if (s !== si || i < ii) return [s, i];
                            if (i === ii) return null;
                            return [s, i - 1];
                          });
                        }}
                        className={iconBtn}
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>

            <button
              type="button"
              onClick={() =>
                patchSection(si, (s) => ({ ...s, items: [...s.items, blankItem()] }))
              }
              className={`mt-2 block ${addBtn}`}
            >
              + Ingredient
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={() =>
            patchSections((sections) => [
              ...sections,
              { name: '', items: [blankItem()] },
            ])
          }
          className={`mt-2 block ${addBtn}`}
        >
          + Section
        </button>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Steps</h2>
        <ol className="mt-2 flex flex-col gap-2">
          {form.steps.map((text, i) => (
            <li
              key={i}
              className="rounded-xl border border-line bg-surface p-2 shadow-sm"
            >
              <div className="flex items-center justify-between">
                <span className="pl-1 text-sm font-semibold text-ink-subtle">
                  {i + 1}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-label={`Move step ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => patchSteps((steps) => moved(steps, i, i - 1))}
                    className={iconBtn}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move step ${i + 1} down`}
                    disabled={i === form.steps.length - 1}
                    onClick={() => patchSteps((steps) => moved(steps, i, i + 1))}
                    className={iconBtn}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove step ${i + 1}`}
                    onClick={() =>
                      patchSteps((steps) => steps.filter((_, j) => j !== i))
                    }
                    className={iconBtn}
                  >
                    ✕
                  </button>
                </div>
              </div>
              <textarea
                aria-label={`Step ${i + 1}`}
                value={text}
                onChange={(e) =>
                  patchSteps((steps) =>
                    steps.map((s, j) => (j === i ? e.target.value : s)),
                  )
                }
                rows={2}
                placeholder="What to do"
                className={`mt-1 w-full ${cellClass}`}
              />
            </li>
          ))}
        </ol>
        <button
          type="button"
          onClick={() => patchSteps((steps) => [...steps, ''])}
          className={`mt-2 block ${addBtn}`}
        >
          + Step
        </button>
      </section>

      <Field label="Notes">
        <textarea
          value={form.notes}
          onChange={(e) => patch({ notes: e.target.value })}
          rows={3}
          placeholder="Anything worth remembering next time"
          className={inputClass}
        />
      </Field>

      <div className="mt-6 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={`${secondaryBtn} flex-1 py-3`}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className={`${primaryBtn} flex-1 py-3`}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
