import { describe, expect, it } from 'vitest';
import {
  COMMON_UNITS,
  CUSTOM_UNIT,
  resolveUnit,
  unitChoice,
} from './units';

describe('COMMON_UNITS', () => {
  it('is the exact ten units in documented order, including piece', () => {
    expect(COMMON_UNITS).toEqual([
      'piece',
      'tsp',
      'tbsp',
      'cup',
      'ml',
      'l',
      'g',
      'kg',
      'oz',
      'lb',
    ]);
    expect(COMMON_UNITS).toContain('piece');
  });
});

describe('unitChoice', () => {
  it('maps undefined and empty string to no unit', () => {
    expect(unitChoice(undefined)).toBe('');
    expect(unitChoice('')).toBe('');
  });

  it.each(COMMON_UNITS)('maps listed unit %s to itself', (u) => {
    expect(unitChoice(u)).toBe(u);
  });

  it.each(['knob', 'sprig', 'Cup', ' cup '] as const)(
    'maps off-list value %s to CUSTOM_UNIT',
    (value) => {
      expect(unitChoice(value)).toBe(CUSTOM_UNIT);
    },
  );

  it('maps the CUSTOM_UNIT sentinel to CUSTOM_UNIT', () => {
    expect(unitChoice(CUSTOM_UNIT)).toBe(CUSTOM_UNIT);
  });
});

describe('resolveUnit', () => {
  it('ignores custom text when no unit is chosen', () => {
    expect(resolveUnit('', 'knob')).toBeUndefined();
  });

  it('uses listed choice over stale custom text', () => {
    expect(resolveUnit('cup', 'knob')).toBe('cup');
  });

  it('returns custom text for CUSTOM_UNIT choice', () => {
    expect(resolveUnit(CUSTOM_UNIT, 'knob')).toBe('knob');
    expect(resolveUnit(CUSTOM_UNIT, '  knob  ')).toBe('knob');
  });

  it('returns undefined when custom text is emptied', () => {
    expect(resolveUnit(CUSTOM_UNIT, '')).toBeUndefined();
    expect(resolveUnit(CUSTOM_UNIT, '   ')).toBeUndefined();
  });
});

describe('unitChoice and resolveUnit round-trips', () => {
  it.each(COMMON_UNITS)(
    'round-trips listed unit %s',
    (u) => {
      expect(resolveUnit(unitChoice(u), u)).toBe(u);
    },
  );

  it('round-trips off-list knob', () => {
    expect(resolveUnit(unitChoice('knob'), 'knob')).toBe('knob');
  });

  it('round-trips undefined to undefined', () => {
    expect(resolveUnit(unitChoice(undefined), '')).toBeUndefined();
  });

  it('normalizes custom text that matches a listed unit', () => {
    expect(resolveUnit(CUSTOM_UNIT, 'cup')).toBe('cup');
    expect(unitChoice('cup')).toBe('cup');
  });
});
