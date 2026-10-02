/**
 * Account deletion: every Firestore collection Sous uses, whether it holds a
 * member's data, and how a deletion request removes it. `/privacy` promises
 * that a request covers all of it. The operator runs it through
 * `scripts/delete-account-data.ts` (README.md, "Manual deletion procedure"),
 * after the member's access is denied; photo bytes in GCS are a separate
 * `gcloud` step there.
 *
 * `FIRESTORE_COLLECTIONS` classifies every collection name the server and the
 * scripts use; `scripts/invariants.test.ts` fails when code uses one that is
 * not listed. `ACCOUNT_DELETION_STEPS` must have a step for every top-level
 * collection marked personal (TypeScript enforces it), and
 * `ACCOUNT_DELETION_ORDER` runs them: sharing first, because the owner side
 * reads the member's own tree, and `users` last.
 *
 * Kept on purpose: the member's opaque `sub` where it is another member's
 * record (`approvedBy` on members they approved or invited, `decidedBy` on
 * requests an owner decided, the `viewerSub` and `ownerSub` on sharing
 * tombstones, `sharedParentOwnerSub` on a viewer's own chat and cook rows),
 * and `redeemedAt` on an invite someone else minted, which still counts
 * toward that minter's limit. No email, name, or content of the member stays.
 */
import { FieldValue, type DocumentReference, type Firestore } from '@google-cloud/firestore';
import { isAllowed } from './allowlist.ts';
import {
  grantColRef,
  incomingShareCascadeDoc,
  incomingShareRef,
  incomingSharesCol,
  isLiveGrant,
  isSafeFirestoreDocumentId,
  parseGrantDoc,
  parseIncomingShareDoc,
  shareGrantId,
} from './grants.ts';
import { revokeGrantInFirestore } from './grantsHttp.ts';
import { chunkForBatch, getStoreFirestore } from './store.ts';

export type CollectionEntry =
  /** Holds a member's data; `ACCOUNT_DELETION_STEPS` has a step for it. */
  | { scope: 'top-level'; personal: true; holds: string }
  /** Holds nobody's personal data. */
  | { scope: 'top-level'; personal: false; holds: string }
  /** Removed with its parent's step. */
  | { scope: 'nested'; parent: string; holds: string };

export const FIRESTORE_COLLECTIONS = {
  users: {
    scope: 'top-level',
    personal: true,
    holds: 'The profile (email, name) and the whole library tree under users/{sub}.',
  },
  members: { scope: 'top-level', personal: true, holds: 'members/{sub}: the membership record and email.' },
  accessRequests: {
    scope: 'top-level',
    personal: true,
    holds: 'accessRequests/{sub}: the access request, email, and name.',
  },
  accessRequestMeta: {
    scope: 'top-level',
    personal: false,
    holds: 'A global daily counter of owner notifications.',
  },
  invites: {
    scope: 'top-level',
    personal: true,
    holds: 'Invite links: createdBy and createdByEmail of the minter, redeemedBy of the person admitted.',
  },
  collectionLinks: {
    scope: 'top-level',
    personal: true,
    holds: "Collection links: the owner's sub and email.",
  },
  importFeedback: { scope: 'top-level', personal: true, holds: 'Import reports, with the sender sub.' },
  featureRequests: { scope: 'top-level', personal: true, holds: 'Suggestions, with the sender sub.' },
  incomingShares: {
    scope: 'top-level',
    personal: true,
    holds: "incomingShares/{viewerSub}/items: a viewer's index of shares, with each owner's sub and email.",
  },
  mcpAuthCodes: { scope: 'top-level', personal: true, holds: 'MCP authorization codes, with the member sub.' },
  mcpTokens: { scope: 'top-level', personal: true, holds: 'MCP access and refresh tokens, with the member sub.' },

  recipes: { scope: 'nested', parent: 'users/{sub}', holds: 'Recipes.' },
  chatMessages: { scope: 'nested', parent: 'users/{sub}', holds: 'Ask messages.' },
  cookState: { scope: 'nested', parent: 'users/{sub}', holds: 'Cooking progress.' },
  photos: { scope: 'nested', parent: 'users/{sub}', holds: 'Photo metadata (bytes are in GCS).' },
  collections: { scope: 'nested', parent: 'users/{sub}', holds: 'Collections.' },
  cookLogs: { scope: 'nested', parent: 'users/{sub}', holds: 'Cook log entries.' },
  gcsDeletes: { scope: 'nested', parent: 'users/{sub}', holds: 'Pending GCS photo deletes.' },
  translations: { scope: 'nested', parent: 'users/{sub}', holds: 'Cached recipe translations.' },
  mcpGrants: { scope: 'nested', parent: 'users/{sub}', holds: 'Connected MCP apps, with the consenting email.' },
  grants: {
    scope: 'nested',
    parent: 'users/{ownerSub}/collections/{id}',
    holds:
      "Forward sharing grants, with the viewer's sub and email. The owner's are removed with users/{sub}; a deleted viewer's are tombstoned (no email) by the incomingShares step.",
  },
  items: { scope: 'nested', parent: 'incomingShares/{viewerSub}', holds: 'One incoming share per grant.' },
} as const satisfies Record<string, CollectionEntry>;

