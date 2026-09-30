import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useT } from '../i18n';
import LibraryInviteToast, {
  type LibraryInviteNotice,
} from '../components/LibraryInviteToast';
import ShareCollectionSheet from '../components/ShareCollectionSheet';
import Sheet from '../components/Sheet';
import { createInvite } from '../lib/adminApi';
import { createMemberInvite } from '../lib/inviteApi';
import { copyStrategy, inviteMintClient, isInviteQuotaError } from '../lib/inviteMint';
import { FolderIcon, PlusIcon, SettingsIcon, SharedIcon } from '../lib/icons';
import { importHref, libraryHref, newRecipeHref } from '../lib/collectionHref';
import { collectionStore, useCollections } from '../lib/collectionStore';
import { recipesInCollection, unfiledRecipes } from '../lib/collectionMembership';
import { initialLibraryFlow, libraryFlowReducer, sheetError } from '../lib/libraryFlow';
import {
  readPersistedLibraryView,
  writePersistedLibraryView,
} from '../lib/librarySearchMemory';
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
  const { status: sessionStatus, user } = useSession();
  const syncStatus = useSyncStatus();
  const { collectionId } = useParams();
  const navigate = useNavigate();
  const named =
    collectionId && collections
      ? collections.find((c) => c.id === collectionId)
      : undefined;
  const currentId = named?.id;

  // The collection the URL shows now. A save that finishes after the user has
  // moved on must not touch the sheets or the route of the collection they are on.
  const shownCollectionId = useRef(collectionId);
  const [query, setQuery] = useState(() => readPersistedLibraryView().query);
  const [browseAll, setBrowseAll] = useState(
    () => readPersistedLibraryView().browseAll,
  );
  useEffect(() => {
    writePersistedLibraryView({ query, browseAll });
  }, [query, browseAll]);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [flow, dispatch] = useReducer(libraryFlowReducer, initialLibraryFlow);
  const { sheet } = flow;
  // The flow as last rendered. An async submit compares its starting token
  // with this after each await, so a sheet the user closed or replaced
  // neither closes again nor navigates.
  const flowRef = useRef(flow);
  useLayoutEffect(() => {
    flowRef.current = flow;
  }, [flow]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [invitePending, setInvitePending] = useState(false);
  const [revealedUrl, setRevealedUrl] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [inviteNotice, setInviteNotice] = useState<LibraryInviteNotice | null>(null);
  const [inviteQuota, setInviteQuota] = useState<{ id: number; message: string } | null>(null);
  const inviteMountedRef = useRef(true);
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

  const pendingDelete =
    sheet.kind === 'deleteRecipe'
      ? allRecipes?.find((r) => r.id === sheet.recipeId)
      : undefined;
  const moveRecipe =
    sheet.kind === 'move' ? allRecipes?.find((r) => r.id === sheet.recipeId) : undefined;
  const collectionName = sheet.kind === 'create' || sheet.kind === 'rename' ? sheet.name : '';
  const collectionError = sheetError(sheet);
  const setCollectionName = (name: string) => dispatch({ type: 'setName', name });
  const isCurrent = (token: number) => flowRef.current.token === token;
  const namedIsShared = named ? collectionStore.isShared(named.id) : false;
  const showSwitcher = (collections?.length ?? 0) > 0;
  const addCollectionId =
    currentId && !namedIsShared ? currentId : undefined;
  const ownedCollections =
    collections?.filter((collection) => !collectionStore.isShared(collection.id)) ?? [];

  const remove = async (id: string) => {
    dispatch({ type: 'close' });
    setDeleteError(null);
    try {
      await recipeStore.remove(id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('error.recipeDelete'));
    }
  };

  const closeSheets = () => dispatch({ type: 'close' });

  const submitCreate = async () => {
    if (sheet.kind !== 'create') {
      return;
    }
    const { token } = flow;
    const { name, created, moveRecipeId } = sheet;
    const trimmed = name.trim();
    dispatch({ type: 'submitting', token });
    try {
      // Reuse the collection a failed attempt already created, so retrying
      // does not leave two folders with the same name behind.
      let id: string;
      if (created === undefined) {
        id = (await collectionStore.create(name)).id;
        dispatch({ type: 'created', token, created: { id, name: trimmed } });
      } else {
        id = created.id;
        if (created.name !== trimmed) {
          await collectionStore.rename(id, name);
          dispatch({ type: 'created', token, created: { id, name: trimmed } });
        }
      }
      if (moveRecipeId) {
        await collectionStore.moveRecipe(moveRecipeId, id);
      }
      if (!isCurrent(token)) return;
      closeSheets();
      navigate(libraryHref(id));
    } catch (err) {
      dispatch({
        type: 'failed',
        token,
        error: err instanceof Error ? err.message : t('error.collectionSave'),
      });
    }
  };

  const submitMove = async (dest: 'default' | string) => {
    if (sheet.kind !== 'move') {
      return;
    }
    const { token } = flow;
    dispatch({ type: 'submitting', token });
    try {
      await collectionStore.moveRecipe(sheet.recipeId, dest);
      if (!isCurrent(token)) return;
      closeSheets();
      navigate(dest === 'default' ? '/' : libraryHref(dest));
    } catch (err) {
      dispatch({
        type: 'failed',
        token,
        error: err instanceof Error ? err.message : t('error.collectionMove'),
      });
    }
  };

  const submitRename = async () => {
    if (sheet.kind !== 'rename') {
      return;
    }
    const { token } = flow;
    const startedOn = shownCollectionId.current;
    dispatch({ type: 'submitting', token });
    try {
      await collectionStore.rename(sheet.collectionId, sheet.name);
      if (shownCollectionId.current !== startedOn || !isCurrent(token)) return;
      closeSheets();
    } catch (err) {
      if (shownCollectionId.current !== startedOn) return;
      dispatch({
        type: 'failed',
        token,
        error: err instanceof Error ? err.message : t('error.collectionSave'),
      });
    }
  };

  const submitDeleteCollection = async () => {
    if (sheet.kind !== 'deleteCollection') {
      return;
    }
    const { token } = flow;
    const startedOn = shownCollectionId.current;
    dispatch({ type: 'submitting', token });
    try {
      await collectionStore.remove(sheet.collectionId);
      if (shownCollectionId.current !== startedOn || !isCurrent(token)) return;
      closeSheets();
      navigate('/');
    } catch (err) {
      if (shownCollectionId.current !== startedOn) return;
      dispatch({
        type: 'failed',
        token,
        error: err instanceof Error ? err.message : t('error.collectionDelete'),
      });
    }
  };

  const submitLeave = async () => {
    if (sheet.kind !== 'leave') {
      return;
    }
    const { token } = flow;
    const startedOn = shownCollectionId.current;
    dispatch({ type: 'submitting', token });
    try {
      await collectionStore.leave(sheet.collectionId);
      if (shownCollectionId.current !== startedOn || !isCurrent(token)) return;
      closeSheets();
      navigate('/');
    } catch (err) {
      if (shownCollectionId.current !== startedOn) return;
      dispatch({
        type: 'failed',
        token,
        error: err instanceof Error ? err.message : t('error.leaveCollection'),
      });
    }
  };

  useEffect(() => {
    inviteMountedRef.current = true;
    return () => {
      inviteMountedRef.current = false;
    };
  }, []);

  const showInviteToast = (kind: 'success' | 'error', message: string) => {
    setInviteNotice((prev) => ({
      id: (prev?.id ?? 0) + 1,
      kind,
      message,
    }));
  };

  const mint = async () => {
    if (user === null || invitePending) {
      return;
    }
    setInvitePending(true);
    const client = inviteMintClient(user);
    const urlPromise =
      client === 'admin'
        ? createInvite().then((created) => created.url)
        : createMemberInvite().then((created) => created.url);
    let writeStarted: Promise<void> | undefined;
    if (
      copyStrategy({ hasClipboardItem: typeof ClipboardItem !== 'undefined' }) ===
      'clipboard-item'
    ) {
      try {
        writeStarted = navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': urlPromise.then((u) => new Blob([u], { type: 'text/plain' })),
          }),
        ]);
        void writeStarted.catch(() => {});
      } catch {
        writeStarted = undefined;
      }
    }
    try {
      const url = await urlPromise;
      if (!inviteMountedRef.current) {
        return;
      }
      setInviteQuota(null);
      let copied = false;
      if (writeStarted !== undefined) {
        try {
          await writeStarted;
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (!copied) {
        try {
          await navigator.clipboard.writeText(url);
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (!inviteMountedRef.current) {
        return;
      }
      dispatch({ type: 'closeInviteConfirm' });
      if (copied) {
        setRevealedUrl(null);
        setInviteCopied(false);
        showInviteToast('success', t('library.inviteCopied'));
      } else {
        setRevealedUrl(url);
        setInviteCopied(false);
        showInviteToast('error', t('library.inviteCopyFailed'));
      }
    } catch (err) {
      if (!inviteMountedRef.current) {
        return;
      }
      const message = err instanceof Error ? err.message : t('common.somethingWentWrong');
      dispatch({ type: 'closeInviteConfirm' });
      if (isInviteQuotaError(err)) {
        setInviteQuota((prev) => ({ id: (prev?.id ?? 0) + 1, message }));
        return;
      }
      setInviteQuota(null);
      showInviteToast('error', message);
    } finally {
      if (inviteMountedRef.current) {
        setInvitePending(false);
      }
    }
  };

  const copyRevealedUrl = async () => {
    if (revealedUrl === null) {
      return;
    }
    const url = revealedUrl;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      if (!inviteMountedRef.current) {
        return;
      }
      setInviteCopied(false);
      return;
    }
    if (!inviteMountedRef.current) {
      return;
    }
    setRevealedUrl(null);
    setInviteCopied(true);
    showInviteToast('success', t('library.inviteCopied'));
  };

  // Library stays mounted across collection routes, so per-collection state
  // (open sheets, the typed name, scope) must not leak into the next one.
  useLayoutEffect(() => {
    if (shownCollectionId.current === collectionId) return;
    shownCollectionId.current = collectionId;
    setBrowseAll(false);
    setMenuId(null);
    setDeleteError(null);
    closeSheets();
  }, [collectionId]);

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
      // A rendered Sheet takes Escape first (capture phase) and stops it, so
      // this only clears a sheet state that rendered nothing, such as a
      // delete confirmation whose recipe vanished in a refresh.
      if (sheet.kind !== 'closed' && sheet.kind !== 'share') {
        event.preventDefault();
        closeSheets();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuId, sheet.kind]);

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
      <LibraryInviteToast notice={inviteNotice} />
      <header className="flex items-center justify-between py-4">
        <h1 className="text-2xl font-bold">Sous</h1>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
          {user !== null && (
            <button
              type="button"
              className={`${ghostBtn} disabled:opacity-40`}
              disabled={invitePending || sheet.kind === 'inviteConfirm'}
              onClick={() => {
                if (inviteMintClient(user) === 'member') {
                  dispatch({ type: 'openInviteConfirm' });
                  return;
                }
                void mint();
              }}
            >
              {invitePending ? t('admin.creating') : t('library.inviteLink')}
            </button>
          )}
          <Link to="/cooks" className={ghostBtn}>
            {t('library.cooks')}
          </Link>
          <Link
            to="/settings"
            className={`${ghostBtn} inline-flex items-center justify-center px-2 py-2`}
            aria-label={t('settings.title')}
          >
            <SettingsIcon className="block h-5 w-5" />
          </Link>
        </div>
      </header>

      {inviteQuota !== null && (
        <p key={inviteQuota.id} className="mb-3 text-sm text-danger" role="alert">
          {inviteQuota.message}
        </p>
      )}

      {revealedUrl !== null && (
        <div className="mb-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <label className="text-xs text-ink-muted" htmlFor="library-invite-url">
            {t('admin.newInviteLink')}
          </label>
          <input
            id="library-invite-url"
            className={`${inputClass} mt-1 font-mono text-sm`}
            readOnly
            value={revealedUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            onClick={() => void copyRevealedUrl()}
            className={`${secondaryBtn} mt-2 px-3 py-1.5 text-sm`}
          >
            {inviteCopied ? t('admin.copied') : t('admin.copy')}
          </button>
        </div>
      )}

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
              onClick={() => dispatch({ type: 'startCreate' })}
              className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
            >
              {t('library.new')}
            </button>
            {named && !namedIsShared && (
              <>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'openShare' })}
                  className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                >
                  {t('common.share')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    dispatch({ type: 'openRename', collectionId: named.id, name: named.name })
                  }
                  className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                >
                  {t('library.rename')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    dispatch({ type: 'openDeleteCollection', collectionId: named.id })
                  }
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
            onClick={() => dispatch({ type: 'openLeave', collectionId: named.id })}
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
                      dispatch({ type: 'openMove', recipeId: recipe.id });
                    }}
                    className={`${menuItem} border-t border-line`}
                  >
                    {t('library.moveTo')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuId(null);
                      dispatch({ type: 'openDeleteRecipe', recipeId: recipe.id });
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
          onClick={() => dispatch({ type: 'openAdd' })}
          className="fixed right-5 bottom-8 flex h-14 w-14 items-center justify-center rounded-full bg-ink text-page shadow-lg hover:opacity-90 active:opacity-90"
        >
          <PlusIcon className="block h-8 w-8" />
        </button>
      )}

      {sheet.kind === 'add' && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">{t('library.addRecipeTitle')}</h2>
          <Link
            to={importHref(addCollectionId)}
            className={`${primaryBtn} mt-3 block py-3 text-center`}
          >
            {t('library.importFromLink')}
          </Link>
          <Link
            to={newRecipeHref(addCollectionId)}
            className={`${secondaryBtn} mt-2 block py-3 text-center`}
          >
            {t('library.writeFromScratch')}
          </Link>
          <button
            type="button"
            onClick={() => closeSheets()}
            className="mt-2 w-full py-2.5 text-sm text-ink-muted hover:text-ink"
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}

      {pendingDelete && (
        <Sheet onClose={() => closeSheets()}>
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
            onClick={() => closeSheets()}
            className={`${secondaryBtn} mt-2 w-full py-3`}
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}

      {moveRecipe && (
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
            onClick={() => dispatch({ type: 'startCreate' })}
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

      {sheet.kind === 'create' && (
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

      {sheet.kind === 'rename' && named && (
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

      {sheet.kind === 'deleteCollection' && named && (
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

      {sheet.kind === 'leave' && named && namedIsShared && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">{t('library.leaveTitle', { name: named.name })}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('library.leaveBody')}</p>
          {collectionError && (
            <p className="mt-2 text-sm text-danger">{collectionError}</p>
          )}
          <button
            type="button"
            onClick={() => void submitLeave()}
            disabled={sheet.busy}
            className={`${dangerBtn} mt-3 w-full py-3`}
          >
            {sheet.busy ? t('library.leaving') : t('library.leaveCollection')}
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

      {sheet.kind === 'share' && named && !namedIsShared && (
        <ShareCollectionSheet
          collection={named}
          onClose={() => closeSheets()}
        />
      )}

      {sheet.kind === 'inviteConfirm' && user !== null && inviteMintClient(user) === 'member' && (
        <Sheet
          dismissible={!invitePending}
          onClose={() => {
            if (!invitePending) closeSheets();
          }}
        >
          <h2 className="text-lg font-semibold">{t('settings.inviteTitle')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('settings.inviteIntro')}</p>
          <button
            type="button"
            disabled={invitePending}
            className={`${primaryBtn} mt-3 w-full py-3`}
            onClick={() => {
              void mint();
            }}
          >
            {invitePending ? t('admin.creating') : t('admin.createLink')}
          </button>
          <button
            type="button"
            disabled={invitePending}
            className={`${secondaryBtn} mt-2 w-full py-3`}
            onClick={() => {
              if (!invitePending) dispatch({ type: 'closeInviteConfirm' });
            }}
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}
    </div>
  );
}
