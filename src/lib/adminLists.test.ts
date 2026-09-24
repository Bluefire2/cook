import { describe, expect, it } from 'vitest';
import type {
  AccessRequestEntry,
  AccessRequestLists,
  AccessRequestPage,
} from './adminApi';
import { mergeSectionPage, sortAccessRequestLists } from './adminLists';

function entry(sub: string, requestedAt: number): AccessRequestEntry {
  return { sub, email: `${sub}@example.com`, requestedAt, requestCount: 1 };
}

function page(
  rows: AccessRequestEntry[],
  nextCursor: string | null = null,
): AccessRequestPage {
  return { rows, nextCursor };
}

function lists(
  pending: AccessRequestPage,
  approved: AccessRequestPage,
  denied: AccessRequestPage,
): AccessRequestLists {
  return { pending, approved, denied };
}

function subs(pageOf: AccessRequestPage): string[] {
  return pageOf.rows.map((row) => row.sub);
}

describe('sortAccessRequestLists', () => {
  it('sorts every section newest-first and keeps cursors untouched', () => {
    const input = lists(
      page([entry('a', 100), entry('b', 300), entry('c', 200)], 'c'),
      page([entry('d', 50)], 'd'),
      page([], null),
    );
    const sorted = sortAccessRequestLists(input);
    expect(subs(sorted.pending)).toEqual(['b', 'c', 'a']);
    expect(sorted.pending.nextCursor).toBe('c');
    expect(sorted.approved.nextCursor).toBe('d');
    expect(sorted.denied.nextCursor).toBeNull();
  });
});

describe('mergeSectionPage', () => {
  it('appends the requested section, re-sorts it, and takes its new cursor', () => {
    const current = lists(
      page([entry('p1', 300), entry('p2', 200)], 'p2'),
      page([entry('a1', 100)], 'a1'),
      page([], null),
    );
    const response = lists(
      page([entry('p3', 400), entry('p4', 150)], null),
      page([entry('a1', 100)], 'a1'),
      page([], null),
    );
    const merged = mergeSectionPage(current, 'pending', response);
    expect(subs(merged.pending)).toEqual(['p3', 'p1', 'p2', 'p4']);
    expect(merged.pending.nextCursor).toBeNull();
  });

  it("discards the other sections' returned rows and cursors, keeping state", () => {
    // Approved has already been paged twice; the response carries its first
    // page again, whose cursor ('a2') would rewind it if kept.
    const current = lists(
      page([entry('p1', 300)], 'p1'),
      page([entry('a1', 900), entry('a2', 800), entry('a3', 700), entry('a4', 600)], 'a4'),
      page([entry('d1', 500)], 'd1'),
    );
    const response = lists(
      page([entry('p2', 250)], null),
      page([entry('a1', 900), entry('a2', 800)], 'a2'),
      page([entry('d1', 500)], null),
    );
    const merged = mergeSectionPage(current, 'pending', response);
    expect(merged.approved).toBe(current.approved);
    expect(merged.denied).toBe(current.denied);
    expect(subs(merged.approved)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(merged.approved.nextCursor).toBe('a4');
    expect(merged.denied.nextCursor).toBe('d1');
  });

  it('never duplicates a row the screen already shows', () => {
    const current = lists(page([entry('p1', 100)], 'p1'), page([]), page([]));
    const response = lists(page([entry('p1', 100), entry('p2', 200)], null), page([]), page([]));
    const merged = mergeSectionPage(current, 'pending', response);
    expect(subs(merged.pending)).toEqual(['p2', 'p1']);
  });

  it('pages two interleaved sections with no row repeated and none skipped', () => {
    // The plan's cursor-preservation case: Load more twice in Pending, once
    // in Approved, then once more in Pending — the last click must continue
    // from Pending's own cursor, not a rewound one.
    let state = lists(
      page([entry('p1', 100), entry('p2', 90)], 'p2'),
      page([entry('a1', 80), entry('a2', 70)], 'a2'),
      page([], null),
    );
    state = mergeSectionPage(
      state,
      'pending',
      lists(
        page([entry('p3', 60), entry('p4', 50)], 'p4'),
        page([entry('a1', 80), entry('a2', 70)], 'a2'),
        page([], null),
      ),
    );
    state = mergeSectionPage(
      state,
      'approved',
      lists(
        page([entry('p1', 100), entry('p2', 90)], 'p2'),
        page([entry('a3', 40)], null),
        page([], null),
      ),
    );
    state = mergeSectionPage(
      state,
      'pending',
      lists(
        page([entry('p5', 30)], null),
        page([entry('a1', 80), entry('a2', 70)], 'a2'),
        page([], null),
      ),
    );
    expect(subs(state.pending)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(new Set(subs(state.pending)).size).toBe(5);
    expect(state.pending.nextCursor).toBeNull();
    expect(subs(state.approved)).toEqual(['a1', 'a2', 'a3']);
    expect(state.approved.nextCursor).toBeNull();
    expect(subs(state.denied)).toEqual([]);
  });
});
