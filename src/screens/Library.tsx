import { Link } from 'react-router-dom';
import { useRecipes } from '../lib/recipeStore';

export default function Library() {
  const recipes = useRecipes();

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="flex items-center justify-between py-4">
        <h1 className="text-2xl font-bold">Cook</h1>
        <Link
          to="/settings"
          className="rounded-full px-3 py-1 text-sm text-stone-500"
        >
          Settings
        </Link>
      </header>

      {recipes === undefined ? null : recipes.length === 0 ? (
        <p className="py-12 text-center text-stone-500">
          No recipes yet. Import your first one!
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {recipes.map((recipe) => (
            <li key={recipe.id}>
              <Link
                to={`/recipe/${recipe.id}`}
                className="block rounded-2xl border border-stone-200 bg-white p-4 shadow-sm active:bg-stone-50"
              >
                <h2 className="text-lg font-semibold">{recipe.title}</h2>
                {recipe.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-stone-500">
                    {recipe.description}
                  </p>
                )}
                {recipe.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {recipe.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link
        to="/import"
        aria-label="Add recipe"
        className="fixed right-5 bottom-8 flex h-14 w-14 items-center justify-center rounded-full bg-stone-800 text-3xl leading-none text-white shadow-lg active:bg-stone-700"
      >
        +
      </Link>
    </div>
  );
}
