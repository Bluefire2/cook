import { describe, expect, it } from 'vitest';
import {
  decideSyncToast,
  mergePullCursor,
  recordsEqual,
  resolveSyncResult,
  shouldDropOutboxResult,
  shouldEnqueueUnsyncedLibrary,
  splitDrainBatch,
  syncOwnershipDecision,
} from './syncEngine';
import type { OutboxRow } from './outbox';

describe('syncOwnershipDecision', () => {
  it('proceeds when owner matches sub', () => {
    expect(syncOwnershipDecision('sub-a', 'sub-a', 3)).toBe('proceed');
  });

  it('wipes when owner differs', () => {
    expect(syncOwnershipDecision('sub-a', 'sub-b', 3)).toBe('wipe-and-pull');
  });

  it('claims when absent and empty', () => {
    expect(syncOwnershipDecision(null, 'sub-a', 0)).toBe('claim-and-pull');
  });

  it('needs migration when absent with rows', () => {
    expect(syncOwnershipDecision(null, 'sub-a', 2)).toBe('needsMigration');
  });

  it('treats empty owner as absent', () => {
    expect(syncOwnershipDecision('', 'sub-a', 1)).toBe('needsMigration');
  });
});

describe('splitDrainBatch', () => {
  it('keeps later push ops when photo.put rows come first', () => {
    const rows: OutboxRow[] = [
      { seq: 1, kind: 'photo.put', payload: { id: 'p', recipeId: 'r', updatedAt: 1 }, enqueuedAt: 1, attempts: 0 },
      { seq: 2, kind: 'recipe.put', payload: {} as OutboxRow['payload'], enqueuedAt: 1, attempts: 0 },
    ];
    expect(splitDrainBatch(rows).pushRows.map((row) => row.seq)).toEqual([2]);
  });

  it('skips photo.put without counting toward push batch', () => {
    const rows: OutboxRow[] = [
      { seq: 1, kind: 'photo.put', payload: { id: 'p', recipeId: 'r', updatedAt: 1 }, enqueuedAt: 1, attempts: 0 },
      { seq: 2, kind: 'recipe.put', payload: {} as OutboxRow['payload'], enqueuedAt: 1, attempts: 0 },
    ];
    const { pushRows, skippedPhotoPutSeqs } = splitDrainBatch(rows);
    expect(pushRows).toHaveLength(1);
    expect(skippedPhotoPutSeqs).toEqual([1]);
  });
});

describe('shouldDropOutboxResult', () => {
  it('drops applied and terminal reasons', () => {
    expect(shouldDropOutboxResult({ applied: true })).toBe(true);
    expect(shouldDropOutboxResult({ applied: false, reason: 'invalid' })).toBe(true);
    expect(shouldDropOutboxResult({ applied: false, reason: 'unknown' })).toBe(true);
    expect(shouldDropOutboxResult({ applied: false, reason: 'recipe-deleted' })).toBe(false);
  });
});

describe('shouldEnqueueUnsyncedLibrary', () => {
  it('enqueues when local rows exist and nothing has synced yet', () => {
    expect(
      shouldEnqueueUnsyncedLibrary({
        lastSyncedAt: null,
        pendingCount: 0,
        rowCount: 3,
      }),
    ).toBe(true);
  });

  it('does not enqueue after a successful sync or with a pending outbox', () => {
    expect(
      shouldEnqueueUnsyncedLibrary({
        lastSyncedAt: 1,
        pendingCount: 0,
        rowCount: 3,
      }),
    ).toBe(false);
    expect(
      shouldEnqueueUnsyncedLibrary({
        lastSyncedAt: null,
        pendingCount: 2,
        rowCount: 3,
      }),
    ).toBe(false);
    expect(
      shouldEnqueueUnsyncedLibrary({
        lastSyncedAt: null,
        pendingCount: 0,
        rowCount: 0,
      }),
    ).toBe(false);
  });
});

describe('mergePullCursor', () => {
  it('merges per-collection cursors', () => {
    const prev = { recipes: [1, 'a'] as [number, string] };
    const next = { chatMessages: [2, 'b'] as [number, string] };
    expect(mergePullCursor(prev, next)).toEqual({
      recipes: [1, 'a'],
      chatMessages: [2, 'b'],
    });
  });
});

