import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useT } from '../i18n';
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
import { recipeStore, useRecipe } from '../lib/recipeStore';
import type { CookLog, Recipe } from '../lib/types';
import {
  backLink,
  dangerBtn,
  inputClass,
  primaryBtn,
  secondaryBtn,
} from '../lib/uiClasses';
import { useCookState } from '../lib/useCookState';

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
  const t = useT();
  return (
    <div className="mt-3">
      <span id="cook-rating-label" className="text-sm font-medium text-ink-muted">
        {t('cookLog.rating')}
      </span>
      <div role="group" aria-labelledby="cook-rating-label" className="mt-1 flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => {
          const filled = value !== undefined && n <= value;
          return (
            <button
              key={n}
              type="button"
              aria-label={t('cookLog.stars', { count: n })}
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
  const t = useT();
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
      setError(t('cookLog.servingsInvalid', { max: MAX_COOK_LOG_SERVINGS }));
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
        setError(t('error.photoUnreadable'));
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
        setError(err instanceof Error ? err.message : t('error.cookLogSave'));
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
      setDeleteError(err instanceof Error ? err.message : t('error.cookLogDelete'));
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
          <Field label={t('cookLog.date')}>
            <input
              type="date"
              required
              value={cookedOn}
              onChange={(e) => setCookedOn(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label={t('common.servings')}>
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

        <Field label={t('common.notes')}>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={MAX_COOK_LOG_TEXT}
            placeholder={t('cookLog.notesPlaceholder')}
            className={inputClass}
          />
        </Field>

        <Field label={t('cookLog.lessons')}>
          <textarea
            value={lessons}
            onChange={(e) => setLessons(e.target.value)}
            rows={3}
            maxLength={MAX_COOK_LOG_TEXT}
            placeholder={t('cookLog.lessonsPlaceholder')}
            className={inputClass}
          />
        </Field>

        <PhotoPickerField
          label={t('cookLog.photos')}
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
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={`${primaryBtn} flex-1 py-3`}
          >
            {busy ? t('common.saving') : t('common.save')}
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
            {t('cookLog.deleteCook')}
          </button>
        )}
      </form>

      {confirmingDelete && (
        <Sheet onClose={() => setConfirmingDelete(false)} dismissible={!deleteBusy}>
          <h2 className="text-lg font-semibold">{t('cookLog.deleteTitle')}</h2>
          <p className="mt-1 text-sm text-ink-muted">
            {t('cookLog.deleteBody')}
          </p>
          {deleteError && <p role="alert" className="mt-2 text-sm text-danger">{deleteError}</p>}
          <button
            type="button"
            disabled={deleteBusy}
            onClick={() => void confirmDelete()}
            className={`${dangerBtn} mt-3 w-full py-3 disabled:opacity-40`}
          >
            {t('common.delete')}
          </button>
          <button
            type="button"
            disabled={deleteBusy}
            onClick={() => setConfirmingDelete(false)}
            className={`${secondaryBtn} mt-2 w-full py-3`}
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}
    </>
  );
}

export default function CookLogEdit() {
  const t = useT();
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
    return <div className="p-6 text-center text-ink-muted">{t('common.loadingRecipe')}</div>;
  }
  if (recipe === null) {
    return (
      <div className="p-6 text-center text-ink-muted">
        {t('common.recipeNotFound')}{' '}
        <Link to="/" className="underline hover:text-ink">
          {t('common.backToLibrary')}
        </Link>
      </div>
    );
  }

  if (recipeStore.isShared(recipe.id)) {
    return (
      <div className="p-6 text-center text-ink-muted">
        {t('error.cookLogSharedRecipe')}{' '}
        <Link to={`/recipe/${recipe.id}`} className="underline hover:text-ink">
          {t('common.backToRecipe')}
        </Link>
      </div>
    );
  }

  const isNew = logId === undefined;
  const entry = isNew ? undefined : (log ?? (removing ? lastLog : null));
  if (entry === null || (entry !== undefined && entry.recipeId !== recipe.id)) {
    return (
      <div className="p-6 text-center text-ink-muted">
        {t('cookLog.notFound')}{' '}
        <Link to={`/recipe/${recipe.id}`} className="underline hover:text-ink">
          {t('common.backToRecipe')}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to={`/recipe/${recipe.id}`} className={backLink}>
          &larr; {t('common.recipe')}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{isNew ? t('recipe.logACook') : t('cookLog.editCook')}</h1>
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
