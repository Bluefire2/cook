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
        <Link to="/" className="text-sm text-stone-500">
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
            className="w-full rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-sm outline-none focus:border-stone-400"
          />
          {error && (
            <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void extract()}
            disabled={busy || input.trim() === ''}
            className="mt-3 w-full rounded-full bg-stone-800 py-3 font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Extracting…' : 'Extract recipe'}
          </button>
          {busy && (
            <p className="mt-3 text-center text-sm text-stone-400">
              Reading the recipe — this takes a few seconds.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
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
