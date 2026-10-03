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
 * `planCollectionMove` and `runCollectionWrite` (over a `CollectionTxPort`)
 * are pure enough to test; `moveOwnRecipes` and `createOwnRecipeInCollection`
 * run them in a Firestore transaction.
 */
import type { Transaction } from '@google-cloud/firestore';
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
      /**
       * Members the destination is shared with (live grants), who now see
       * these recipes. People who join later through a collection link are
       * not counted.
       */
      sharedWithMembers: number;
    }
  | { kind: 'recipes_not_found'; missingIds: string[] }
  | { kind: 'collection_not_found' }
  | { kind: 'collection_full'; max: number }
  | { kind: 'public_collection' };

/**
 * The reads and writes of one collection-write transaction. The Firestore
 * port wraps a single `Transaction`, so every call through it is inside that
 * transaction; tests use a recording fake that refuses a read after a write.
 */
export interface CollectionTxPort {
  /** The member's recipe documents for `ids`, in order; undefined when missing. */
  readRecipes(ids: readonly string[]): Promise<Array<Record<string, unknown> | undefined>>;
  /** Every stored collection document of the member, tombstones included. */
  readCollections(): Promise<StoredCollection[]>;
  /** Whether `dest` has a live public link. Fails closed on any matching row. */
  hasLivePublicLink(dest: string): Promise<boolean>;
  /** Live member grants on `dest`. */
  countLiveGrants(dest: string): Promise<number>;
  /** `create`, never `set`: an existing id fails instead of being overwritten. */
  createRecipe(id: string, doc: Record<string, unknown>): void;
  setCollection(id: string, doc: Record<string, unknown>): void;
}

function firestorePort(tx: Transaction, uid: string): CollectionTxPort {
  return {
    async readRecipes(ids) {
      if (ids.length === 0) return [];
      const snaps = await tx.getAll(...ids.map((id) => recipeDocRef(uid, id)));
      return snaps.map((snap) => (snap.exists ? (snap.data() as Record<string, unknown>) : undefined));
    },
    async readCollections() {
      const snap = await tx.get(collectionsColRef(uid));
      return snap.docs.map((doc) => ({ ...(doc.data() as Record<string, unknown>), id: doc.id }));
    },
    hasLivePublicLink: (dest) => hasLivePublicLinkInTransaction(tx, uid, dest),
    async countLiveGrants(dest) {
      const grants = await tx.get(grantColRef(uid, dest));
      return grants.docs.filter((doc) => isLiveGrant(parseGrantDoc(doc.data(), doc.id))).length;
    },
    createRecipe(id, doc) {
      tx.create(recipeDocRef(uid, id), doc);
    },
    setCollection(id, doc) {
      tx.set(collectionDocRef(uid, id), doc, { merge: false });
    },
  };
}

/** A new recipe to save with the move: its id and its validated payload. */
export type NewRecipe = { id: string; payload: Record<string, unknown> };

/**
 * One collection write, all reads first: the recipes being moved (each must
 * be live in the member's tree), the collections, then the destination's
 * public link and grants. Writes happen only when every check passed.
 * `serverNow` is read inside the transaction attempt, so a retried attempt
 * never stamps a time older than writes that committed before it.
 */
export async function runCollectionWrite(
  port: CollectionTxPort,
  input: { moveIds: readonly string[]; create?: NewRecipe; dest: string; serverNow: number },
): Promise<CollectionWriteOutcome> {
  const moveIds = [...new Set(input.moveIds)];
  const stored = await port.readRecipes(moveIds);
  const missingIds = moveIds.filter((_, i) => !isLiveDoc(stored[i]));
  if (missingIds.length > 0) return { kind: 'recipes_not_found', missingIds };
  const filing = input.create === undefined ? moveIds : [...moveIds, input.create.id];
  const plan = planCollectionMove(await port.readCollections(), filing, input.dest, input.serverNow);
  if (plan.kind !== 'ok') return plan;
  let sharedWithMembers = 0;
  if (input.dest !== UNFILED) {
    if (await port.hasLivePublicLink(input.dest)) return { kind: 'public_collection' };
    sharedWithMembers = await port.countLiveGrants(input.dest);
  }
  if (input.create !== undefined) {
    const { id, payload } = input.create;
    const updatedAt = typeof payload.updatedAt === 'number' ? payload.updatedAt : input.serverNow;
    port.createRecipe(id, recipeDocBody(payload, id, updatedAt, input.serverNow));
  }
  for (const { id, doc } of plan.writes) port.setCollection(id, doc);
  return {
    kind: 'ok',
    moved: plan.moved,
    alreadyThere: plan.alreadyThere,
    ...(plan.collectionName === undefined ? {} : { collectionName: plan.collectionName }),
    sharedWithMembers,
  };
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
): Promise<CollectionWriteOutcome> {
  return getStoreFirestore().runTransaction((tx) =>
    runCollectionWrite(firestorePort(tx, uid), { moveIds: recipeIds, dest, serverNow: Date.now() }),
  );
}

/**
 * Saves a new recipe and files it into `dest` in one transaction, so a
 * refused destination leaves no stray Unfiled recipe. `payload` is the
 * validated recipe, whose `updatedAt` is the version the tool returns.
 */
export async function createOwnRecipeInCollection(
  uid: string,
  id: string,
  payload: Record<string, unknown>,
  dest: string,
): Promise<CollectionWriteOutcome> {
  return getStoreFirestore().runTransaction((tx) =>
    runCollectionWrite(firestorePort(tx, uid), { moveIds: [], create: { id, payload }, dest, serverNow: Date.now() }),
  );
}
