import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { importRecipe, type ExtractedRecipe } from '../lib/importApi';
import { recipeStore } from '../lib/recipeStore';
import { formatQuantity } from '../lib/quantity';
import type { Ingredient } from '../lib/types';

function ingredientLabel(ing: Ingredient): string {
  const parts = [
    ing.quantity !== undefined ? formatQuantity(ing.quantity) : null,
    ing.unit ?? null,
    ing.item,
  ].filter(Boolean);
  const base = parts.join(' ');
  return ing.note ? `${base} (${ing.note})` : base;
}

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

  const save = async () => {
    if (!preview) return;
    const recipe = await recipeStore.create(preview);
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
            Check the extraction, then save it to your library.
          </div>

          <h2 className="mt-4 text-xl font-bold">{preview.title}</h2>
          {preview.description && (
            <p className="mt-1 text-stone-500">{preview.description}</p>
          )}
          <p className="mt-1 text-sm text-stone-500">
            Serves {preview.servings}
            {preview.prepMinutes != null && ` · Prep ${preview.prepMinutes} min`}
            {preview.cookMinutes != null && ` · Cook ${preview.cookMinutes} min`}
          </p>

          <h3 className="mt-4 font-semibold">Ingredients</h3>
          {preview.ingredientSections.map((section, si) => (
            <div key={si}>
              {section.name && (
                <h4 className="mt-2 text-sm font-medium tracking-wide text-stone-500 uppercase">
                  {section.name}
                </h4>
              )}
              <ul className="mt-1 flex flex-col gap-1">
                {section.items.map((ing, ii) => (
                  <li key={ii} className="rounded-lg bg-white px-3 py-1.5 text-sm shadow-sm">
                    {ingredientLabel(ing)}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <h3 className="mt-4 font-semibold">Steps</h3>
          <ol className="mt-1 flex flex-col gap-1">
            {preview.steps.map((step, i) => (
              <li key={i} className="flex gap-2 rounded-lg bg-white px-3 py-2 text-sm shadow-sm">
                <span className="font-semibold text-stone-400">{i + 1}</span>
                {step.text}
              </li>
            ))}
          </ol>

          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="flex-1 rounded-full border border-stone-300 py-3 font-medium text-stone-600"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void save()}
              className="flex-1 rounded-full bg-stone-800 py-3 font-medium text-white"
            >
              Save to library
            </button>
          </div>
        </>
      )}
    </div>
  );
}
