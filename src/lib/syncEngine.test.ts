import { describe, expect, it } from 'vitest';
import {
  mergePullCursor,
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
