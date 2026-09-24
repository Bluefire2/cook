import { describe, expect, it } from 'vitest';
import { MAX_NAMED_COLLECTIONS } from './compactCollection';
import { collectionPushErrorMessage } from './collectionStore';

describe('collectionPushErrorMessage', () => {
  it('uses the cap copy only for the dedicated cap reason on create', () => {
    expect(collectionPushErrorMessage('cap', true)).toBe(
      `You can have up to ${MAX_NAMED_COLLECTIONS} collections.`,
    );
    expect(collectionPushErrorMessage('invalid', true)).toBe(
      "Couldn't save the collection.",
    );
    expect(collectionPushErrorMessage('unknown', true)).toBe(
      "Couldn't save the collection.",
    );
    expect(collectionPushErrorMessage('cap', false)).toBe(
      "Couldn't save the collection.",
    );
  });

  it('keeps the signed-out copy', () => {
    expect(collectionPushErrorMessage('signedOut', true)).toBe(
      'Please sign in again — your session expired.',
    );
  });
});
