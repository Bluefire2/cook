/**
 * Collection writes for the MCP tools (`docs/plans/mcp-collection-writes.md`):
 * moving the member's own recipes between their own collections, and saving
 * a new recipe straight into one.
 *
 * Same membership rule as the app (`moveRecipes` in
 * `src/lib/collectionMembership.ts`, which the server cannot import): a
 * recipe belongs to at most one collection, so a move appends the ids to the
 * destination (ids it already lists keep their place) and removes them from
 * every other live collection. `UNFILED` as the destination only removes.
 *
 * A destination with a live public link is refused: anyone on the web reads
 * it, and the model asking may be steered by an imported page. Collections
 * shared with members are allowed, and the outcome counts their live grants.
 *
 * `planCollectionMove` is pure; the two transactions below it are I/O.
 */
import type { DocumentReference, Transaction } from '@google-cloud/firestore';
import { winningMembership } from '../agent/index.ts';
import { grantColRef, isLiveGrant, parseGrantDoc } from '../grants.ts';
import { hasLivePublicLinkInTransaction } from '../publicLinks.ts';
import {
  collectionDocRef,
  collectionsColRef,
  getStoreFirestore,
  isLiveDoc,
  MAX_COLLECTION_RECIPE_IDS,
  nextRecipeUpdatedAt,
  recipeDocBody,
  recipeDocRef,
} from '../store.ts';

/** The pseudo-collection for recipes in none, as `list_collections` and `search_recipes` name it. */
export const UNFILED = 'unfiled';

type StoredCollection = Record<string, unknown> & { id: string };

export type CollectionMovePlan =
  | {
      kind: 'ok';
      /** Whole replacement documents for each collection that changes. */
      writes: { id: string; doc: Record<string, unknown> }[];
      /** Ids whose collection changes. */
      moved: string[];
      /** Ids already where they were sent. */
      alreadyThere: string[];
      /** The destination's name, or undefined for Unfiled. */
      collectionName?: string;
    }
  | { kind: 'collection_not_found' }
  | { kind: 'collection_full'; max: number };

function storedRecipeIds(doc: Record<string, unknown>): string[] {
  return Array.isArray(doc.recipeIds) ? doc.recipeIds.filter((id): id is string => typeof id === 'string') : [];
}

function storedUpdatedAt(doc: Record<string, unknown>): number {
  return typeof doc.updatedAt === 'number' && Number.isFinite(doc.updatedAt) ? doc.updatedAt : 0;
}

/**
 * The collection writes that move `recipeIds` to `dest`. `collections` is
 * every stored collection document of the member (tombstones are skipped).
 * Each changed collection keeps its other fields and gets a server-stamped
 * `updatedAt` above its stored one, so the write wins last-write-wins.
 */
export function planCollectionMove(
  collections: readonly StoredCollection[],
  recipeIds: readonly string[],
  dest: string,
  now: number,
): CollectionMovePlan {
  const moving = [...new Set(recipeIds)];
  const live = collections.filter((doc) => isLiveDoc(doc));
  const destination = dest === UNFILED ? undefined : live.find((doc) => doc.id === dest);
  if (dest !== UNFILED && destination === undefined) {
    return { kind: 'collection_not_found' };
  }

  const before = winningMembership(live.map((doc) => ({ id: doc.id, name: '', recipeIds: storedRecipeIds(doc) })));
  const target = destination?.id;
  const moved = moving.filter((id) => before.get(id) !== target);
  const alreadyThere = moving.filter((id) => before.get(id) === target);

  const movingSet = new Set(moving);
  const writes: { id: string; doc: Record<string, unknown> }[] = [];
  for (const doc of live) {
    const current = storedRecipeIds(doc);
    let next: string[];
    if (doc.id === target) {
      const present = new Set(current);
      const appended = moving.filter((id) => !present.has(id));
      if (appended.length === 0) continue;
      next = [...current, ...appended];
      if (next.length > MAX_COLLECTION_RECIPE_IDS) {
        return { kind: 'collection_full', max: MAX_COLLECTION_RECIPE_IDS };
      }
    } else {
      if (!current.some((id) => movingSet.has(id))) continue;
      next = current.filter((id) => !movingSet.has(id));
    }
    const written: Record<string, unknown> = {
      ...doc,
      recipeIds: next,
      updatedAt: nextRecipeUpdatedAt(storedUpdatedAt(doc), now),
      serverUpdatedAt: now,
    };
    delete written.deletedAt;
    writes.push({ id: doc.id, doc: written });
  }

  const plan: CollectionMovePlan = { kind: 'ok', writes, moved, alreadyThere };
  if (destination !== undefined && typeof destination.name === 'string') {
    plan.collectionName = destination.name;
  }
  return plan;
}

