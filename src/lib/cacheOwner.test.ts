import { describe, expect, it } from 'vitest';
import { cacheOwnershipDecision } from './cacheOwner';

describe('cacheOwnershipDecision', () => {
  it('proceeds when owner matches sub', () => {
    expect(cacheOwnershipDecision('sub-a', 'sub-a')).toBe('proceed');
  });

  it('wipes when owner differs', () => {
    expect(cacheOwnershipDecision('sub-a', 'sub-b')).toBe('wipe');
  });

  it('claims when owner is absent', () => {
    expect(cacheOwnershipDecision(null, 'sub-a')).toBe('claim');
    expect(cacheOwnershipDecision('', 'sub-a')).toBe('claim');
  });
});
