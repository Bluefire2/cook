import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import CookLogCard from '../components/CookLogCard';
import { useCookLogs } from '../lib/cookLogStore';
import { useRecipes } from '../lib/recipeStore';
import { useSession } from '../lib/session';
import { useSyncStatus } from '../lib/syncEngine';
import { backLink } from '../lib/uiClasses';

export default function CookJournal() {
  const logs = useCookLogs();
  const recipes = useRecipes();
  const { status: sessionStatus } = useSession();
  const syncStatus = useSyncStatus();

  const recipesById = useMemo(
    () => (recipes ? new Map(recipes.map((recipe) => [recipe.id, recipe])) : undefined),
    [recipes],
  );

  const emptyCopy = () => {
    if (sessionStatus === 'signedOut') {
      return 'Sign in from Settings to load your cooks.';
    }
    if (syncStatus.status === 'error') {
      return "Couldn't load your cooks. Try Refresh in Settings.";
    }
    return 'No cooks logged yet. Open a recipe and tap Log a cook.';
  };

  const entries =
    logs && recipesById
      ? logs.flatMap((log) => {
          const recipe = recipesById.get(log.recipeId);
          return recipe ? [{ log, recipe }] : [];
        })
      : undefined;

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to="/" className={backLink}>
          &larr; Library
        </Link>
        <h1 className="mt-2 text-2xl font-bold">Cooks</h1>
      </header>

      {entries === undefined ? (
        <p className="py-12 text-center text-ink-muted">Loading cooks…</p>
      ) : entries.length === 0 ? (
        <p className="py-12 text-center text-ink-muted">{emptyCopy()}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map(({ log, recipe }) => (
            <li key={log.id}>
              <CookLogCard log={log} recipe={recipe} recipeTitle={recipe.title} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
