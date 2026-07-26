import { Link, useParams } from 'react-router-dom';
import { useRecipe } from '../lib/recipeStore';
import type { Ingredient } from '../lib/types';

function formatIngredient(ing: Ingredient): string {
  const parts = [
    ing.quantity !== undefined ? String(ing.quantity) : null,
    ing.unit ?? null,
    ing.item,
  ].filter(Boolean);
  const base = parts.join(' ');
  return ing.note ? `${base} (${ing.note})` : base;
}

export default function RecipeView() {
  const { id } = useParams<{ id: string }>();
  const recipe = useRecipe(id);

  if (recipe === undefined) return null;
  if (recipe === null) {
    return (
      <div className="p-6 text-center text-stone-500">
        Recipe not found. <Link to="/" className="underline">Back to library</Link>
      </div>
    );
  }

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
          Serves {recipe.servings}
          {recipe.prepMinutes != null && ` · Prep ${recipe.prepMinutes} min`}
          {recipe.cookMinutes != null && ` · Cook ${recipe.cookMinutes} min`}
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold">Ingredients</h2>
        {recipe.ingredientSections.map((section, si) => (
          <div key={si} className="mt-2">
            {section.name && (
              <h3 className="mt-3 text-sm font-medium tracking-wide text-stone-500 uppercase">
                {section.name}
              </h3>
            )}
            <ul className="mt-1 flex flex-col gap-1.5">
              {section.items.map((ing, ii) => (
                <li key={ii} className="rounded-lg bg-white px-3 py-2 shadow-sm">
                  {formatIngredient(ing)}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Steps</h2>
        <ol className="mt-2 flex flex-col gap-2">
          {recipe.steps.map((step, i) => (
            <li key={i} className="flex gap-3 rounded-lg bg-white px-3 py-3 shadow-sm">
              <span className="font-semibold text-stone-400">{i + 1}</span>
              <span>{step.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
