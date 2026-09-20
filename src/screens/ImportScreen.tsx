import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import RecipeForm from '../components/RecipeForm';
import SaveToCollectionSheet from '../components/SaveToCollectionSheet';
import { collectionStore, libraryHref } from '../lib/collectionStore';
import { SpinnerIcon } from '../lib/icons';
import { importRecipe, type ExtractedRecipe } from '../lib/importApi';
import { recipeStore } from '../lib/recipeStore';
import { backLink, inputFocus, primaryBtn } from '../lib/uiClasses';
import type { RecipeDraft } from '../lib/types';

export default function ImportScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const collectionId = params.get('c') ?? undefined;
  const knownCollectionId = collectionId && collectionStore.get(collectionId)
    ? collectionId
    : undefined;
  const backTo = libraryHref(knownCollectionId);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExtractedRecipe | null>(null);
  const [pendingDraft, setPendingDraft] = useState<RecipeDraft | null>(null);

  const extract = async () => {
    const trimmed = input.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const isUrl = /^https?:\/\/\S+$/.test(trimmed);
      setPreview(
        await importRecipe(isUrl ? { url: trimmed } : { text: trimmed }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  };

  const save = async (collectionId: string | undefined) => {
    if (!pendingDraft) {
      return;
    }
    const recipe = await recipeStore.create(
      pendingDraft,
      collectionId ? { collectionId } : undefined,
    );
    navigate(`/recipe/${recipe.id}`, { replace: true });
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to={backTo} className={backLink}>
          &larr; Library
        </Link>
        <h1 className="mt-2 text-2xl font-bold">Import recipe</h1>
      </header>

      {preview === null ? (
        <>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={5}
            readOnly={busy}
            placeholder="Paste a recipe link, or the recipe text itself…"
            className={`w-full rounded-xl border border-line bg-surface px-4 py-3 shadow-sm ${inputFocus}`}
          />
          {error && (
            <p className="mt-2 rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void extract()}
            disabled={input.trim() === ''}
            aria-busy={busy || undefined}
            aria-disabled={busy || input.trim() === ''}
            className={`${primaryBtn} mt-3 inline-flex w-full items-center justify-center gap-2 py-3 ${busy ? 'pointer-events-none' : ''}`}
          >
            {busy && <SpinnerIcon className="block h-5 w-5 animate-spin" />}
            {busy ? 'Extracting…' : 'Extract recipe'}
          </button>
          {busy && (
            <p className="mt-3 text-center text-sm text-ink-subtle" role="status">
              Reading the recipe — this takes a few seconds.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="rounded-2xl border border-line bg-accent-soft px-4 py-3 text-sm text-ink">
            Anything the extraction got wrong, fix it here before saving.
          </div>

          <RecipeForm
            initial={preview}
            submitLabel="Save to library"
            onSubmit={(draft) => {
              setPendingDraft(draft);
            }}
            onCancel={() => setPreview(null)}
          />
          {pendingDraft && (
            <SaveToCollectionSheet
              onSave={save}
              onCancel={() => setPendingDraft(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

