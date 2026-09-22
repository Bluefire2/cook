import { describe, expect, it } from 'vitest';
import { decodeSharedCursor, encodeSharedCursor } from './sharedPull.ts';

describe('shared pull cursor', () => {
  it('round-trips a grant id that is not a UUID', () => {
    const cursor = { grantId: 'google-sub_11111111-1111-4111-8111-111111111111', recipeId: '' };
    expect(decodeSharedCursor(encodeSharedCursor(cursor))).toEqual(cursor);
  });

  it('treats junk as the start of the keyspace', () => {
    expect(decodeSharedCursor(null)).toEqual({ grantId: '', recipeId: '' });
    expect(decodeSharedCursor('%%%')).toEqual({ grantId: '', recipeId: '' });
  });
});