export type CollectionName = keyof typeof FIRESTORE_COLLECTIONS;

/** Top-level collections that hold a member's data. */
export type PersonalTopLevel = {
  [K in CollectionName]: (typeof FIRESTORE_COLLECTIONS)[K] extends { scope: 'top-level'; personal: true } ? K : never;
}[CollectionName];

export function personalTopLevelCollections(): PersonalTopLevel[] {
  return (Object.keys(FIRESTORE_COLLECTIONS) as CollectionName[]).filter((name): name is PersonalTopLevel => {
    const entry: CollectionEntry = FIRESTORE_COLLECTIONS[name];
    return entry.scope === 'top-level' && entry.personal;
  });
}

/** One line of what a step would change (dry run) or still finds (read back). */
export type InventoryLine = { label: string; count: number };

export interface DeletionStep {
  inventory(sub: string): Promise<InventoryLine[]>;
  /** Changes this member's data, then reads it back and throws if any remains. */
  apply(sub: string, now: number): Promise<void>;
}

// --- Pure decisions -------------------------------------------------------

export type DeletionRefusal = 'bad-sub' | 'still-member' | 'owner' | 'no-allowlist';

/**
 * Whether `--apply` may run. Access must already be denied (README steps 1–2):
 * a member who is still active, or an address in `ALLOWED_EMAILS`, could push
 * their library back on the next sync. A blank allowlist cannot rule out an
 * owner, so it refuses too.
 */
export function deletionRefusal(input: {
  sub: string;
  memberStatus: string | undefined;
  profileEmail: string | undefined;
  allowedRaw: string;
}): DeletionRefusal | null {
  if (!isSafeFirestoreDocumentId(input.sub)) return 'bad-sub';
  if (input.allowedRaw.trim() === '') return 'no-allowlist';
  if (input.memberStatus === 'active') return 'still-member';
  if (input.profileEmail !== undefined && isAllowed(input.profileEmail, true, input.allowedRaw)) return 'owner';
  return null;
}

/** Invites this member minted are deleted; one they redeemed loses `redeemedBy` but keeps counting for its minter. */
export function invitePlan(
  minted: readonly string[],
  redeemed: readonly { id: string; createdBy: unknown }[],
  sub: string,
): { deleteIds: string[]; scrubIds: string[] } {
  const deleteIds = [...new Set(minted)];
  const scrubIds = redeemed
    .filter((row) => row.createdBy !== sub && !deleteIds.includes(row.id))
    .map((row) => row.id);
  return { deleteIds, scrubIds };
}

/**
 * A viewer's incoming share that points at a deleted owner still needs
 * tombstoning when it is live or still holds that owner's email. Tombstones
 * keep the repo's no-hard-delete rule for sharing and carry no email.
 */
export function ownerShareNeedsTombstone(raw: unknown): boolean {
  if (raw === undefined) return false;
  const share = parseIncomingShareDoc(raw);
  if (share === undefined) {
    // Unparseable: overwrite it with a clean tombstone rather than leave an email behind.
    return true;
  }
  return share.deletedAt === undefined || share.ownerEmail !== undefined;
}

// --- Firestore ------------------------------------------------------------

function db(): Firestore {
  return getStoreFirestore();
}

/** Deletes in batches under Firestore's 500-write cap. */
export async function deleteDocs(refs: readonly DocumentReference[]): Promise<void> {
  for (const chunk of chunkForBatch([...refs], 400)) {
    const batch = db().batch();
    for (const ref of chunk) batch.delete(ref);
    await batch.commit();
  }
}

