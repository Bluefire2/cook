import { useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { collectionStore, useCollections } from '../../lib/collectionStore';
import { winningMembership } from '../../lib/collectionMembership';
import { useRecipes } from '../../lib/recipeStore';
import { primaryBtn } from '../../lib/uiClasses';
import {
  beginMoveApply,
  dispatch,
  endMoveApply,
  getAgentSnapshot,
  type MoveApplyStatus,
} from '../store';
import type { CollectionMoveData } from './parse';

function previewFromLabel(
  from: CollectionMoveData['preview'][number]['from'],
  tr: ReturnType<typeof useT>,
): string {
  if (from.kind === 'unfiled') {
    return tr('library.recipes');
  }
  return from.name;
}

function resolveRow(
  recipeId: string,
  data: CollectionMoveData,
  recipes: readonly { id: string; title: string }[] | undefined,
  collections: readonly { id: string; name: string }[] | undefined,
  membership: Map<string, string>,
  tr: ReturnType<typeof useT>,
): { title: string; fromLabel: string } {
  const preview = data.preview.find((row) => row.id === recipeId);
  const recipe = recipes?.find((r) => r.id === recipeId);
  const title = recipe?.title ?? preview?.title ?? recipeId;

  const collectionId = membership.get(recipeId);
  if (collectionId === undefined) {
    return {
      title,
      fromLabel: preview ? previewFromLabel(preview.from, tr) : tr('library.recipes'),
    };
  }
  const collection = collections?.find((c) => c.id === collectionId);
  if (collection) {
    return { title, fromLabel: collection.name };
  }
  if (preview) {
    return { title, fromLabel: previewFromLabel(preview.from, tr) };
  }
  return { title, fromLabel: tr('library.recipes') };
}

export default function CollectionMoveCard({
  data,
  cardId,
  apply,
}: {
  data: CollectionMoveData;
  cardId: string;
  apply?: MoveApplyStatus;
  checked?: Record<string, true>;
  onToggle?: (itemKey: string) => void;
}) {
  const tr = useT();
  const recipes = useRecipes();
  const collections = useCollections();
  const [expanded, setExpanded] = useState(false);

  const membership = useMemo(
    () => (collections ? winningMembership(collections) : new Map<string, string>()),
    [collections],
  );

  const libraryReady = recipes !== undefined && collections !== undefined;
  const count = data.total;
  const destName =
    data.destination.kind === 'collection' ? data.destination.name : undefined;

  const heading =
    data.destination.kind === 'collection'
      ? tr('assistant.moveHeadingToCollection', { count, name: destName ?? '' })
      : tr('assistant.moveHeadingToRecipes', { count });

  const appliedLine =
    apply?.phase === 'applied'
      ? data.destination.kind === 'collection'
        ? tr('assistant.moveAppliedToCollection', {
            count: apply.moved,
            name: destName ?? '',
          })
        : tr('assistant.moveAppliedToRecipes', { count: apply.moved })
      : null;

  const rows = expanded ? data.recipeIds : data.preview.map((row) => row.id);
  const moreCount = data.total - data.preview.length;

  const applying = apply?.phase === 'applying';
  const applied = apply?.phase === 'applied';
  const errorMessage = apply?.phase === 'error' ? apply.message : null;

  const buttonDisabled = !libraryReady || applying || applied;

  let buttonLabel = tr('assistant.move');
  if (applying) {
    buttonLabel = tr('assistant.moving');
  } else if (applied && appliedLine) {
    buttonLabel = appliedLine;
  }

  const onMove = async () => {
    if (!libraryReady) {
      return;
    }
    if (!beginMoveApply()) {
      return;
    }
    dispatch({ type: 'beginMoveApply', cardId });
    const dest = data.destination.kind === 'unfiled' ? 'default' : data.destination.id;
    try {
      const result = await collectionStore.moveRecipes(data.recipeIds, dest);
      if (getAgentSnapshot().messages.some((m) => m.cards?.some((c) => c.id === cardId))) {
        dispatch({
          type: 'finishMoveApply',
          cardId,
          status: { phase: 'applied', moved: result.moved },
        });
      }
    } catch (err) {
      if (getAgentSnapshot().messages.some((m) => m.cards?.some((c) => c.id === cardId))) {
        const message = err instanceof Error ? err.message : tr('error.collectionSave');
        dispatch({
          type: 'finishMoveApply',
          cardId,
          status: { phase: 'error', message },
        });
      }
    } finally {
      endMoveApply();
    }
  };

  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-3">
      <h3 className="font-semibold text-ink">{heading}</h3>
      <p className="mt-1 text-sm text-ink-muted">{tr('assistant.moveLeaveCurrentCollections')}</p>
      <ul className="mt-2 space-y-1">
        {rows.map((recipeId) => {
          const row = resolveRow(recipeId, data, recipes, collections, membership, tr);
          return (
            <li key={recipeId} className="flex justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-ink">{row.title}</span>
              <span className="shrink-0 text-ink-muted">{row.fromLabel}</span>
            </li>
          );
        })}
      </ul>
      {!expanded && moreCount > 0 && (
        <p className="mt-1 text-sm text-ink-muted">
          {tr('assistant.moveAndMore', { count: moreCount })}
        </p>
      )}
      {data.recipeIds.length > data.preview.length && (
        <button
          type="button"
          className="mt-2 text-sm text-accent hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? tr('assistant.moveShowLess') : tr('assistant.moveShowAll')}
        </button>
      )}
      {errorMessage !== null && (
        <p className="mt-2 text-sm text-danger">{errorMessage}</p>
      )}
      <button
        type="button"
        disabled={buttonDisabled}
        onClick={() => {
          void onMove();
        }}
        className={`mt-3 px-4 py-2 text-sm disabled:opacity-50 ${primaryBtn}`}
      >
        {buttonLabel}
      </button>
    </div>
  );
}
