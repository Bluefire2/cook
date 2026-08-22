import { useRef, useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import { encodeImageForStorage } from '../lib/image';
import { photoStore, useObjectUrl, usePhotoUrl } from '../lib/photoStore';
import { blankDraft } from '../lib/recipeDraft';
import type { Ingredient, IngredientSection, RecipeDraft } from '../lib/types';

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

const inputClass =
  'w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 shadow-sm outline-none focus:border-stone-400';
const cellClass =
  'min-w-0 rounded-lg border border-stone-200 px-2 py-1.5 outline-none focus:border-stone-400';
const iconButtonClass =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-stone-500 active:bg-stone-100 disabled:opacity-30';
const addButtonClass =
  'mt-2 rounded-full border border-stone-300 px-3 py-1.5 text-sm text-stone-600 active:bg-stone-100';

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="mt-3 block">
      <span className="text-sm font-medium text-stone-600">{label}</span>
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
      <span className="text-sm font-medium text-stone-600">Photo</span>
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
          className={`block ${addButtonClass}`}
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
              className="rounded-full border border-stone-300 px-3 py-1.5 text-sm text-stone-600 active:bg-stone-100"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="rounded-full border border-stone-300 px-3 py-1.5 text-sm text-stone-600 active:bg-stone-100"
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
}: {
  /** Starting values. Use a blank draft for create-from-scratch. */
  initial: RecipeDraft;
  /** Label for the primary button, e.g. 'Save' or 'Save to library'. */
  submitLabel: string;
  onSubmit: (draft: RecipeDraft) => void | Promise<void>;
  onCancel: () => void;
}): ReactElement {
  const [form, setForm] = useState(() => fromDraft(initial));
  const [photoId, setPhotoId] = useState(initial.photoId);
  const [picked, setPicked] = useState<File>();
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const moveItem = (sectionIndex: number, from: number, to: number) =>
    patchSection(sectionIndex, (section) => ({
      ...section,
      items: moved(section.items, from, to),
    }));

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
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        // Enter in any of these one-line fields would submit the whole recipe;
        // saving is explicit and only the button does it.
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
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
        <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">
          {photoError}
        </p>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2">
        <label className="block">
          <span className="text-sm font-medium text-stone-600">Servings</span>
          <input
            type="text"
            inputMode="numeric"
            value={form.servings}
            onChange={(e) => patch({ servings: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-stone-600">Prep min</span>
          <input
            type="text"
            inputMode="numeric"
            value={form.prepMinutes}
            onChange={(e) => patch({ prepMinutes: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-stone-600">Cook min</span>
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
                  onClick={() =>
                    patchSections((sections) =>
                      sections.filter((_, i) => i !== si),
                    )
                  }
                  className={iconButtonClass}
                >
                  ✕
                </button>
              </div>
            )}

            <ul className="mt-2 flex flex-col gap-2">
              {section.items.map((item, ii) => (
                <li
                  key={ii}
                  className="rounded-xl border border-stone-200 bg-white p-2 shadow-sm"
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
                    <input
                      type="text"
                      aria-label="Unit"
                      value={item.unit}
                      onChange={(e) =>
                        patchItem(si, ii, { unit: e.target.value })
                      }
                      placeholder="cup"
                      className={`w-16 ${cellClass}`}
                    />
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
                      className={iconButtonClass}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label="Move ingredient down"
                      disabled={ii === section.items.length - 1}
                      onClick={() => moveItem(si, ii, ii + 1)}
                      className={iconButtonClass}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label="Remove ingredient"
                      onClick={() =>
                        patchSection(si, (s) => ({
                          ...s,
                          items: s.items.filter((_, i) => i !== ii),
                        }))
                      }
                      className={iconButtonClass}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={() =>
                patchSection(si, (s) => ({ ...s, items: [...s.items, blankItem()] }))
              }
              className={addButtonClass}
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
          className={addButtonClass}
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
              className="rounded-xl border border-stone-200 bg-white p-2 shadow-sm"
            >
              <div className="flex items-center justify-between">
                <span className="pl-1 text-sm font-semibold text-stone-400">
                  {i + 1}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-label={`Move step ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => patchSteps((steps) => moved(steps, i, i - 1))}
                    className={iconButtonClass}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move step ${i + 1} down`}
                    disabled={i === form.steps.length - 1}
                    onClick={() => patchSteps((steps) => moved(steps, i, i + 1))}
                    className={iconButtonClass}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove step ${i + 1}`}
                    onClick={() =>
                      patchSteps((steps) => steps.filter((_, j) => j !== i))
                    }
                    className={iconButtonClass}
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
          className={addButtonClass}
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
          className="flex-1 rounded-full border border-stone-300 py-3 font-medium text-stone-600"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex-1 rounded-full bg-stone-800 py-3 font-medium text-white disabled:opacity-40"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
