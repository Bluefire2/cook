import { describe, expect, it } from 'vitest';
import { backfillPatch, shouldLabel } from './backfill-recipe-lang.ts';

const live = {
  title: 'Carbonara',
  description: 'Pasta from Rome',
  steps: [{ text: 'Boil the water.' }, { text: 'Toss with egg and cheese.' }],
  updatedAt: 10,
};

describe('shouldLabel', () => {
  it('selects a live unlabelled recipe whose updatedAt is unchanged', () => {
    expect(shouldLabel(live, 10)).toBe(true);
    expect(shouldLabel({ updatedAt: 10, deletedAt: null }, 10)).toBe(true);
  });

  it('skips a tombstone', () => {
    expect(shouldLabel({ ...live, deletedAt: 10 }, 10)).toBe(false);
  });

  it('skips a recipe that is already labelled', () => {
    expect(shouldLabel({ ...live, lang: 'it' }, 10)).toBe(false);
  });

  it('skips when updatedAt changed since the read', () => {
    expect(shouldLabel({ ...live, updatedAt: 11 }, 10)).toBe(false);
  });

  it('skips when lang appeared', () => {
    expect(shouldLabel({ ...live, lang: 'uk' }, 10)).toBe(false);
  });
});

describe('backfillPatch', () => {
  it('has only lang and serverUpdatedAt', () => {
    const patch = backfillPatch('it', 1_700_000_000_000);
    expect(patch).toEqual({ lang: 'it', serverUpdatedAt: 1_700_000_000_000 });
    expect(Object.keys(patch)).toEqual(['lang', 'serverUpdatedAt']);
  });
});
