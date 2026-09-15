import { db } from './db';

export const OWNER_UID_KEY = 'cook.ownerUid';
const HAS_SEEDED_KEY = 'cook.hasSeeded';

export function cacheOwnershipDecision(
  ownerUid: string | null,
  sub: string,
): 'proceed' | 'wipe' | 'claim' {
  if (ownerUid === null || ownerUid === '') {
    return 'claim';
  }
  if (ownerUid === sub) {
    return 'proceed';
  }
  return 'wipe';
}

export async function applyCacheOwnership(sub: string): Promise<void> {
  const ownerUid = localStorage.getItem(OWNER_UID_KEY);
  const decision = cacheOwnershipDecision(ownerUid, sub);
  if (decision === 'proceed') {
    return;
  }
  if (decision === 'claim') {
    localStorage.setItem(OWNER_UID_KEY, sub);
    return;
  }
  await db.transaction('rw', db.recipes, db.chatMessages, db.photos, db.cookState, async () => {
    await db.recipes.clear();
    await db.chatMessages.clear();
    await db.photos.clear();
    await db.cookState.clear();
  });
  localStorage.removeItem(HAS_SEEDED_KEY);
  localStorage.setItem(OWNER_UID_KEY, sub);
}
