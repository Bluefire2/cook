import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useT } from '../i18n';
import ShareCollectionSheet from '../components/ShareCollectionSheet';
import Sheet from '../components/Sheet';
import { FolderIcon, PlusIcon, SharedIcon } from '../lib/icons';
import {
  collectionStore,
  libraryHref,
  useCollections,
} from '../lib/collectionStore';
import { recipesInCollection, unfiledRecipes } from '../lib/collectionMembership';
import { usePhotoUrl } from '../lib/photoStore';
import { recipeStore, useRecipes } from '../lib/recipeStore';
import { visibleLibraryRecipes } from '../lib/visibleLibraryRecipes';
import { useSession } from '../lib/session';
import { useSyncStatus } from '../lib/syncEngine';
import {
  dangerBtn,
  ghostBtn,
  inputClass,
  menuItem,
  menuItemDanger,
  primaryBtn,
  secondaryBtn,
} from '../lib/uiClasses';

function CardThumb({ photoId }: { photoId: string }) {
  const url = usePhotoUrl(photoId);
  return (
    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-surface-muted">
      {url && <img src={url} alt="" className="h-full w-full object-cover" />}
    </div>
  );
}

function chipClass(active: boolean): string {
  return active
    ? 'rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-page'
    : 'rounded-full bg-surface-muted px-3 py-1.5 text-sm text-ink-muted hover:bg-surface hover:text-ink';
}

