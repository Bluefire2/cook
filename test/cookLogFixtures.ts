/**
 * One table for the client's `isUsableCookLog` and the server's
 * `validateCookLogPut`, so the two cannot drift. Plain objects only: this file
 * is imported by `src/` and `server/` tests and must not import either side.
 */

const LOG_ID = '11111111-1111-4111-8111-111111111111';
const RECIPE_ID = '22222222-2222-4222-8222-222222222222';

function photoId(i: number): string {
  return `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`;
}

export const MINIMAL_COOK_LOG: Record<string, unknown> = {
  id: LOG_ID,
  recipeId: RECIPE_ID,
  cookedOn: '2026-09-26',
  createdAt: 1_000,
  updatedAt: 2_000,
};

export const FULL_COOK_LOG: Record<string, unknown> = {
  ...MINIMAL_COOK_LOG,
  rating: 4,
  servings: 2.5,
  notes: 'Swapped shallots for onion.',
  lessons: 'Salt the water more.',
  photoIds: [photoId(1), photoId(2)],
};

/** Both compactors turn this back into `FULL_COOK_LOG`. */
export const FULL_COOK_LOG_UNCOMPACTED: Record<string, unknown> = {
  ...FULL_COOK_LOG,
  notes: '  Swapped shallots for onion.\n',
  lessons: '\tSalt the water more.  ',
  extra: 'dropped',
  deletedAt: null,
};

/** Both compactors turn this back into `MINIMAL_COOK_LOG`. */
export const MINIMAL_COOK_LOG_UNCOMPACTED: Record<string, unknown> = {
  ...MINIMAL_COOK_LOG,
  notes: '   ',
  lessons: '',
  photoIds: [],
};

export interface CookLogCase {
  name: string;
  entry: unknown;
  valid: boolean;
}

const withPatch = (patch: Record<string, unknown>): Record<string, unknown> => ({
  ...FULL_COOK_LOG,
  ...patch,
});

const without = (key: string): Record<string, unknown> => {
  const next = { ...FULL_COOK_LOG };
  delete next[key];
  return next;
};

export const COOK_LOG_CASES: CookLogCase[] = [
  { name: 'minimal entry', entry: MINIMAL_COOK_LOG, valid: true },
  { name: 'full entry', entry: FULL_COOK_LOG, valid: true },
  { name: 'unknown key (dropped by compaction)', entry: withPatch({ extra: true }), valid: true },
  { name: 'blank notes and empty photoIds', entry: withPatch({ notes: '', photoIds: [] }), valid: true },
  { name: 'leap day', entry: withPatch({ cookedOn: '2024-02-29' }), valid: true },
  { name: 'rating 1', entry: withPatch({ rating: 1 }), valid: true },
  { name: 'rating 5', entry: withPatch({ rating: 5 }), valid: true },
  { name: 'servings 1000', entry: withPatch({ servings: 1000 }), valid: true },
  { name: 'fractional servings', entry: withPatch({ servings: 0.5 }), valid: true },
  { name: 'notes at the cap', entry: withPatch({ notes: 'x'.repeat(10_000) }), valid: true },
  { name: 'lessons at the cap', entry: withPatch({ lessons: 'x'.repeat(10_000) }), valid: true },
  {
    name: '8 photos',
    entry: withPatch({ photoIds: Array.from({ length: 8 }, (_, i) => photoId(i)) }),
    valid: true,
  },

  { name: 'null', entry: null, valid: false },
  { name: 'array', entry: [FULL_COOK_LOG], valid: false },
  { name: 'bad id', entry: withPatch({ id: 'not-a-uuid' }), valid: false },
  { name: 'missing id', entry: without('id'), valid: false },
  { name: 'bad recipeId', entry: withPatch({ recipeId: 'r1' }), valid: false },
  { name: 'missing recipeId', entry: without('recipeId'), valid: false },
  { name: 'missing cookedOn', entry: without('cookedOn'), valid: false },
  { name: 'cookedOn timestamp', entry: withPatch({ cookedOn: 1_758_931_200_000 }), valid: false },
  { name: 'cookedOn unpadded', entry: withPatch({ cookedOn: '2026-9-6' }), valid: false },
  { name: 'cookedOn with time', entry: withPatch({ cookedOn: '2026-09-26T00:00:00Z' }), valid: false },
  { name: 'impossible cookedOn 2026-02-30', entry: withPatch({ cookedOn: '2026-02-30' }), valid: false },
  { name: 'non-leap 2025-02-29', entry: withPatch({ cookedOn: '2025-02-29' }), valid: false },
  { name: 'month 13', entry: withPatch({ cookedOn: '2026-13-01' }), valid: false },
  { name: 'day 00', entry: withPatch({ cookedOn: '2026-09-00' }), valid: false },
  { name: 'missing createdAt', entry: without('createdAt'), valid: false },
  { name: 'missing updatedAt', entry: without('updatedAt'), valid: false },
  { name: 'string updatedAt', entry: withPatch({ updatedAt: '2000' }), valid: false },
  { name: 'NaN updatedAt', entry: withPatch({ updatedAt: Number.NaN }), valid: false },
  { name: 'rating 0', entry: withPatch({ rating: 0 }), valid: false },
  { name: 'rating 6', entry: withPatch({ rating: 6 }), valid: false },
  { name: 'rating 2.5', entry: withPatch({ rating: 2.5 }), valid: false },
  { name: 'rating string', entry: withPatch({ rating: '4' }), valid: false },
  { name: 'rating null', entry: withPatch({ rating: null }), valid: false },
  { name: 'servings 0', entry: withPatch({ servings: 0 }), valid: false },
  { name: 'servings negative', entry: withPatch({ servings: -1 }), valid: false },
  { name: 'servings 1001', entry: withPatch({ servings: 1001 }), valid: false },
  { name: 'servings string', entry: withPatch({ servings: '2' }), valid: false },
  { name: 'notes too long', entry: withPatch({ notes: 'x'.repeat(10_001) }), valid: false },
  { name: 'lessons too long', entry: withPatch({ lessons: 'x'.repeat(10_001) }), valid: false },
  { name: 'notes not a string', entry: withPatch({ notes: 5 }), valid: false },
  {
    name: '9 photos',
    entry: withPatch({ photoIds: Array.from({ length: 9 }, (_, i) => photoId(i)) }),
    valid: false,
  },
  { name: 'duplicate photo ids', entry: withPatch({ photoIds: [photoId(1), photoId(1)] }), valid: false },
  { name: 'non-UUID photo id', entry: withPatch({ photoIds: ['p1'] }), valid: false },
  { name: 'photoIds not an array', entry: withPatch({ photoIds: photoId(1) }), valid: false },
  { name: 'payload JSON at 200k', entry: withPatch({ extra: 'x'.repeat(200_000) }), valid: false },
];