export type CollectionWriteOutcome =
  | {
      kind: 'ok';
      moved: string[];
      alreadyThere: string[];
      collectionName?: string;
      /** Live member grants on the destination: who else now sees these recipes. */
      sharedWithMembers: number;
    }
  | { kind: 'recipes_not_found'; missingIds: string[] }
  | { kind: 'collection_not_found' }
  | { kind: 'collection_full'; max: number }
  | { kind: 'public_collection' };

type DestinationChecks = { kind: 'public_collection' } | { kind: 'ok'; sharedWithMembers: number };

/** Reads the destination's public link and grants inside `tx`. Reads only. */
async function checkDestination(tx: Transaction, uid: string, dest: string): Promise<DestinationChecks> {
  if (dest === UNFILED) return { kind: 'ok', sharedWithMembers: 0 };
  if (await hasLivePublicLinkInTransaction(tx, uid, dest)) return { kind: 'public_collection' };
  const grants = await tx.get(grantColRef(uid, dest));
  const sharedWithMembers = grants.docs.filter((doc) => isLiveGrant(parseGrantDoc(doc.data(), doc.id))).length;
  return { kind: 'ok', sharedWithMembers };
}

async function readCollections(tx: Transaction, uid: string): Promise<StoredCollection[]> {
  const snap = await tx.get(collectionsColRef(uid));
  return snap.docs.map((doc) => ({ ...(doc.data() as Record<string, unknown>), id: doc.id }));
}

function writeCollections(
  tx: Transaction,
  uid: string,
  writes: readonly { id: string; doc: Record<string, unknown> }[],
): void {
  for (const { id, doc } of writes) {
    tx.set(collectionDocRef(uid, id), doc, { merge: false });
  }
}

/**
 * Moves the member's own live recipes to `dest` (a collection id or
 * `UNFILED`), all or nothing. `recipeIds` must already be valid document ids.
 * Recipe documents are not written.
 */
export async function moveOwnRecipes(
  uid: string,
  recipeIds: readonly string[],
  dest: string,
  now: number,
): Promise<CollectionWriteOutcome> {
  const ids = [...new Set(recipeIds)];
  return getStoreFirestore().runTransaction(async (tx): Promise<CollectionWriteOutcome> => {
    const refs: DocumentReference[] = ids.map((id) => recipeDocRef(uid, id));
    const snaps = await tx.getAll(...refs);
    const missingIds = ids.filter((_, i) => {
      const snap = snaps[i];
      return !snap?.exists || !isLiveDoc(snap.data() as Record<string, unknown>);
    });
    if (missingIds.length > 0) return { kind: 'recipes_not_found', missingIds };
    const plan = planCollectionMove(await readCollections(tx, uid), ids, dest, now);
    if (plan.kind !== 'ok') return plan;
    const checks = await checkDestination(tx, uid, dest);
    if (checks.kind !== 'ok') return checks;
    writeCollections(tx, uid, plan.writes);
    return {
      kind: 'ok',
      moved: plan.moved,
      alreadyThere: plan.alreadyThere,
      ...(plan.collectionName === undefined ? {} : { collectionName: plan.collectionName }),
      sharedWithMembers: checks.sharedWithMembers,
    };
  });
}

/**
 * Saves a new recipe and files it into `dest` in one transaction, so a
 * refused destination leaves no stray Unfiled recipe. `payload` is the
 * validated recipe; the document is written with `create`, so an id that
 * already exists fails instead of overwriting.
 */
export async function createOwnRecipeInCollection(
  uid: string,
  id: string,
  payload: Record<string, unknown>,
  dest: string,
  now: number,
): Promise<CollectionWriteOutcome> {
  return getStoreFirestore().runTransaction(async (tx): Promise<CollectionWriteOutcome> => {
    const plan = planCollectionMove(await readCollections(tx, uid), [id], dest, now);
    if (plan.kind !== 'ok') return plan;
    const checks = await checkDestination(tx, uid, dest);
    if (checks.kind !== 'ok') return checks;
    tx.create(recipeDocRef(uid, id), recipeDocBody(payload, id, now, now));
    writeCollections(tx, uid, plan.writes);
    return {
      kind: 'ok',
      moved: plan.moved,
      alreadyThere: plan.alreadyThere,
      ...(plan.collectionName === undefined ? {} : { collectionName: plan.collectionName }),
      sharedWithMembers: checks.sharedWithMembers,
    };
  });
}
