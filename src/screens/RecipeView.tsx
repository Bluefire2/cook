import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ChatPanel from '../components/ChatPanel';
import { usePhotoUrl } from '../lib/photoStore';
import { useRecipe } from '../lib/recipeStore';
import { formatQuantity } from '../lib/quantity';
import { useWakeLock } from '../lib/useWakeLock';
import { useCookState } from '../lib/useCookState';
import type { Ingredient } from '../lib/types';

/**
 * The source is whatever the user pasted on import, so it is only ever linked
 * after it turns out to be an ordinary web address.
 */
function sourceLink(url: string | undefined): URL | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

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
  const photoUrl = usePhotoUrl(recipe?.photoId);
  useWakeLock();

  const {
    servings,
    currentStep,
    checkedKeys,
    setServings,
    setCurrentStep,
    toggleChecked,
    checkedItemNames,
  } = useCookState(recipe);
  const [chatOpen, setChatOpen] = useState(false);

  if (recipe === undefined) return null;
  if (recipe === null) {
    return (
      <div className="p-6 text-center text-ink-muted">
        Recipe not found.{' '}
        <Link to="/" className="underline">
          Back to library
        </Link>
      </div>
    );
  }

  const scale = servings / recipe.servings;
  const source = sourceLink(recipe.sourceUrl);

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <div className="flex items-center justify-between">
          <Link to="/" className="text-sm text-ink-muted">
            &larr; Library
          </Link>
          <Link
            to={`/recipe/${recipe.id}/edit`}
            className="rounded-full px-3 py-1 text-sm text-ink-muted"
          >
            Edit
          </Link>
        </div>
        {photoUrl && (
          <img
            src={photoUrl}
            alt=""
            className="mt-3 h-52 w-full rounded-2xl object-cover shadow-sm"
          />
        )}
        <h1 className="mt-2 text-2xl font-bold">{recipe.title}</h1>
        {recipe.description && (
          <p className="mt-1 text-ink-muted">{recipe.description}</p>
        )}
        <p className="mt-2 text-sm text-ink-muted">
          {recipe.prepMinutes != null && `Prep ${recipe.prepMinutes} min`}
          {recipe.prepMinutes != null && recipe.cookMinutes != null && ' · '}
          {recipe.cookMinutes != null && `Cook ${recipe.cookMinutes} min`}
        </p>
      </header>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Ingredients</h2>
          <div className="flex items-center gap-1 rounded-full border border-line bg-surface">
            <button
              type="button"
              aria-label="Fewer servings"
              disabled={servings <= 1}
              onClick={() => setServings(servings - 1)}
              className="h-9 w-9 rounded-full text-lg text-ink-muted disabled:opacity-30"
            >
              −
            </button>
            <span className="min-w-16 text-center text-sm">
              {servings} serving{servings === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              aria-label="More servings"
              onClick={() => setServings(servings + 1)}
              className="h-9 w-9 rounded-full text-lg text-ink-muted"
            >
              +
            </button>
          </div>
        </div>

        {recipe.ingredientSections.map((section, si) => (
          <div key={si} className="mt-2">
            {section.name && (
              <h3 className="mt-3 text-sm font-medium tracking-wide text-ink-muted uppercase">
                {section.name}
              </h3>
            )}
            <ul className="mt-1 flex flex-col gap-1.5">
              {section.items.map((ing, ii) => {
                const key = `${si}-${ii}`;
                const isChecked = checkedKeys.has(key);
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => toggleChecked(key)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left shadow-sm transition-colors ${
                        isChecked
                          ? 'bg-surface-muted text-ink-subtle'
                          : 'bg-surface'
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                          isChecked
                            ? 'border-line-strong bg-ink-subtle text-page'
                            : 'border-line-strong'
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
                      ? 'bg-surface ring-2 ring-amber-400'
                      : isDone
                        ? 'bg-surface-muted text-ink-subtle'
                        : 'bg-surface'
                  }`}
                >
                  <span
                    className={`font-semibold ${
                      isCurrent ? 'text-amber-500' : 'text-ink-subtle'
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
          <p className="mt-2 rounded-lg bg-surface px-3 py-3 text-ink-muted shadow-sm">
            {recipe.notes}
          </p>
        </section>
      )}

      {source && (
        <p className="mt-6 text-sm text-ink-muted">
          From{' '}
          <a
            href={source.href}
            target="_blank"
            rel="noreferrer noopener"
            className="underline"
          >
            {source.hostname}
          </a>
        </p>
      )}

      {!chatOpen && (
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          className="fixed right-5 bottom-8 z-10 flex h-14 items-center gap-2 rounded-full bg-amber-500 px-5 font-medium text-white shadow-lg active:bg-amber-600"
        >
          Ask
        </button>
      )}
      {chatOpen && (
        <ChatPanel
          recipe={recipe}
          cookingState={{
            servings,
            currentStep: currentStep + 1,
            checkedIngredients: checkedItemNames(recipe),
          }}
          onClose={() => setChatOpen(false)}
        />
      )}
    </div>
  );
}
