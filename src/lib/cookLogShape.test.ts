import { describe, expect, it } from 'vitest';
import {
  COOK_LOG_CASES,
  FULL_COOK_LOG,
  FULL_COOK_LOG_UNCOMPACTED,
  MINIMAL_COOK_LOG,
  MINIMAL_COOK_LOG_UNCOMPACTED,
} from '../../test/cookLogFixtures';
import {
  appendLessonToNotes,
  compactCookLog,
  isCookedOn,
  isUsableCookLog,
  lessonInNotes,
  MAX_COOK_LOG_PHOTOS,
  sortCookLogs,
  todayCookedOn,
} from './cookLogShape';
import type { CookLog } from './types';

const full = FULL_COOK_LOG as unknown as CookLog;

describe('compactCookLog', () => {
  it('locks the CookLog key set', () => {
    expect(
      Object.keys(compactCookLog(full)).sort(),
      'Growing CookLog keys amends Principle 6 of docs/constitutions/cook-log.md',
    ).toEqual(
      [
        'cookedOn',
        'createdAt',
        'id',
        'lessons',
        'notes',
        'photoIds',
        'rating',
        'recipeId',
        'servings',
        'updatedAt',
      ].sort(),
    );
  });

  it('drops unknown keys and trims text, matching the server compactor', () => {
    expect(compactCookLog(FULL_COOK_LOG_UNCOMPACTED as unknown as CookLog)).toEqual(FULL_COOK_LOG);
  });

  it('omits blank text, empty photoIds, and undefined optionals', () => {
    const compacted = compactCookLog(MINIMAL_COOK_LOG_UNCOMPACTED as unknown as CookLog);
    expect(compacted).toEqual(MINIMAL_COOK_LOG);
    expect(Object.keys(compacted)).toEqual(['id', 'recipeId', 'cookedOn', 'createdAt', 'updatedAt']);
    expect(
      Object.keys(
        compactCookLog({ ...full, rating: undefined, servings: undefined, photoIds: undefined }),
      ),
    ).not.toContain('rating');
  });

  it('dedupes photoIds and caps them', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    expect(compactCookLog({ ...full, photoIds: ['p0', ...ids] }).photoIds).toEqual(
      ids.slice(0, MAX_COOK_LOG_PHOTOS),
    );
  });

  it('is idempotent', () => {
    const once = compactCookLog(FULL_COOK_LOG_UNCOMPACTED as unknown as CookLog);
    expect(compactCookLog(once)).toEqual(once);
  });
});

describe('isUsableCookLog (shared table with validateCookLogPut)', () => {
  it.each(COOK_LOG_CASES)('$name → $valid', ({ entry, valid }) => {
    expect(isUsableCookLog(entry)).toBe(valid);
  });

  it('treats an explicit undefined optional as absent', () => {
    expect(isUsableCookLog({ ...full, rating: undefined, notes: undefined })).toBe(true);
  });
});

describe('isCookedOn', () => {
  it('accepts real calendar dates', () => {
    expect(isCookedOn('2026-09-26')).toBe(true);
    expect(isCookedOn('2024-02-29')).toBe(true);
    expect(isCookedOn('2000-02-29')).toBe(true);
    expect(isCookedOn('2026-12-31')).toBe(true);
  });

  it('rejects impossible or malformed dates', () => {
    expect(isCookedOn('2026-02-30')).toBe(false);
    expect(isCookedOn('2025-02-29')).toBe(false);
    expect(isCookedOn('1900-02-29')).toBe(false);
    expect(isCookedOn('2026-04-31')).toBe(false);
    expect(isCookedOn('2026-00-10')).toBe(false);
    expect(isCookedOn('2026-9-26')).toBe(false);
    expect(isCookedOn(' 2026-09-26')).toBe(false);
    expect(isCookedOn(20260926)).toBe(false);
  });
});

describe('todayCookedOn', () => {
  it('uses the local calendar date', () => {
    expect(todayCookedOn(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(todayCookedOn(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
  });

  it('always produces a valid cookedOn', () => {
    expect(isCookedOn(todayCookedOn())).toBe(true);
  });
});

describe('sortCookLogs', () => {
  const log = (id: string, cookedOn: string, createdAt: number): CookLog => ({
    id,
    recipeId: 'r',
    cookedOn,
    createdAt,
    updatedAt: createdAt,
  });

  it('sorts by cookedOn desc, then createdAt desc, then id', () => {
    const logs = [
      log('b', '2026-09-01', 5),
      log('a', '2026-09-01', 5),
      log('c', '2026-09-20', 1),
      log('d', '2026-09-01', 9),
      log('e', '2025-12-31', 100),
    ];
    expect(sortCookLogs(logs).map((l) => l.id)).toEqual(['c', 'd', 'a', 'b', 'e']);
  });

  it('does not mutate its input', () => {
    const logs = [log('a', '2026-01-01', 1), log('b', '2026-02-01', 1)];
    sortCookLogs(logs);
    expect(logs.map((l) => l.id)).toEqual(['a', 'b']);
  });
});

describe('appendLessonToNotes', () => {
  it('adds the trimmed lesson as a new paragraph', () => {
    expect(appendLessonToNotes('Rest the dough.\n', '  Salt more. ')).toBe(
      'Rest the dough.\n\nSalt more.',
    );
  });

  it('uses the lesson alone when there are no notes', () => {
    expect(appendLessonToNotes(undefined, 'Salt more.')).toBe('Salt more.');
    expect(appendLessonToNotes('', 'Salt more.')).toBe('Salt more.');
    expect(appendLessonToNotes('  \n', 'Salt more.')).toBe('Salt more.');
  });

  it('leaves notes unchanged for an empty lesson', () => {
    expect(appendLessonToNotes('Rest the dough.', '   ')).toBe('Rest the dough.');
    expect(appendLessonToNotes(undefined, undefined)).toBeUndefined();
  });

  it('is idempotent', () => {
    const once = appendLessonToNotes('Rest the dough.', 'Salt more.');
    expect(appendLessonToNotes(once, 'Salt more.')).toBe(once);
    expect(appendLessonToNotes(once, ' Salt more.\n')).toBe(once);
  });

  it('leaves notes that already contain the lesson unchanged', () => {
    expect(appendLessonToNotes('Always: Salt more. Really.', 'Salt more.')).toBe(
      'Always: Salt more. Really.',
    );
  });
});

describe('lessonInNotes', () => {
  it('derives "In notes" from containment', () => {
    expect(lessonInNotes('Rest the dough.\n\nSalt more.', ' Salt more. ')).toBe(true);
    expect(lessonInNotes('Rest the dough.', 'Salt more.')).toBe(false);
    expect(lessonInNotes(undefined, 'Salt more.')).toBe(false);
    expect(lessonInNotes('Anything', '  ')).toBe(false);
  });
});