describe('recordsEqual', () => {
  it('compares objects regardless of key order', () => {
    expect(recordsEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('treats absent keys and explicit undefined as equal', () => {
    expect(recordsEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(recordsEqual({ b: undefined, a: 1 }, { a: 1 })).toBe(true);
  });

  it('compares nested objects deeply', () => {
    const inner = { title: 'Soup', ingredients: [{ name: 'salt' }] };
    expect(
      recordsEqual({ proposedRecipe: inner }, { proposedRecipe: { ...inner } }),
    ).toBe(true);
    expect(
      recordsEqual(
        { proposedRecipe: inner },
        { proposedRecipe: { title: 'Soup', ingredients: [{ name: 'pepper' }] } },
      ),
    ).toBe(false);
  });

  it('compares arrays by index and length', () => {
    expect(recordsEqual({ checkedKeys: ['a', 'b'] }, { checkedKeys: ['a', 'b'] })).toBe(true);
    expect(recordsEqual({ checkedKeys: ['a', 'b'] }, { checkedKeys: ['b', 'a'] })).toBe(false);
    expect(recordsEqual({ checkedKeys: ['a'] }, { checkedKeys: ['a', 'b'] })).toBe(false);
  });

  it('distinguishes scalars and extra keys', () => {
    expect(recordsEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(recordsEqual({ a: 1 }, { a: 1, extra: true })).toBe(false);
  });

  it('distinguishes null, undefined, and zero', () => {
    expect(recordsEqual(null, null)).toBe(true);
    expect(recordsEqual(undefined, undefined)).toBe(true);
    expect(recordsEqual(0, 0)).toBe(true);
    expect(recordsEqual(null, undefined)).toBe(false);
    expect(recordsEqual(undefined, 0)).toBe(false);
    expect(recordsEqual(null, 0)).toBe(false);
  });
});

describe('resolveSyncResult', () => {
  it('maps drain signedOut with null pull', () => {
    expect(
      resolveSyncResult({ outcome: 'signedOut', pushed: 2, applied: 1 }, null),
    ).toEqual({ outcome: 'signedOut', pushed: 2, applied: 1 });
  });

  it('maps pull signedOut with summed counts', () => {
    expect(
      resolveSyncResult(
        { outcome: 'ok', pushed: 0, applied: 0 },
        { outcome: 'signedOut', applied: 4 },
      ),
    ).toEqual({ outcome: 'signedOut', pushed: 0, applied: 4 });
  });

  it('maps pull error with summed counts', () => {
    expect(
      resolveSyncResult(
        { outcome: 'ok', pushed: 1, applied: 2 },
        { outcome: 'error', applied: 3 },
      ),
    ).toEqual({ outcome: 'error', pushed: 1, applied: 5 });
  });

  it('maps drain stop with pull ok to error', () => {
    expect(
      resolveSyncResult(
        { outcome: 'stop', pushed: 1, applied: 0 },
        { outcome: 'ok', applied: 2 },
      ),
    ).toEqual({ outcome: 'error', pushed: 1, applied: 2 });
  });

  it('maps drain stop with pull signedOut to signedOut', () => {
    expect(
      resolveSyncResult(
        { outcome: 'stop', pushed: 1, applied: 0 },
        { outcome: 'signedOut', applied: 2 },
      ),
    ).toEqual({ outcome: 'signedOut', pushed: 1, applied: 2 });
  });

  it('maps all ok with summed counts', () => {
    expect(
      resolveSyncResult(
        { outcome: 'ok', pushed: 2, applied: 1 },
        { outcome: 'ok', applied: 3 },
      ),
    ).toEqual({ outcome: 'ok', pushed: 2, applied: 4 });
  });

  it('maps null pull without signedOut drain to error', () => {
    expect(
      resolveSyncResult({ outcome: 'ok', pushed: 0, applied: 0 }, null),
    ).toEqual({ outcome: 'error', pushed: 0, applied: 0 });
  });
});

describe('decideSyncToast', () => {
  it('shows success when ok and pushed', () => {
    expect(decideSyncToast({ outcome: 'ok', pushed: 1, applied: 0 })).toEqual({
      kind: 'success',
      message: 'Synced',
    });
  });

  it('shows success when ok and applied', () => {
    expect(decideSyncToast({ outcome: 'ok', pushed: 0, applied: 3 })).toEqual({
      kind: 'success',
      message: 'Synced',
    });
  });

  it('shows nothing for ok with zero movement', () => {
    expect(decideSyncToast({ outcome: 'ok', pushed: 0, applied: 0 })).toBeNull();
  });

  it('shows error for failure even with zero counts', () => {
    expect(decideSyncToast({ outcome: 'error', pushed: 0, applied: 0 })).toEqual({
      kind: 'error',
      message: "Couldn't sync",
    });
  });

  it('shows error for failure even with non-zero counts', () => {
    expect(decideSyncToast({ outcome: 'error', pushed: 2, applied: 3 })).toEqual({
      kind: 'error',
      message: "Couldn't sync",
    });
  });

  it('shows nothing for offline, signedOut, and skipped', () => {
    expect(decideSyncToast({ outcome: 'offline', pushed: 0, applied: 0 })).toBeNull();
    expect(decideSyncToast({ outcome: 'signedOut', pushed: 1, applied: 0 })).toBeNull();
    expect(decideSyncToast({ outcome: 'skipped', pushed: 0, applied: 0 })).toBeNull();
  });
});
