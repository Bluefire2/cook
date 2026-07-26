import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useRecipe } from '../lib/recipeStore';
import { formatQuantity } from '../lib/quantity';
import { useWakeLock } from '../lib/useWakeLock';
import type { Ingredient } from '../lib/types';

function ingredientLabel(ing: Ingredient, scale: number): string {
  const parts = [
    ing.quantity !== undefined ? formatQuantity(ing.quantity * scale) : null,
    ing.unit ?? null,
    ing.item,
  ].filter(Boolean);
  const base = parts.join(' ');
  return ing.note ? `${base} (${ing.note})` : base;
}

export default function RecipeView() {
  const { id } = useParams<{ id: string }>();
  const recipe = useRecipe(id);
  useWakeLock();

  const [servings, setServings] = useState<number | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [currentStep, setCurrentStep] = useState(0);

  if (recipe === undefined) return null;
  if (recipe === null) {
    return (
      <div className="p-6 text-center text-stone-500">
        Recipe not found.{' '}
        <Link to="/" className="underline">
          Back to library
        </Link>
      </div>
    );
  }

  const effectiveServings = servings ?? recipe.servings;
  const scale = effectiveServings / recipe.servings;

  const toggleChecked = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to="/" className="text-sm text-stone-500">
          &larr; Library
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{recipe.title}</h1>
        {recipe.description && (
          <p className="mt-1 text-stone-500">{recipe.description}</p>
        )}
        <p className="mt-2 text-sm text-stone-500">
          {recipe.prepMinutes != null && `Prep ${recipe.prepMinutes} min`}
          {recipe.prepMinutes != null && recipe.cookMinutes != null && ' · '}
          {recipe.cookMinutes != null && `Cook ${recipe.cookMinutes} min`}
        </p>
      </header>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Ingredients</h2>
          <div className="flex items-center gap-1 rounded-full border border-stone-200 bg-white">
            <button
              type="button"
              aria-label="Fewer servings"
              disabled={effectiveServings <= 1}
              onClick={() => setServings(effectiveServings - 1)}
              className="h-9 w-9 rounded-full text-lg text-stone-600 disabled:opacity-30"
            >
              −
            </button>
            <span className="min-w-16 text-center text-sm">
              {effectiveServings} serving{effectiveServings === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              aria-label="More servings"
              onClick={() => setServings(effectiveServings + 1)}
              className="h-9 w-9 rounded-full text-lg text-stone-600"
            >
              +
            </button>
          </div>
        </div>

        {recipe.ingredientSections.map((section, si) => (
          <div key={si} className="mt-2">
            {section.name && (
              <h3 className="mt-3 text-sm font-medium tracking-wide text-stone-500 uppercase">
                {section.name}
              </h3>
            )}
            <ul className="mt-1 flex flex-col gap-1.5">
              {section.items.map((ing, ii) => {
                const key = `${si}-${ii}`;
                const isChecked = checked.has(key);
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => toggleChecked(key)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left shadow-sm transition-colors ${
                        isChecked ? 'bg-stone-100 text-stone-400' : 'bg-white'
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                          isChecked
                            ? 'border-stone-300 bg-stone-300 text-white'
                            : 'border-stone-300'
                        }`}
                      >
                        {isChecked ? '✓' : ''}
                      </span>
                      <span className={isChecked ? 'line-through' : ''}>
                        {ingredientLabel(ing, scale)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Steps</h2>
        <ol className="mt-2 flex flex-col gap-2">
          {recipe.steps.map((step, i) => {
            const isCurrent = i === currentStep;
            const isDone = i < currentStep;
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => setCurrentStep(i === currentStep ? i + 1 : i)}
                  className={`flex w-full gap-3 rounded-xl px-3 py-3 text-left shadow-sm transition-colors ${
                    isCurrent
                      ? 'bg-white ring-2 ring-amber-400'
                      : isDone
                        ? 'bg-stone-100 text-stone-400'
                        : 'bg-white'
                  }`}
                >
                  <span
                    className={`font-semibold ${
                      isCurrent ? 'text-amber-500' : 'text-stone-400'
                    }`}
                  >
                    {isDone ? '✓' : i + 1}
                  </span>
                  <span className={isCurrent ? 'text-lg' : ''}>{step.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
        {currentStep >= recipe.steps.length && (
          <p className="mt-4 text-center font-medium text-amber-600">
            Done — enjoy!
          </p>
        )}
      </section>

      {recipe.notes && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">Notes</h2>
          <p className="mt-2 rounded-lg bg-white px-3 py-3 text-stone-600 shadow-sm">
            {recipe.notes}
          </p>
        </section>
      )}
    </div>
  );
}
