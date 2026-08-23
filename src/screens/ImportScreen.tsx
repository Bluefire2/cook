import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import RecipeForm from '../components/RecipeForm';
import { importRecipe, type ExtractedRecipe } from '../lib/importApi';
import { recipeStore } from '../lib/recipeStore';
import type { RecipeDraft } from '../lib/types';

export default function ImportScreen() {
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExtractedRecipe | null>(null);

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

  const save = async (draft: RecipeDraft) => {
    const recipe = await recipeStore.create(draft);
    navigate(`/recipe/${recipe.id}`, { replace: true });
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to="/" className="text-sm text-ink-muted">
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
            placeholder="Paste a recipe link, or the recipe text itself…"
            className="w-full rounded-xl border border-line bg-surface px-4 py-3 shadow-sm outline-none focus:border-ink-subtle"
          />
          {error && (
            <p className="mt-2 rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void extract()}
            disabled={busy || input.trim() === ''}
            className="mt-3 w-full rounded-full bg-ink py-3 font-medium text-page disabled:opacity-40"
          >
            {busy ? 'Extracting…' : 'Extract recipe'}
          </button>
          {busy && (
            <p className="mt-3 text-center text-sm text-ink-subtle">
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
            onSubmit={save}
            onCancel={() => setPreview(null)}
          />
        </>
      )}
    </div>
  );
}
