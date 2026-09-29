import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import CookLogCard from '../components/CookLogCard';
import { useCookLogs } from '../lib/cookLogStore';
import { useRecipes } from '../lib/recipeStore';
import { useSession } from '../lib/session';
import { useSyncStatus } from '../lib/syncEngine';
import { backLink } from '../lib/uiClasses';

export default function CookJournal() {
  const t = useT();
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
      return t('cooks.emptySignedOut');
    }
    if (syncStatus.status === 'error') {
      return t('cooks.emptyError');
    }
    return t('cooks.empty');
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
          &larr; {t('common.library')}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{t('library.cooks')}</h1>
      </header>

      {entries === undefined ? (
        <p className="py-12 text-center text-ink-muted">{t('cooks.loading')}</p>
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