function fail(step: string, left: InventoryLine[]): never {
  const detail = left.map((line) => `${line.label}: ${line.count}`).join(', ');
  throw new Error(`${step}: still found after apply (${detail})`);
}

async function assertGone(step: string, deletion: DeletionStep, sub: string): Promise<void> {
  const left = (await deletion.inventory(sub)).filter((line) => line.count > 0);
  if (left.length > 0) fail(step, left);
}

/** Top-level documents found by an equality on one field, deleted outright. */
function deleteWhere(collection: PersonalTopLevel, field: string): DeletionStep {
  const query = (sub: string) => db().collection(collection).where(field, '==', sub);
  const step: DeletionStep = {
    async inventory(sub) {
      const count = (await query(sub).count().get()).data().count;
      return [{ label: `${collection} where ${field} == sub`, count }];
    },
    async apply(sub) {
      await deleteDocs((await query(sub).get()).docs.map((doc) => doc.ref));
      await assertGone(collection, step, sub);
    },
  };
  return step;
}

/** A single document named by the member's `sub`. */
function deleteBySub(collection: PersonalTopLevel): DeletionStep {
  const ref = (sub: string) => db().collection(collection).doc(sub);
  const step: DeletionStep = {
    async inventory(sub) {
      return [{ label: `${collection}/{sub}`, count: (await ref(sub).get()).exists ? 1 : 0 }];
    },
    async apply(sub) {
      await ref(sub).delete();
      await assertGone(collection, step, sub);
    },
  };
  return step;
}

const invitesStep: DeletionStep = {
  async inventory(sub) {
    const invites = db().collection('invites');
    const [minted, redeemed] = await Promise.all([
      invites.where('createdBy', '==', sub).get(),
      invites.where('redeemedBy', '==', sub).get(),
    ]);
    const plan = invitePlan(
      minted.docs.map((doc) => doc.id),
      redeemed.docs.map((doc) => ({ id: doc.id, createdBy: doc.get('createdBy') })),
      sub,
    );
    return [
      { label: 'invites minted (deleted)', count: plan.deleteIds.length },
      { label: 'invites redeemed from someone else (redeemedBy removed)', count: plan.scrubIds.length },
    ];
  },
  async apply(sub) {
    const invites = db().collection('invites');
    const [minted, redeemed] = await Promise.all([
      invites.where('createdBy', '==', sub).get(),
      invites.where('redeemedBy', '==', sub).get(),
    ]);
    const plan = invitePlan(
      minted.docs.map((doc) => doc.id),
      redeemed.docs.map((doc) => ({ id: doc.id, createdBy: doc.get('createdBy') })),
      sub,
    );
    await deleteDocs(plan.deleteIds.map((id) => invites.doc(id)));
    for (const chunk of chunkForBatch(plan.scrubIds, 400)) {
      const batch = db().batch();
      for (const id of chunk) batch.update(invites.doc(id), { redeemedBy: FieldValue.delete() });
      await batch.commit();
    }
    await assertGone('invites', invitesStep, sub);
  },
};

/**
 * The member as a viewer: each incoming share's forward grant, in its
 * owner's tree, is tombstoned through the same transaction as an owner's
 * revoke or a viewer's leave (the tombstone drops the viewer's email), then
 * `incomingShares/{sub}` is deleted.
 */
const incomingSharesStep: DeletionStep = {
  async inventory(sub) {
    const items = await incomingSharesCol(sub).get();
    let liveForward = 0;
    for (const doc of items.docs) {
      const share = parseIncomingShareDoc(doc.data());
      if (share === undefined) continue;
      const forward = await grantColRef(share.ownerSub, share.collectionId).doc(sub).get();
      if (isLiveGrant(parseGrantDoc(forward.exists ? forward.data() : undefined, sub))) liveForward += 1;
    }
    return [
      { label: 'incomingShares/{sub}/items', count: items.size },
      { label: "live forward grants in owners' trees (tombstoned)", count: liveForward },
    ];
  },
  async apply(sub) {
    const items = await incomingSharesCol(sub).get();
    for (const doc of items.docs) {
      const share = parseIncomingShareDoc(doc.data());
      if (share === undefined) continue;
      await revokeGrantInFirestore(share.ownerSub, share.collectionId, sub);
    }
    // Every forward grant must be a tombstone before its index goes.
    const before = await incomingSharesStep.inventory(sub);
    if (before[1]!.count > 0) fail('incomingShares', [before[1]!]);
    await db().recursiveDelete(db().collection('incomingShares').doc(sub));
    await assertGone('incomingShares', incomingSharesStep, sub);
  },
};

