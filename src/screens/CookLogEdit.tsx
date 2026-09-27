import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import PhotoPickerField from '../components/PhotoPickerField';
import Sheet from '../components/Sheet';
import {
  MAX_COOK_LOG_PHOTOS,
  MAX_COOK_LOG_SERVINGS,
  MAX_COOK_LOG_TEXT,
  isCookedOn,
  todayCookedOn,
} from '../lib/cookLogShape';
import { cookLogStore, useCookLog } from '../lib/cookLogStore';
import { encodeImageForStorage } from '../lib/image';
import { photoStore } from '../lib/photoStore';
import { useRecipe } from '../lib/recipeStore';
import type { CookLog, Recipe } from '../lib/types';
import {
  backLink,
  dangerBtn,
  inputClass,
  primaryBtn,
  secondaryBtn,
} from '../lib/uiClasses';
import { useCookState } from '../lib/useCookState';

const PHOTO_UNREADABLE = "That photo couldn't be read — it may not be a real image.";
const SERVINGS_INVALID = `Servings must be a number above 0, up to ${MAX_COOK_LOG_SERVINGS}.`;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mt-3 block">
      <span className="text-sm font-medium text-ink-muted">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function StarRating({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  return (
    <div className="mt-3">
      <span id="cook-rating-label" className="text-sm font-medium text-ink-muted">
        Rating
      </span>
      <div role="group" aria-labelledby="cook-rating-label" className="mt-1 flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => {
          const filled = value !== undefined && n <= value;
          return (
            <button
              key={n}
              type="button"
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              aria-pressed={value === n}
              onClick={() => onChange(value === n ? undefined : n)}
              className={`flex h-11 w-11 items-center justify-center rounded-full text-2xl hover:bg-surface-muted active:bg-surface-muted ${
                filled ? 'text-amber-500' : 'text-ink-subtle'
              }`}
            >
              {filled ? '★' : '☆'}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function parseServings(text: string): number | undefined | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_COOK_LOG_SERVINGS) {
    return 'invalid';
  }
  return parsed;
}

function CookLogForm({
  recipe,
  log,
  initialServings,
  onRemovingChange,
}: {
  recipe: Recipe;
  /** Absent for a new entry. */
  log: CookLog | undefined;
  initialServings: number;
  onRemovingChange: (removing: boolean) => void;
}) {
  const navigate = useNavigate();
  const recipeHref = `/recipe/${recipe.id}`;
  const [cookedOn, setCookedOn] = useState(() => log?.cookedOn ?? todayCookedOn());
  const [rating, setRating] = useState(log?.rating);
  const [servingsText, setServingsText] = useState(() =>
    log ? (log.servings === undefined ? '' : String(log.servings)) : String(initialServings),
  );
  const [notes, setNotes] = useState(log?.notes ?? '');
  const [lessons, setLessons] = useState(log?.lessons ?? '');
  const [photoIds, setPhotoIds] = useState(() => log?.photoIds ?? []);
  const [picked, setPicked] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const canSubmit = isCookedOn(cookedOn) && !busy && !deleteBusy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    const servings = parseServings(servingsText);
    if (servings === 'invalid') {
      setError(SERVINGS_INVALID);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Decode every selection before registering photos, so an unreadable
      // file leaves nothing to clean up locally or on the server.
      const encoded: Blob[] = [];
      try {
        for (const file of picked) {
          encoded.push(await encodeImageForStorage(file));
        }
      } catch {
        setError(PHOTO_UNREADABLE);
        return;
      }
      const added: string[] = [];
      try {
        for (const blob of encoded) {
          added.push(await photoStore.add(blob));
        }
        const fields = {
          cookedOn,
          rating,
          servings,
          notes,
          lessons,
          photoIds: [...photoIds, ...added],
        };
        if (log) {
          await cookLogStore.save({
            ...fields,
            id: log.id,
            recipeId: log.recipeId,
            createdAt: log.createdAt,
            updatedAt: log.updatedAt,
          });
        } else {
          await cookLogStore.create({ ...fields, recipeId: recipe.id });
        }
      } catch (err) {
        // The entry kept pointing at its old photos, so these new ids are
        // already unreachable.
        for (const id of added) await photoStore.remove(id);
        setError(err instanceof Error ? err.message : "Couldn't save the cook log.");
        return;
      }
      navigate(recipeHref, { replace: true });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!log) return;
    setDeleteBusy(true);
    setDeleteError(null);
    onRemovingChange(true);
    try {
      await cookLogStore.remove(log.id);
      navigate(recipeHref, { replace: true });
    } catch (err) {
      onRemovingChange(false);
      setDeleteError(err instanceof Error ? err.message : "Couldn't delete the cook log.");
      setDeleteBusy(false);
    }
  };

  return (
    <>
      <form
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => {
          // Saving is explicit; Enter in a one-line field would submit the entry.
          if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
            e.preventDefault();
          }
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <Field label="Date">
            <input
              type="date"
              required
              value={cookedOn}
              onChange={(e) => setCookedOn(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Servings">
            <input
              type="text"
              inputMode="decimal"
              value={servingsText}
              onChange={(e) => setServingsText(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <StarRating value={rating} onChange={setRating} />

        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={MAX_COOK_LOG_TEXT}
            placeholder="How it went, what you swapped or changed"
            className={inputClass}
          />
        </Field>

        <Field label="Lessons">
          <textarea
            value={lessons}
            onChange={(e) => setLessons(e.target.value)}
            rows={3}
            maxLength={MAX_COOK_LOG_TEXT}
            placeholder="What to do differently next time"
            className={inputClass}
          />
        </Field>

        <PhotoPickerField
          label="Photos"
          max={MAX_COOK_LOG_PHOTOS}
          photoIds={photoIds}
          picked={picked}
          onPick={(files) => {
            setError(null);
            setPicked((prev) => {
              const room = MAX_COOK_LOG_PHOTOS - photoIds.length - prev.length;
              return room <= 0 ? prev : [...prev, ...files.slice(0, room)];
            });
          }}
          onRemoveStored={(id) => setPhotoIds((prev) => prev.filter((item) => item !== id))}
          onRemovePicked={(index) => setPicked((prev) => prev.filter((_, i) => i !== index))}
        />

        {error && (
          <p role="alert" className="mt-4 rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="mt-6 flex gap-2">
          <button
            type="button"
            onClick={() => navigate(recipeHref)}
            className={`${secondaryBtn} flex-1 py-3`}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={`${primaryBtn} flex-1 py-3`}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>

        {log && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDeleteError(null);
              setConfirmingDelete(true);
            }}
            className="mt-3 w-full py-2.5 text-sm text-danger hover:text-ink disabled:opacity-40"
          >
            Delete cook
          </button>
        )}
      </form>

      {confirmingDelete && (
        <Sheet onClose={() => setConfirmingDelete(false)} dismissible={!deleteBusy}>
          <h2 className="text-lg font-semibold">Delete this cook?</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Its notes and photos are deleted too. There is no undo.
          </p>
          {deleteError && <p role="alert" className="mt-2 text-sm text-danger">{deleteError}</p>}
          <button
            type="button"
            disabled={deleteBusy}
            onClick={() => void confirmDelete()}
            className={`${dangerBtn} mt-3 w-full py-3 disabled:opacity-40`}
          >
            Delete
          </button>
          <button
            type="button"
            disabled={deleteBusy}
            onClick={() => setConfirmingDelete(false)}
            className={`${secondaryBtn} mt-2 w-full py-3`}
          >
            Cancel
          </button>
        </Sheet>
      )}
    </>
  );
}

export default function CookLogEdit() {
  const { id, logId } = useParams<{ id: string; logId: string }>();
  const recipe = useRecipe(id);
  const log = useCookLog(logId);
  const { servings } = useCookState(recipe);
  const [removing, setRemoving] = useState(false);
  // While a delete is in flight the entry is already gone from memory; the
  // form stays mounted on the last copy so a failed delete can show its error.
  const [lastLog, setLastLog] = useState<CookLog | null>(null);
  if (log && log !== lastLog) setLastLog(log);

  if (recipe === undefined || log === undefined) {
    return <div className="p-6 text-center text-ink-muted">Loading recipe…</div>;
  }
  if (recipe === null) {
    return (
      <div className="p-6 text-center text-ink-muted">
        Recipe not found.{' '}
        <Link to="/" className="underline hover:text-ink">
          Back to library
        </Link>
      </div>
    );
  }

  const isNew = logId === undefined;
  const entry = isNew ? undefined : (log ?? (removing ? lastLog : null));
  if (entry === null || (entry !== undefined && entry.recipeId !== recipe.id)) {
    return (
      <div className="p-6 text-center text-ink-muted">
        Cook not found.{' '}
        <Link to={`/recipe/${recipe.id}`} className="underline hover:text-ink">
          Back to recipe
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to={`/recipe/${recipe.id}`} className={backLink}>
          &larr; Recipe
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{isNew ? 'Log a cook' : 'Edit cook'}</h1>
        <p className="mt-1 text-ink-muted">{recipe.title}</p>
      </header>
      <CookLogForm
        key={logId ?? 'new'}
        recipe={recipe}
        log={entry}
        initialServings={servings}
        onRemovingChange={setRemoving}
      />
    </div>
  );
}
