import { MAX_COLLECTION_RECIPE_IDS } from '../../../store.ts';
import type { CardSpec } from '../../harness/types.ts';
import type { AgentCollection, AgentLibrary } from '../library.ts';
import { winningMembership } from '../library.ts';

export type CollectionMoveDestination =
  | { kind: 'collection'; id: string; name: string }
  | { kind: 'unfiled' };

export type CollectionMovePreviewFrom =
  | { kind: 'collection'; name: string }
  | { kind: 'unfiled' };

export type CollectionMoveData = {
  destination: CollectionMoveDestination;
  recipeIds: string[];
  preview: {
    id: string;
    title: string;
    from: CollectionMovePreviewFrom;
  }[];
  total: number;
};

const PREVIEW_LIMIT = 8;
const TITLE_MAX = 120;
const MAX_EXPLICIT_IDS = 100;
const UNFILED_NAME_ALIASES = new Set(['recipes', 'unfiled']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sliceTitle(title: string): string {
  if (title.length <= TITLE_MAX) {
    return title;
  }
  return title.slice(0, TITLE_MAX);
}

function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function previewFromForRecipe(
  recipeId: string,
  membership: Map<string, string>,
  collectionById: Map<string, AgentCollection>,
): CollectionMovePreviewFrom {
  const collectionId = membership.get(recipeId);
  if (!collectionId) {
    return { kind: 'unfiled' };
  }
  const collection = collectionById.get(collectionId);
  const name = collection?.name && collection.name !== '' ? collection.name : collectionId;
  return { kind: 'collection', name };
}

function isInDestination(
  recipeId: string,
  destination: CollectionMoveDestination,
  membership: Map<string, string>,
): boolean {
  const winner = membership.get(recipeId);
  if (destination.kind === 'unfiled') {
    return winner === undefined;
  }
  return winner === destination.id;
}

type ResolvedDestination =
  | { ok: true; destination: CollectionMoveDestination; collection?: AgentCollection }
  | { ok: false; error: string };

function resolveDestination(
  args: Record<string, unknown>,
  collections: readonly AgentCollection[],
): ResolvedDestination {
  const hasCollectionId = args.collectionId !== undefined;
  const hasName = args.name !== undefined;
  const hasUnfiled = args.unfiled === true;

  let destCount = 0;
  if (hasCollectionId) {
    destCount += 1;
  }
  if (hasName) {
    destCount += 1;
  }
  if (hasUnfiled) {
    destCount += 1;
  }
  if (destCount !== 1) {
    return { ok: false, error: 'invalid payload' };
  }

  if (hasUnfiled) {
    return { ok: true, destination: { kind: 'unfiled' } };
  }

  if (hasCollectionId) {
    const rawId = args.collectionId;
    if (typeof rawId !== 'string' || rawId === '') {
      return { ok: false, error: 'invalid payload' };
    }
    if (normalizeNameKey(rawId) === 'unfiled') {
      return { ok: true, destination: { kind: 'unfiled' } };
    }
    const collection = collections.find((c) => c.id === rawId);
    if (!collection) {
      return { ok: false, error: 'unknown collection' };
    }
    const name = collection.name !== '' ? collection.name : collection.id;
    return {
      ok: true,
      destination: { kind: 'collection', id: collection.id, name },
      collection,
    };
  }

  const nameRaw = args.name;
  if (typeof nameRaw !== 'string' || nameRaw.trim() === '') {
    return { ok: false, error: 'invalid payload' };
  }
  const key = normalizeNameKey(nameRaw);
  const ownedNames = collections.map((c) => c.name);
  const matches = collections.filter((c) => normalizeNameKey(c.name) === key);
  if (matches.length > 1) {
    const names = matches.map((c) => (c.name !== '' ? c.name : c.id)).join(', ');
    return { ok: false, error: `ambiguous collection name; matches: ${names}` };
  }
  if (matches.length === 1) {
    const collection = matches[0]!;
    const name = collection.name !== '' ? collection.name : collection.id;
    return {
      ok: true,
      destination: { kind: 'collection', id: collection.id, name },
      collection,
    };
  }
  if (UNFILED_NAME_ALIASES.has(key)) {
    return { ok: true, destination: { kind: 'unfiled' } };
  }
  const listed =
    ownedNames.filter((n) => n !== '').join(', ') ||
    '(no named collections)';
  return {
    ok: false,
    error: `no owned collection named "${nameRaw.trim()}"; owned collections: ${listed}. Shared collections cannot be destinations.`,
  };
}

function selectRecipeIds(
  args: Record<string, unknown>,
  ctx: AgentLibrary,
  membership: Map<string, string>,
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const hasAll = args.all === true;
  const hasRecipeIds = args.recipeIds !== undefined;
  const hasFrom = args.fromCollectionId !== undefined;

  let selCount = 0;
  if (hasAll) {
    selCount += 1;
  }
  if (hasRecipeIds) {
    selCount += 1;
  }
  if (hasFrom) {
    selCount += 1;
  }
  if (selCount !== 1) {
    return { ok: false, error: 'invalid payload' };
  }

  if (hasAll) {
    if (ctx.loadTruncated) {
      return { ok: false, error: 'library load was truncated; cannot select all recipes' };
    }
    return { ok: true, ids: ctx.recipes.map((r) => r.id) };
  }

  if (hasFrom) {
    if (ctx.loadTruncated) {
      return {
        ok: false,
        error: 'library load was truncated; cannot select by collection',
      };
    }
    const fromRaw = args.fromCollectionId;
    if (typeof fromRaw !== 'string' || fromRaw === '') {
      return { ok: false, error: 'invalid payload' };
    }
    const fromUnfiled = normalizeNameKey(fromRaw) === 'unfiled';
    const ids: string[] = [];
    for (const recipe of ctx.recipes) {
      const winner = membership.get(recipe.id);
      if (fromUnfiled) {
        if (!winner) {
          ids.push(recipe.id);
        }
      } else if (winner === fromRaw) {
        ids.push(recipe.id);
      }
    }
    return { ok: true, ids };
  }

  const recipeIdsRaw = args.recipeIds;
  if (!Array.isArray(recipeIdsRaw) || recipeIdsRaw.length < 1 || recipeIdsRaw.length > MAX_EXPLICIT_IDS) {
    return { ok: false, error: 'recipeIds must be 1–100' };
  }
  const ids: string[] = [];
  for (const id of recipeIdsRaw) {
    if (typeof id !== 'string' || id === '') {
      return { ok: false, error: 'invalid recipe id' };
    }
    if (!ctx.recipeById(id)) {
      return { ok: false, error: 'unknown recipe id' };
    }
    ids.push(id);
  }
  return { ok: true, ids };
}

function buildMoveData(
  destination: CollectionMoveDestination,
  moveIds: string[],
  ctx: AgentLibrary,
  membership: Map<string, string>,
  collectionById: Map<string, AgentCollection>,
): CollectionMoveData {
  const preview = moveIds.slice(0, PREVIEW_LIMIT).map((id) => {
    const recipe = ctx.recipeById(id)!;
    return {
      id,
      title: sliceTitle(recipe.title),
      from: previewFromForRecipe(id, membership, collectionById),
    };
  });
  return {
    destination,
    recipeIds: moveIds,
    preview,
    total: moveIds.length,
  };
}

function unionWouldExceedCap(
  destinationCollection: AgentCollection,
  moveIds: string[],
): boolean {
  const set = new Set(destinationCollection.recipeIds);
  for (const id of moveIds) {
    set.add(id);
  }
  return set.size > MAX_COLLECTION_RECIPE_IDS;
}

export function normalizeCollectionMove(
  args: unknown,
  ctx: AgentLibrary,
): { ok: true; data: CollectionMoveData } | { ok: false; error: string } {
  if (!isPlainObject(args)) {
    return { ok: false, error: 'invalid payload' };
  }

  const membership = winningMembership(ctx.collections);
  const collectionById = new Map(ctx.collections.map((c) => [c.id, c]));

  const destResult = resolveDestination(args, ctx.collections);
  if (!destResult.ok) {
    return destResult;
  }
  const { destination, collection: destCollection } = destResult;

  const selResult = selectRecipeIds(args, ctx, membership);
  if (!selResult.ok) {
    return selResult;
  }

  const moveIds = selResult.ids.filter((id) => !isInDestination(id, destination, membership));

  if (moveIds.length === 0) {
    return { ok: false, error: 'selected recipes are already in the destination' };
  }

  if (moveIds.length > MAX_COLLECTION_RECIPE_IDS) {
    return { ok: false, error: 'move exceeds 500 recipe limit' };
  }

  if (destination.kind === 'collection' && destCollection) {
    if (unionWouldExceedCap(destCollection, moveIds)) {
      return { ok: false, error: 'destination collection would exceed 500 recipes' };
    }
  }

  return {
    ok: true,
    data: buildMoveData(destination, moveIds, ctx, membership, collectionById),
  };
}

function isValidDataShape(data: unknown): data is CollectionMoveData {
  if (!isPlainObject(data)) {
    return false;
  }
  const dest = data.destination;
  if (!isPlainObject(dest)) {
    return false;
  }
  if (dest.kind === 'unfiled') {
    // ok
  } else if (dest.kind === 'collection') {
    if (typeof dest.id !== 'string' || dest.id === '' || typeof dest.name !== 'string') {
      return false;
    }
  } else {
    return false;
  }
  if (!Array.isArray(data.recipeIds)) {
    return false;
  }
  if (data.recipeIds.length > MAX_COLLECTION_RECIPE_IDS) {
    return false;
  }
  for (const id of data.recipeIds) {
    if (typeof id !== 'string' || id === '') {
      return false;
    }
  }
  if (!Array.isArray(data.preview) || data.preview.length > PREVIEW_LIMIT) {
    return false;
  }
  for (const row of data.preview) {
    if (!isPlainObject(row) || typeof row.id !== 'string' || typeof row.title !== 'string') {
      return false;
    }
    if (row.title.length > TITLE_MAX) {
      return false;
    }
    if (!isPlainObject(row.from)) {
      return false;
    }
  }
  if (typeof data.total !== 'number' || data.total !== data.recipeIds.length) {
    return false;
  }
  return true;
}

export function revalidateCollectionMove(
  data: unknown,
  ctx: AgentLibrary,
): { ok: true; data: CollectionMoveData } | { ok: false; error: string } {
  if (!isValidDataShape(data)) {
    return { ok: false, error: 'invalid card data' };
  }

  for (const id of data.recipeIds) {
    if (!ctx.recipeById(id)) {
      return { ok: false, error: 'recipe no longer in library' };
    }
  }

  const currentDestination = data.destination;
  let destination = currentDestination;
  if (currentDestination.kind === 'collection') {
    const destinationId = currentDestination.id;
    const collection = ctx.collections.find((c) => c.id === destinationId);
    if (!collection) {
      return { ok: false, error: 'destination collection no longer exists' };
    }
    const name = collection.name !== '' ? collection.name : collection.id;
    destination = { kind: 'collection', id: collection.id, name };
  }

  return {
    ok: true,
    data: {
      destination,
      recipeIds: data.recipeIds,
      preview: data.preview,
      total: data.total,
    },
  };
}

export function collectionMoveHistoryText(data: CollectionMoveData): string {
  const destLabel =
    data.destination.kind === 'unfiled'
      ? 'Recipes'
      : data.destination.name;
  return `Proposed moving ${data.total} recipes into ${destLabel}. Not confirmed. Call list_collections for the current membership.`;
}

export const collectionMoveCard: CardSpec<AgentLibrary, CollectionMoveData> = {
  type: 'collection_move',
  version: 1,
  toolName: 'propose_collection_move',
  description:
    'Propose moving owned recipes into an existing collection or back to unfiled. The user must confirm on the card.',
  parameters: {
    type: 'object',
    properties: {
      all: { type: 'boolean', description: 'Move every recipe in the library.' },
      recipeIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Move 1–100 recipe ids.',
      },
      fromCollectionId: {
        type: 'string',
        description: 'Move recipes whose winning collection is this id, or unfiled.',
      },
      collectionId: { type: 'string', description: 'Destination collection id, or unfiled.' },
      name: { type: 'string', description: 'Destination collection name (owned only).' },
      unfiled: { type: 'boolean', description: 'Move recipes back to unfiled.' },
    },
  },
  rule:
    'Call list_collections first; use this tool to file or unfile; pass collectionId when list_collections already returned one; treat Recipes / Unfiled / no collection as unfiled only when no owned collection has that name; pass all:true for every owned recipe and fromCollectionId for one source collection; do not claim the move already happened; a missing name cannot be created from the assistant.',
  normalize: normalizeCollectionMove,
  revalidate: revalidateCollectionMove,
  historyText: collectionMoveHistoryText,
};
