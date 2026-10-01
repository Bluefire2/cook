import { useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useT } from '../i18n';
import { libraryHref } from '../lib/collectionHref';
import { collectionStore, useCollections } from '../lib/collectionStore';
import { FolderIcon, SharedIcon } from '../lib/icons';
import type { Collection } from '../lib/types';

function chipClass(active: boolean): string {
  return active
    ? 'shrink-0 rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-page'
    : 'shrink-0 rounded-full bg-surface-muted px-3 py-1.5 text-sm text-ink-muted hover:bg-surface hover:text-ink';
}

function edgeMask(lead: boolean, trail: boolean): string | undefined {
  if (!lead && !trail) return undefined;
  const left = lead ? 'transparent, #000 1.25rem' : '#000';
  const right = trail ? '#000 calc(100% - 1.25rem), transparent' : '#000';
  return `linear-gradient(to right, ${left}, ${right})`;
}

/**
 * Collections on the library: a label and one sideways row of names, on the
 * page background. See docs/plans/library-collections-region.md.
 */
export default function CollectionSection({
  collections,
  currentId,
  browseAll,
  showOwnedActions,
  onCreate,
  onShare,
  onRename,
  onDelete,
  onOpenList,
}: {
  collections: readonly Collection[];
  currentId: string | undefined;
  browseAll: boolean;
  showOwnedActions: boolean;
  onCreate: () => void;
  onShare: () => void;
  onRename: () => void;
  onDelete: () => void;
  /** Clears “all collections” browsing when a chip is chosen. */
  onOpenList: () => void;
}) {
  const t = useT();
  const location = useLocation();
  // Shared labels read collection origins. useCollections subscribes to that
  // map; the list itself is the one Library already sorted.
  useCollections();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLAnchorElement>(null);
  const [edges, setEdges] = useState({ lead: false, trail: false });
  const selectedKey = browseAll ? '' : (currentId ?? '/');

  const revealChip = (event: FocusEvent<HTMLAnchorElement>) => {
    event.currentTarget.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  };

  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [selectedKey]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      const overflow = el.scrollWidth - el.clientWidth > 1;
      setEdges({
        lead: overflow && el.scrollLeft > 1,
        trail: overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      });
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [collections, selectedKey]);

  const mask = edgeMask(edges.lead, edges.trail);
  const recipesActive = !browseAll && currentId === undefined;

  return (
    <section className="mb-3" aria-labelledby="collections-label">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Link
          id="collections-label"
          to="/collections"
          state={{ from: location.pathname }}
          className="inline-flex min-w-0 items-center gap-1.5 text-sm font-semibold text-ink-muted hover:text-ink"
        >
          <FolderIcon className="block h-5 w-5 shrink-0" />
          {t('library.collectionsNav')}
        </Link>
        <button
          type="button"
          onClick={onCreate}
          className="shrink-0 rounded-full px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
        >
          {t('common.newCollection')}
        </button>
      </div>
      <div
        ref={scrollerRef}
        className="flex w-full min-w-0 gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={
          mask
            ? { maskImage: mask, WebkitMaskImage: mask, scrollPaddingInline: '1.25rem' }
            : undefined
        }
      >
        <Link
          to="/"
          ref={recipesActive ? selectedRef : undefined}
          onClick={onOpenList}
          onFocus={revealChip}
          className={chipClass(recipesActive)}
        >
          {t('library.recipes')}
        </Link>
        {collections.map((collection) => {
          const shared = collectionStore.isShared(collection.id);
          const sharedBy = shared ? collectionStore.sharedBy(collection.id) : undefined;
          const sharedLabel = sharedBy
            ? t('library.sharedByLabel', { name: collection.name, email: sharedBy })
            : t('library.sharedLabel', { name: collection.name });
          const active = !browseAll && collection.id === currentId;
          return (
            <Link
              key={collection.id}
              ref={active ? selectedRef : undefined}
              to={libraryHref(collection.id)}
              onClick={onOpenList}
              onFocus={revealChip}
              aria-label={shared ? sharedLabel : collection.name}
              title={shared ? sharedLabel : undefined}
              className={`${chipClass(active)} inline-flex items-center gap-1.5`}
            >
              {shared && <SharedIcon className="block h-3.5 w-3.5 shrink-0" />}
              {collection.name}
            </Link>
          );
        })}
      </div>
      {showOwnedActions && (
        <div className="mt-1 flex flex-wrap items-center">
          <button
            type="button"
            onClick={onShare}
            className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
          >
            {t('common.share')}
          </button>
          <button
            type="button"
            onClick={onRename}
            className="rounded-full px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
          >
            {t('library.rename')}
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-full px-3 py-1.5 text-sm text-danger hover:text-ink"
          >
            {t('common.delete')}
          </button>
        </div>
      )}
    </section>
  );
}
