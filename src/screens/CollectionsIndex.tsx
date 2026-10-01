import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import Sheet from '../components/Sheet';
import { useT } from '../i18n';
import { libraryHref, libraryReturnPath } from '../lib/collectionHref';
import { recipesInCollection, unfiledRecipes } from '../lib/collectionMembership';
import { collectionStore, useCollections } from '../lib/collectionStore';
import { initialLibraryFlow, libraryFlowReducer, runCreate, sheetError } from '../lib/libraryFlow';
import { SharedIcon } from '../lib/icons';
import { useRecipes } from '../lib/recipeStore';
import { useSession } from '../lib/session';
import type { Collection } from '../lib/types';
import { backLink, inputClass, primaryBtn, secondaryBtn } from '../lib/uiClasses';

function fromPath(state: unknown): unknown {
  if (state !== null && typeof state === 'object' && 'from' in state) {
    return state.from;
  }
  return undefined;
}

/**
 * The list of collections. Rows only switch; share, rename, and delete stay
 * on the open collection. See docs/plans/library-collections-region.md.
 */
export default function CollectionsIndex() {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const collections = useCollections();
  const recipes = useRecipes();
  const { status: sessionStatus } = useSession();
  const [flow, dispatch] = useReducer(libraryFlowReducer, initialLibraryFlow);
  const { sheet } = flow;
  const flowRef = useRef(flow);
  useLayoutEffect(() => {
    flowRef.current = flow;
  }, [flow]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCurrent = (token: number) => mountedRef.current && flowRef.current.token === token;
  const collectionName = sheet.kind === 'create' ? sheet.name : '';
  const collectionError = sheetError(sheet);
  const sheetSaving = sheet.kind === 'create' && sheet.saving;
  const loaded = collections !== undefined && recipes !== undefined;
  const hasCollections = loaded && collections.length > 0;
  // Signed out with nothing loaded is the sign-in sentence. A library that
  // already has collections still lists them.
  const signedOutEmpty = sessionStatus === 'signedOut' && !hasCollections;

  const submitCreate = async () => {
    if (sheet.kind !== 'create' || sheet.saving) {
      return;
    }
    const { token } = flow;
    dispatch({ type: 'submitting', token });
    try {
      const result = await runCreate({
        name: sheet.name,
        created: sheet.created,
        moveRecipeIds: sheet.moveRecipeIds,
        isCurrent: () => isCurrent(token),
        create: (name) => collectionStore.create(name),
        rename: (id, name) => collectionStore.rename(id, name),
        move: async (recipeIds, collectionId) => {
          await collectionStore.moveRecipes(recipeIds, collectionId);
        },
        onCreated: (created) => dispatch({ type: 'created', token, created }),
      });
      if (result.kind === 'stale') return;
      dispatch({ type: 'close' });
      navigate(libraryHref(result.id));
    } catch (err) {
      dispatch({
        type: 'failed',
        token,
        error: err instanceof Error ? err.message : t('error.collectionSave'),
      });
    }
  };

  const sharedName = (collection: Collection): string | undefined => {
    if (!collectionStore.isShared(collection.id)) return undefined;
    const email = collectionStore.sharedBy(collection.id);
    return email
      ? t('library.sharedByLabel', { name: collection.name, email })
      : t('library.sharedLabel', { name: collection.name });
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to={libraryReturnPath(fromPath(location.state))} className={backLink}>
          &larr; {t('common.library')}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{t('library.collectionsNav')}</h1>
        {loaded && !signedOutEmpty && (
          <button
            type="button"
            onClick={() => dispatch({ type: 'startCreate' })}
            className="mt-3 text-sm text-ink-muted hover:text-ink"
          >
            {t('common.newCollection')}
          </button>
        )}
      </header>

      {signedOutEmpty ? (
        <p className="py-12 text-center text-ink-muted">{t('library.emptySignedOut')}</p>
      ) : !loaded ? (
        <p className="py-12 text-center text-ink-muted">{t('common.loadingCollections')}</p>
      ) : collections.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('library.collectionsEmpty')}</p>
      ) : (
        <ul>
          <li>
            <Link to="/" className="flex items-baseline justify-between gap-3 py-3">
              <span className="min-w-0 truncate font-medium">{t('library.recipes')}</span>
              <span className="shrink-0 text-sm text-ink-muted">
                {t('library.recipeCount', { count: unfiledRecipes(recipes, collections).length })}
              </span>
            </Link>
          </li>
          {collections.map((collection) => {
            const label = sharedName(collection);
            return (
              <li key={collection.id}>
                <Link
                  to={libraryHref(collection.id)}
                  aria-label={label}
                  className="flex items-baseline justify-between gap-3 py-3"
                >
                  <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
                    {label !== undefined && <SharedIcon className="block h-3.5 w-3.5 shrink-0" />}
                    <span className="truncate">{collection.name}</span>
                  </span>
                  <span className="shrink-0 text-sm text-ink-muted">
                    {t('library.recipeCount', {
                      count: recipesInCollection(recipes, collection, collections).length,
                    })}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {sheet.kind === 'create' && (
        <Sheet onClose={() => dispatch({ type: 'close' })}>
          <h2 className="text-lg font-semibold">{t('common.newCollection')}</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
          >
            <input
              autoFocus
              value={collectionName}
              disabled={sheetSaving}
              onChange={(event) => dispatch({ type: 'setName', name: event.target.value })}
              placeholder={t('common.name')}
              className={`${inputClass} mt-3 disabled:opacity-60`}
            />
            {collectionError && <p className="mt-2 text-sm text-danger">{collectionError}</p>}
            <button
              type="submit"
              disabled={collectionName.trim() === '' || sheetSaving}
              className={`${primaryBtn} mt-3 w-full py-3`}
            >
              {t('library.create')}
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: 'close' })}
              className={`${secondaryBtn} mt-2 w-full py-3`}
            >
              {t('common.cancel')}
            </button>
          </form>
        </Sheet>
      )}
    </div>
  );
}