/** Each grant in the member's own tree: which viewer, which collection. */
async function ownedGrants(sub: string): Promise<{ viewerSub: string; collectionId: string }[]> {
  const collections = await db().collection('users').doc(sub).collection('collections').get();
  const grants: { viewerSub: string; collectionId: string }[] = [];
  for (const collection of collections.docs) {
    const snap = await collection.ref.collection('grants').get();
    for (const grant of snap.docs) grants.push({ viewerSub: grant.id, collectionId: collection.id });
  }
  return grants;
}

async function ownerSharesToTombstone(sub: string): Promise<{ ref: DocumentReference; collectionId: string }[]> {
  const out: { ref: DocumentReference; collectionId: string }[] = [];
  for (const { viewerSub, collectionId } of await ownedGrants(sub)) {
    if (!isSafeFirestoreDocumentId(viewerSub)) continue;
    const ref = incomingShareRef(viewerSub, shareGrantId(sub, collectionId));
    const snap = await ref.get();
    if (ownerShareNeedsTombstone(snap.exists ? snap.data() : undefined)) out.push({ ref, collectionId });
  }
  return out;
}

/**
 * The member's own tree, last. As an owner, every viewer's incoming share
 * that points at them is tombstoned first (it held this member's email), read
 * from the grants in this tree, so it must run before the tree is deleted.
 */
const usersStep: DeletionStep = {
  async inventory(sub) {
    const user = db().collection('users').doc(sub);
    const [snap, subcollections, shares] = await Promise.all([
      user.get(),
      user.listCollections(),
      ownerSharesToTombstone(sub),
    ]);
    const lines: InventoryLine[] = [
      { label: "viewers' incoming shares naming this owner (tombstoned)", count: shares.length },
      { label: 'users/{sub} profile', count: snap.exists ? 1 : 0 },
    ];
    for (const subcollection of subcollections) {
      lines.push({
        label: `users/{sub}/${subcollection.id}`,
        count: (await subcollection.count().get()).data().count,
      });
    }
    return lines;
  },
  async apply(sub, now) {
    for (const chunk of chunkForBatch(await ownerSharesToTombstone(sub), 400)) {
      const batch = db().batch();
      for (const { ref, collectionId } of chunk) {
        batch.set(ref, incomingShareCascadeDoc(undefined, sub, collectionId, now), { merge: false });
      }
      await batch.commit();
    }
    const left = await ownerSharesToTombstone(sub);
    if (left.length > 0) fail('users', [{ label: "viewers' incoming shares", count: left.length }]);
    await db().recursiveDelete(db().collection('users').doc(sub));
    await assertGone('users', usersStep, sub);
  },
};

export const ACCOUNT_DELETION_STEPS: Record<PersonalTopLevel, DeletionStep> = {
  incomingShares: incomingSharesStep,
  collectionLinks: deleteWhere('collectionLinks', 'ownerSub'),
  invites: invitesStep,
  importFeedback: deleteWhere('importFeedback', 'sub'),
  featureRequests: deleteWhere('featureRequests', 'sub'),
  mcpAuthCodes: deleteWhere('mcpAuthCodes', 'sub'),
  mcpTokens: deleteWhere('mcpTokens', 'sub'),
  accessRequests: deleteBySub('accessRequests'),
  members: deleteBySub('members'),
  users: usersStep,
};

/** Sharing first (the owner side reads the member's tree), the tree last. */
export const ACCOUNT_DELETION_ORDER: readonly PersonalTopLevel[] = [
  'incomingShares',
  'collectionLinks',
  'invites',
  'importFeedback',
  'featureRequests',
  'mcpAuthCodes',
  'mcpTokens',
  'accessRequests',
  'members',
  'users',
];

/** What `deletionRefusal` needs, read live. */
export async function readDeletionSubject(
  sub: string,
): Promise<{ memberStatus: string | undefined; profileEmail: string | undefined }> {
  const [member, profile] = await Promise.all([
    db().collection('members').doc(sub).get(),
    db().collection('users').doc(sub).get(),
  ]);
  const status = member.exists ? member.get('status') : undefined;
  const email = profile.exists ? profile.get('email') : undefined;
  return {
    memberStatus: typeof status === 'string' ? status : undefined,
    profileEmail: typeof email === 'string' ? email : undefined,
  };
}
