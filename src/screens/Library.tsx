import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Sheet from '../components/Sheet';
import { FolderIcon, PlusIcon } from '../lib/icons';
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
  const [collectionName, setCollectionName] = useState('');
  const [collectionError, setCollectionError] = useState<string | null>(null);
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
  const showSwitcher = (collections?.length ?? 0) > 0;
  const addQuery = currentId ? `?c=${encodeURIComponent(currentId)}` : '';

  const remove = async (id: string) => {
    setPendingDeleteId(null);
    await recipeStore.remove(id);
  };

  const closeSheets = () => {
    setAddOpen(false);
    setPendingDeleteId(null);
    setMoveRecipeId(null);
    setCreateOpen(false);
    setRenameOpen(false);
    setDeleteCollectionOpen(false);
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
      setCollectionError(err instanceof Error ? err.message : "Couldn't save the collection.");
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
      setCollectionError(err instanceof Error ? err.message : "Couldn't move the recipe.");
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
      setCollectionError(err instanceof Error ? err.message : "Couldn't save the collection.");
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
        err instanceof Error ? err.message : "Couldn't delete the collection.",
      );
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
        deleteCollectionOpen
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
  ]);

  const emptyCopy = () => {
    if (q !== '') {
      return 'No recipes match your search.';
    }
    if (sessionStatus === 'signedOut') {
      return 'Sign in from Settings to load your recipes.';
    }
    if (syncStatus.status === 'error') {
      return "Couldn't load your recipes. Try Refresh in Settings.";
    }
    if (named) {
      return 'No recipes in this collection yet.';
    }
    return 'No recipes yet. Import your first one!';
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="flex items-center justify-between py-4">
        <h1 className="text-2xl font-bold">Sous</h1>
        <Link to="/settings" className={ghostBtn}>
          Settings
        </Link>
      </header>

      {showSwitcher && (
        <nav aria-label="Collections" className="mb-3 flex items-start gap-1.5">
          <FolderIcon className="mt-2 block h-4 w-4 shrink-0 text-ink-muted" />
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Link
              to="/"
              onClick={() => setBrowseAll(false)}
              className={chipClass(!browseAll && currentId === undefined)}
            >
              Recipes
            </Link>
            {collections?.map((collection) => (
              <Link
                key={collection.id}
                to={libraryHref(collection.id)}
                onClick={() => setBrowseAll(false)}
                className={chipClass(!browseAll && collection.id === currentId)}
              >
                {collection.name}
              </Link>
            ))}
            <button
              type="button"
              onClick={() => {
                setCollectionName('');
                setCollectionError(null);
                setCreateOpen(true);
              }}
              className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
            >
              New
            </button>
            {named && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setCollectionName(named.name);
                    setCollectionError(null);
                    setRenameOpen(true);
                  }}
                  className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteCollectionOpen(true)}
                  className="rounded-full px-3 py-1.5 text-sm text-danger hover:text-ink"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </nav>
      )}

      {showSwitcher ? (
        <div className="mb-4 flex items-center gap-2">
          <input
            type="search"
            placeholder={
              browseAll
                ? 'Search all recipes…'
                : named
                  ? `Search in ${named.name}…`
                  : 'Search recipes…'
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
            All collections
          </button>
        </div>
      ) : (
        <input
          type="search"
          placeholder="Search recipes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${inputClass} mb-4`}
        />
      )}

      {recipes === undefined ? (
        <p className="py-12 text-center text-ink-muted">Loading recipes…</p>
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

              <button
                type="button"
                aria-label={`Actions for ${recipe.title}`}
                aria-expanded={menuId === recipe.id}
                onClick={(event) => {
                  menuTriggerRef.current = event.currentTarget;
                  setMenuId(menuId === recipe.id ? null : recipe.id);
                }}
                className="absolute top-2 right-2 flex h-11 w-11 items-center justify-center rounded-full text-xl leading-none text-ink-subtle hover:bg-surface-muted active:bg-surface-muted"
              >
                ⋯
              </button>

              {menuId === recipe.id && (
                <div
                  role="group"
                  aria-label={`Actions for ${recipe.title}`}
                  className="absolute top-13 right-3 z-20 w-40 overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
                >
                  <Link
                    to={`/recipe/${recipe.id}/edit`}
                    ref={firstActionRef}
                    className={menuItem}
                  >
                    Edit
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuId(null);
                      setMoveRecipeId(recipe.id);
                    }}
                    className={`${menuItem} border-t border-line`}
                  >
                    Move to…
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuId(null);
                      setPendingDeleteId(recipe.id);
                    }}
                    className={`${menuItemDanger} border-t border-line`}
                  >
                    Delete
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
          aria-label="Close menu"
          tabIndex={-1}
          onClick={() => setMenuId(null)}
          className="fixed inset-0 z-10"
        />
      )}

      {sessionStatus === 'signedIn' && (
        <button
          type="button"
          aria-label="Add recipe"
          onClick={() => setAddOpen(true)}
          className="fixed right-5 bottom-8 flex h-14 w-14 items-center justify-center rounded-full bg-ink text-page shadow-lg hover:opacity-90 active:opacity-90"
        >
          <PlusIcon className="block h-8 w-8" />
        </button>
      )}

      {addOpen && (
        <Sheet onClose={() => setAddOpen(false)}>
          <h2 className="text-lg font-semibold">Add a recipe</h2>
          <Link
            to={`/import${addQuery}`}
            className={`${primaryBtn} mt-3 block py-3 text-center`}
          >
            Import from a link or text
          </Link>
          <Link
            to={`/recipe/new${addQuery}`}
            className={`${secondaryBtn} mt-2 block py-3 text-center`}
          >
            Write one from scratch
          </Link>
          <button
            type="button"
            onClick={() => setAddOpen(false)}
            className="mt-2 w-full py-2.5 text-sm text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
        </Sheet>
      )}

      {pendingDelete && (
        <Sheet onClose={() => setPendingDeleteId(null)}>
          <h2 className="text-lg font-semibold">
            Delete “{pendingDelete.title}”?
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            This also deletes its chat history. There is no undo.
          </p>
          <button
            type="button"
            onClick={() => void remove(pendingDelete.id)}
            className={`${dangerBtn} mt-3 w-full py-3`}
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setPendingDeleteId(null)}
            className={`${secondaryBtn} mt-2 w-full py-3`}
          >
            Cancel
          </button>
        </Sheet>
      )}

      {moveRecipe && !createOpen && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">Move “{moveRecipe.title}”</h2>
          <button
            type="button"
            onClick={() => void submitMove('default')}
            className={`${secondaryBtn} mt-3 w-full py-3`}
          >
            Recipes
          </button>
          {collections?.map((collection) => (
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
            New collection
          </button>
          <button
            type="button"
            onClick={() => closeSheets()}
            className="mt-2 w-full py-2.5 text-sm text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
        </Sheet>
      )}

      {createOpen && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">New collection</h2>
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
              placeholder="Name"
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
              Create
            </button>
            <button
              type="button"
              onClick={() => closeSheets()}
              className={`${secondaryBtn} mt-2 w-full py-3`}
            >
              Cancel
            </button>
          </form>
        </Sheet>
      )}

      {renameOpen && named && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">Rename collection</h2>
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
              Save
            </button>
            <button
              type="button"
              onClick={() => closeSheets()}
              className={`${secondaryBtn} mt-2 w-full py-3`}
            >
              Cancel
            </button>
          </form>
        </Sheet>
      )}

      {deleteCollectionOpen && named && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">Delete “{named.name}”?</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Recipes in it go back to Recipes. They are not deleted.
          </p>
          {collectionError && (
            <p className="mt-2 text-sm text-danger">{collectionError}</p>
          )}
          <button
            type="button"
            onClick={() => void submitDeleteCollection()}
            className={`${dangerBtn} mt-3 w-full py-3`}
          >
            Delete collection
          </button>
          <button
            type="button"
            onClick={() => closeSheets()}
            className={`${secondaryBtn} mt-2 w-full py-3`}
          >
            Cancel
          </button>
        </Sheet>
      )}
    </div>
  );
}