export default function Library() {
  const t = useT();
  const allRecipes = useRecipes();
  const collections = useCollections();
  const { status: sessionStatus } = useSession();
  const syncStatus = useSyncStatus();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const requestedId = params.get('c');
  const named =
    requestedId && collections
      ? collections.find((c) => c.id === requestedId)
      : undefined;
  const currentId = named?.id;

  const [query, setQuery] = useState('');
  const [browseAll, setBrowseAll] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [moveRecipeId, setMoveRecipeId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteCollectionOpen, setDeleteCollectionOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [collectionName, setCollectionName] = useState('');
  const [collectionError, setCollectionError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [createdCollection, setCreatedCollection] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const firstActionRef = useRef<HTMLAnchorElement>(null);

  const scoped =
    allRecipes === undefined || collections === undefined
      ? undefined
      : named
        ? recipesInCollection(allRecipes, named, collections)
        : unfiledRecipes(allRecipes, collections);

  const q = query.trim().toLowerCase();
  const recipes = visibleLibraryRecipes({
    all: allRecipes,
    scoped,
    query,
    browseAll,
  });

  const pendingDelete = allRecipes?.find((r) => r.id === pendingDeleteId);
  const moveRecipe = allRecipes?.find((r) => r.id === moveRecipeId);
  const namedIsShared = named ? collectionStore.isShared(named.id) : false;
  const showSwitcher = (collections?.length ?? 0) > 0;
  const addQuery =
    currentId && !namedIsShared ? `?c=${encodeURIComponent(currentId)}` : '';
  const ownedCollections =
    collections?.filter((collection) => !collectionStore.isShared(collection.id)) ?? [];

  const remove = async (id: string) => {
    setPendingDeleteId(null);
    setDeleteError(null);
    try {
      await recipeStore.remove(id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('error.recipeDelete'));
    }
  };

  const closeSheets = () => {
    setAddOpen(false);
    setPendingDeleteId(null);
    setMoveRecipeId(null);
    setCreateOpen(false);
    setRenameOpen(false);
    setDeleteCollectionOpen(false);
    setLeaveOpen(false);
    setShareOpen(false);
    setCollectionName('');
    setCollectionError(null);
    setCreatedCollection(null);
  };

  const submitCreate = async () => {
    const trimmed = collectionName.trim();
    setCollectionError(null);
    try {
      // Reuse the collection a failed attempt already created, so retrying
      // does not leave two folders with the same name behind.
      let id: string;
      if (createdCollection === null) {
        id = (await collectionStore.create(collectionName)).id;
        setCreatedCollection({ id, name: trimmed });
      } else {
        id = createdCollection.id;
        if (createdCollection.name !== trimmed) {
          await collectionStore.rename(id, collectionName);
          setCreatedCollection({ id, name: trimmed });
        }
      }
      if (moveRecipeId) {
        await collectionStore.moveRecipe(moveRecipeId, id);
      }
      closeSheets();
      navigate(libraryHref(id));
    } catch (err) {
      setCollectionError(err instanceof Error ? err.message : t('error.collectionSave'));
    }
  };

  const submitMove = async (dest: 'default' | string) => {
    if (!moveRecipeId) {
      return;
    }
    setCollectionError(null);
    try {
      await collectionStore.moveRecipe(moveRecipeId, dest);
      closeSheets();
      navigate(dest === 'default' ? '/' : libraryHref(dest));
    } catch (err) {
      setCollectionError(err instanceof Error ? err.message : t('error.collectionMove'));
    }
  };

  const submitRename = async () => {
    if (!currentId) {
      return;
    }
    setCollectionError(null);
    try {
      await collectionStore.rename(currentId, collectionName);
      closeSheets();
    } catch (err) {
      setCollectionError(err instanceof Error ? err.message : t('error.collectionSave'));
    }
  };

  const submitDeleteCollection = async () => {
    if (!currentId) {
      return;
    }
    setCollectionError(null);
    try {
      await collectionStore.remove(currentId);
      closeSheets();
      navigate('/');
    } catch (err) {
      setCollectionError(
        err instanceof Error ? err.message : t('error.collectionDelete'),
      );
    }
  };

  const submitLeave = async () => {
    if (!currentId) {
      return;
    }
    setCollectionError(null);
    setLeaveBusy(true);
    try {
      await collectionStore.leave(currentId);
      closeSheets();
      navigate('/');
    } catch (err) {
      setCollectionError(
        err instanceof Error ? err.message : t('error.leaveCollection'),
      );
    } finally {
      setLeaveBusy(false);
    }
  };

  useEffect(() => {
    setBrowseAll(false);
  }, [currentId]);

  useEffect(() => {
    if (!menuId) return;
    firstActionRef.current?.focus({ preventScroll: true });
  }, [menuId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menuId !== null) {
        event.preventDefault();
        setMenuId(null);
        menuTriggerRef.current?.focus();
        return;
      }
      if (
        pendingDeleteId !== null ||
        addOpen ||
        moveRecipeId !== null ||
        createOpen ||
        renameOpen ||
        deleteCollectionOpen ||
        leaveOpen
      ) {
        event.preventDefault();
        closeSheets();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    menuId,
    pendingDeleteId,
    addOpen,
    moveRecipeId,
    createOpen,
    renameOpen,
    deleteCollectionOpen,
    leaveOpen,
  ]);

  const emptyCopy = () => {
    if (q !== '') {
      return t('library.emptySearch');
    }
    if (sessionStatus === 'signedOut') {
      return t('library.emptySignedOut');
    }
    if (syncStatus.status === 'error') {
      return t('library.emptyError');
    }
    if (named) {
      return t('library.emptyCollection');
    }
    return t('library.empty');
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="flex items-center justify-between py-4">
        <h1 className="text-2xl font-bold">Sous</h1>
        <div className="flex items-center gap-1">
          <Link to="/cooks" className={ghostBtn}>
            {t('library.cooks')}
          </Link>
          <Link to="/settings" className={ghostBtn}>
            {t('settings.title')}
          </Link>
        </div>
      </header>

      {showSwitcher && (
        <nav aria-label={t('library.collectionsNav')} className="mb-3 flex items-start gap-1.5">
          <FolderIcon className="mt-2 block h-4 w-4 shrink-0 text-ink-muted" />
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Link
              to="/"
              onClick={() => setBrowseAll(false)}
              className={chipClass(!browseAll && currentId === undefined)}
            >
              {t('library.recipes')}
            </Link>
            {collections?.map((collection) => {
              const shared = collectionStore.isShared(collection.id);
              const sharedBy = shared ? collectionStore.sharedBy(collection.id) : undefined;
              const sharedLabel = sharedBy
                ? t('library.sharedByLabel', { name: collection.name, email: sharedBy })
                : t('library.sharedLabel', { name: collection.name });
              return (
                <Link
                  key={collection.id}
                  to={libraryHref(collection.id)}
                  onClick={() => setBrowseAll(false)}
                  aria-label={shared ? sharedLabel : collection.name}
                  title={shared ? sharedLabel : undefined}
                  className={`${chipClass(!browseAll && collection.id === currentId)} inline-flex items-center gap-1.5`}
                >
                  {shared && (
                    <SharedIcon className="block h-3.5 w-3.5 shrink-0" />
                  )}
                  {collection.name}
                </Link>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setCollectionName('');
                setCollectionError(null);
                setCreateOpen(true);
              }}
              className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
            >
              {t('library.new')}
            </button>
            {named && !namedIsShared && (
              <>
                <button
                  type="button"
                  onClick={() => setShareOpen(true)}
                  className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                >
                  {t('common.share')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCollectionName(named.name);
                    setCollectionError(null);
                    setRenameOpen(true);
                  }}
                  className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                >
                  {t('library.rename')}
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteCollectionOpen(true)}
                  className="rounded-full px-3 py-1.5 text-sm text-danger hover:text-ink"
                >
                  {t('common.delete')}
                </button>
              </>
            )}
          </div>
        </nav>
      )}

      {named && namedIsShared && !browseAll && (
        <div className="-mt-1 mb-3 flex items-center justify-between gap-2 text-sm text-ink-muted">
          <span>
            {/* One catalog sentence per case: joining two with a space breaks Chinese punctuation. */}
            {(() => {
              const email = collectionStore.sharedBy(named.id);
              const editor = collectionStore.access(named.id) === 'editor';
              if (email) {
                return editor
                  ? t('library.sharedBannerByEdit', { email })
                  : t('library.sharedBannerByView', { email });
              }
              return editor ? t('library.sharedBannerEdit') : t('library.sharedBannerView');
            })()}
          </span>
          <button
            type="button"
            onClick={() => {
              setCollectionError(null);
              setLeaveOpen(true);
            }}
            className="shrink-0 text-sm text-danger hover:underline"
          >
            {t('library.leave')}
          </button>
        </div>
      )}

      {showSwitcher ? (
        <div className="mb-4 flex items-center gap-2">
          <input
            type="search"
            placeholder={
              browseAll
                ? t('library.searchAll')
                : named
                  ? t('library.searchIn', { name: named.name })
                  : t('library.search')
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={`${inputClass} min-w-0 flex-1`}
          />
          <button
            type="button"
            onClick={() => setBrowseAll((on) => !on)}
            className={`${chipClass(browseAll)} shrink-0`}
          >
            {t('library.allCollections')}
          </button>
        </div>
      ) : (
        <input
          type="search"
          placeholder={t('library.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${inputClass} mb-4`}
        />
      )}

      {deleteError && (
        <p className="mb-3 text-sm text-danger">{deleteError}</p>
      )}

      {recipes === undefined ? (
        <p className="py-12 text-center text-ink-muted">{t('library.loadingRecipes')}</p>
      ) : recipes.length === 0 ? (
        <p className="py-12 text-center text-ink-muted">{emptyCopy()}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {recipes.map((recipe) => (
            <li key={recipe.id} className="relative">
              <Link
                to={`/recipe/${recipe.id}`}
                className="flex gap-3 rounded-2xl border border-line bg-surface p-4 pr-14 shadow-sm hover:border-line-strong hover:bg-surface-muted active:bg-surface-muted"
              >
                {recipe.photoId !== undefined && (
                  <CardThumb photoId={recipe.photoId} />
                )}
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold">{recipe.title}</h2>
                  {recipe.description && (
                    <p className="mt-1 line-clamp-2 text-sm text-ink-muted">
                      {recipe.description}
                    </p>
                  )}
                  {recipe.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {recipe.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-ink-muted"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </Link>

              {!recipeStore.isShared(recipe.id) && (
              <button
                type="button"
                aria-label={t('library.actionsFor', { title: recipe.title })}
                aria-expanded={menuId === recipe.id}
                onClick={(event) => {
                  menuTriggerRef.current = event.currentTarget;
                  setMenuId(menuId === recipe.id ? null : recipe.id);
                }}
                className="absolute top-2 right-2 flex h-11 w-11 items-center justify-center rounded-full text-xl leading-none text-ink-subtle hover:bg-surface-muted active:bg-surface-muted"
              >
                ⋯
              </button>
              )}

              {menuId === recipe.id && !recipeStore.isShared(recipe.id) && (
                <div
                  role="group"
                  aria-label={t('library.actionsFor', { title: recipe.title })}
                  className="absolute top-13 right-3 z-20 w-40 overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
                >
                  <Link
                    to={`/recipe/${recipe.id}/edit`}
                    ref={firstActionRef}
                    className={menuItem}
                  >
                    {t('common.edit')}
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuId(null);
                      setMoveRecipeId(recipe.id);
                    }}
                    className={`${menuItem} border-t border-line`}
                  >
                    {t('library.moveTo')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuId(null);
                      setPendingDeleteId(recipe.id);
                    }}
                    className={`${menuItemDanger} border-t border-line`}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {menuId !== null && (
        <button
          type="button"
          aria-label={t('library.closeMenu')}
          tabIndex={-1}
          onClick={() => setMenuId(null)}
          className="fixed inset-0 z-10"
        />
      )}

      {sessionStatus === 'signedIn' && !namedIsShared && (
        <button
          type="button"
          aria-label={t('library.addRecipe')}
          onClick={() => setAddOpen(true)}
          className="fixed right-5 bottom-8 flex h-14 w-14 items-center justify-center rounded-full bg-ink text-page shadow-lg hover:opacity-90 active:opacity-90"
        >
          <PlusIcon className="block h-8 w-8" />
        </button>
      )}

      {addOpen && (
        <Sheet onClose={() => setAddOpen(false)}>
          <h2 className="text-lg font-semibold">{t('library.addRecipeTitle')}</h2>
          <Link
            to={`/import${addQuery}`}
            className={`${primaryBtn} mt-3 block py-3 text-center`}
          >
            {t('library.importFromLink')}
          </Link>
          <Link
            to={`/recipe/new${addQuery}`}
            className={`${secondaryBtn} mt-2 block py-3 text-center`}
          >
            {t('library.writeFromScratch')}
          </Link>
          <button
            type="button"
            onClick={() => setAddOpen(false)}
            className="mt-2 w-full py-2.5 text-sm text-ink-muted hover:text-ink"
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}

      {pendingDelete && (
        <Sheet onClose={() => setPendingDeleteId(null)}>
          <h2 className="text-lg font-semibold">
            {t('library.deleteRecipeTitle', { title: pendingDelete.title })}
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            {t('library.deleteRecipeBody')}
          </p>
          <button
            type="button"
            onClick={() => void remove(pendingDelete.id)}
            className={`${dangerBtn} mt-3 w-full py-3`}
          >
            {t('common.delete')}
          </button>
          <button
            type="button"
            onClick={() => setPendingDeleteId(null)}
            className={`${secondaryBtn} mt-2 w-full py-3`}
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}

      {moveRecipe && !createOpen && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">{t('library.moveTitle', { title: moveRecipe.title })}</h2>
          <button
            type="button"
            onClick={() => void submitMove('default')}
            className={`${secondaryBtn} mt-3 w-full py-3`}
          >
            {t('library.recipes')}
          </button>
          {ownedCollections.map((collection) => (
            <button
              key={collection.id}
              type="button"
              onClick={() => void submitMove(collection.id)}
              className={`${secondaryBtn} mt-2 w-full py-3`}
            >
              {collection.name}
            </button>
          ))}
          {collectionError && (
            <p className="mt-2 text-sm text-danger">{collectionError}</p>
          )}
          <button
            type="button"
            onClick={() => {
              setCollectionName('');
              setCollectionError(null);
              setCreateOpen(true);
            }}
            className={`${primaryBtn} mt-2 w-full py-3`}
          >
            {t('common.newCollection')}
          </button>
          <button
            type="button"
            onClick={() => closeSheets()}
            className="mt-2 w-full py-2.5 text-sm text-ink-muted hover:text-ink"
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}

      {createOpen && (
        <Sheet onClose={() => closeSheets()}>
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
              onChange={(e) => setCollectionName(e.target.value)}
              placeholder={t('common.name')}
              className={`${inputClass} mt-3`}
            />
            {collectionError && (
              <p className="mt-2 text-sm text-danger">{collectionError}</p>
            )}
            <button
              type="submit"
              disabled={collectionName.trim() === ''}
              className={`${primaryBtn} mt-3 w-full py-3`}
            >
              {t('library.create')}
            </button>
            <button
              type="button"
              onClick={() => closeSheets()}
              className={`${secondaryBtn} mt-2 w-full py-3`}
            >
              {t('common.cancel')}
            </button>
          </form>
        </Sheet>
      )}

      {renameOpen && named && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">{t('library.renameCollection')}</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <input
              autoFocus
              value={collectionName}
              onChange={(e) => setCollectionName(e.target.value)}
              className={`${inputClass} mt-3`}
            />
            {collectionError && (
              <p className="mt-2 text-sm text-danger">{collectionError}</p>
            )}
            <button
              type="submit"
              className={`${primaryBtn} mt-3 w-full py-3`}
            >
              {t('common.save')}
            </button>
            <button
              type="button"
              onClick={() => closeSheets()}
              className={`${secondaryBtn} mt-2 w-full py-3`}
            >
              {t('common.cancel')}
            </button>
          </form>
        </Sheet>
      )}

      {deleteCollectionOpen && named && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">{t('library.deleteCollectionTitle', { name: named.name })}</h2>
          <p className="mt-1 text-sm text-ink-muted">
            {t('library.deleteCollectionBody')}
          </p>
          {collectionError && (
            <p className="mt-2 text-sm text-danger">{collectionError}</p>
          )}
          <button
            type="button"
            onClick={() => void submitDeleteCollection()}
            className={`${dangerBtn} mt-3 w-full py-3`}
          >
            {t('library.deleteCollection')}
          </button>
          <button
            type="button"
            onClick={() => closeSheets()}
            className={`${secondaryBtn} mt-2 w-full py-3`}
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}

      {leaveOpen && named && namedIsShared && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">{t('library.leaveTitle', { name: named.name })}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('library.leaveBody')}</p>
          {collectionError && (
            <p className="mt-2 text-sm text-danger">{collectionError}</p>
          )}
          <button
            type="button"
            onClick={() => void submitLeave()}
            disabled={leaveBusy}
            className={`${dangerBtn} mt-3 w-full py-3`}
          >
            {leaveBusy ? t('library.leaving') : t('library.leaveCollection')}
          </button>
          <button
            type="button"
            onClick={() => closeSheets()}
            className={`${secondaryBtn} mt-2 w-full py-3`}
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}

      {shareOpen && named && !namedIsShared && (
        <ShareCollectionSheet
          collection={named}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}
