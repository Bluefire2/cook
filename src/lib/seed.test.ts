import { describe, expect, it } from 'vitest';
import { shouldSeed } from './seed';

describe('shouldSeed', () => {
  it('seeds only a first launch with an empty library', () => {
    expect(shouldSeed(0, false)).toBe(true);
  });

  it('does not resurrect a sample after the user empties the library', () => {
    expect(shouldSeed(0, true)).toBe(false);
  });

  it('does not seed when recipes already exist', () => {
    expect(shouldSeed(1, false)).toBe(false);
    expect(shouldSeed(3, true)).toBe(false);
  });
});
