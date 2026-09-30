import { describe, expect, it } from 'vitest';
import type { CollectionGrant } from './remote';
import {
  deriveGrantRows,
  grantRole,
  withGrant,
  withGrantRole,
  withoutGrant,
} from './shareRows';

const ann: CollectionGrant = { sub: 'a', email: 'ann@example.com', role: 'editor', createdAt: 1 };
const bob: CollectionGrant = { sub: 'b', email: 'bob@example.com', createdAt: 2 };

describe('grantRole', () => {
  it('reads a missing role as viewer', () => {
    expect(grantRole(bob)).toBe('viewer');
    expect(grantRole(ann)).toBe('editor');
  });
});

describe('deriveGrantRows', () => {
  it('shows saved grants as saved with their server role', () => {
    expect(deriveGrantRows([ann, bob], null)).toEqual([
      { key: 'a', sub: 'a', email: 'ann@example.com', role: 'editor', state: 'saved' },
      { key: 'b', sub: 'b', email: 'bob@example.com', role: 'viewer', state: 'saved' },
    ]);
  });

  it('marks the one row whose role change is in flight and shows the requested role', () => {
    const rows = deriveGrantRows([ann, bob], { kind: 'role', sub: 'b', role: 'editor' });
    expect(rows.map((r) => [r.sub, r.role, r.state])).toEqual([
      ['a', 'editor', 'saved'],
      ['b', 'editor', 'saving'],
    ]);
  });

  it('keeps a row being removed and marks it', () => {
    const rows = deriveGrantRows([ann, bob], { kind: 'remove', sub: 'a' });
    expect(rows.map((r) => [r.sub, r.state])).toEqual([
      ['a', 'removing'],
      ['b', 'saved'],
    ]);
  });

  it('appends a placeholder for a new person and trims their email', () => {
    const rows = deriveGrantRows([ann], { kind: 'add', email: '  cy@example.com ', role: 'viewer' });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      key: 'adding',
      email: 'cy@example.com',
      role: 'viewer',
      state: 'adding',
    });
  });

  it('shows the placeholder alone before the list has loaded', () => {
    const rows = deriveGrantRows([], { kind: 'add', email: 'cy@example.com', role: 'editor' });
    expect(rows.map((r) => [r.key, r.state])).toEqual([['adding', 'adding']]);
  });

  it('turns an add for someone already granted into that row saving, not a duplicate', () => {
    const rows = deriveGrantRows([ann, bob], {
      kind: 'add',
      email: 'BOB@example.com ',
      role: 'editor',
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ sub: 'b', role: 'editor', state: 'saving' });
  });

  it('is all saved again once nothing is pending, so a failed request leaves no row behind', () => {
    const failed = deriveGrantRows([ann], null);
    expect(failed.every((r) => r.state === 'saved')).toBe(true);
    expect(failed).toHaveLength(1);
  });
});

describe('list updates', () => {
  it('withGrant appends a new person and replaces an existing one', () => {
    expect(withGrant([ann], bob).map((g) => g.sub)).toEqual(['a', 'b']);
    const upgraded = withGrant([ann, bob], { ...bob, role: 'editor' });
    expect(upgraded).toHaveLength(2);
    expect(upgraded[1].role).toBe('editor');
  });

  it('withGrantRole changes only that person', () => {
    const next = withGrantRole([ann, bob], 'b', 'editor');
    expect(next.map((g) => g.role)).toEqual(['editor', 'editor']);
    expect(bob.role).toBeUndefined();
  });

  it('withoutGrant drops that person', () => {
    expect(withoutGrant([ann, bob], 'a').map((g) => g.sub)).toEqual(['b']);
  });
});
