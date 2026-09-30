import { describe, expect, it } from 'vitest';
import {
  initialLibraryFlow,
  libraryFlowReducer,
  runCreate,
  sheetError,
  type LibraryFlow,
  type LibraryFlowAction,
} from './libraryFlow';

function run(...actions: LibraryFlowAction[]): LibraryFlow {
  return actions.reduce(libraryFlowReducer, initialLibraryFlow);
}

describe('libraryFlowReducer', () => {
  it('carries the moved recipe into a new-collection create', () => {
    const state = run({ type: 'openMove', recipeId: 'r1' }, { type: 'startCreate' });
    expect(state.sheet).toEqual({ kind: 'create', name: '', saving: false, moveRecipeId: 'r1' });
  });

  it('creates without a move when started from the switcher', () => {
    const state = run({ type: 'startCreate' });
    expect(state.sheet).toEqual({ kind: 'create', name: '', saving: false });
  });

  it('keeps the created collection through a failed move so a retry reuses it', () => {
    let state = run(
      { type: 'openMove', recipeId: 'r1' },
      { type: 'startCreate' },
      { type: 'setName', name: 'Soups' },
    );
    const token = state.token;
    state = libraryFlowReducer(state, { type: 'submitting', token });
    state = libraryFlowReducer(state, {
      type: 'created',
      token,
      created: { id: 'c1', name: 'Soups' },
    });
    state = libraryFlowReducer(state, { type: 'failed', token, error: 'move failed' });
    expect(state.sheet).toEqual({
      kind: 'create',
      name: 'Soups',
      moveRecipeId: 'r1',
      created: { id: 'c1', name: 'Soups' },
      saving: false,
      error: 'move failed',
    });

    state = libraryFlowReducer(state, { type: 'submitting', token });
    expect(sheetError(state.sheet)).toBeUndefined();
    expect(state.sheet.kind === 'create' && state.sheet.created).toEqual({
      id: 'c1',
      name: 'Soups',
    });
  });

  it('marks a create as saving from submit until it fails, so it cannot run twice', () => {
    let state = run({ type: 'startCreate' }, { type: 'setName', name: 'Soups' });
    const token = state.token;
    state = libraryFlowReducer(state, { type: 'submitting', token });
    expect(state.sheet.kind === 'create' && state.sheet.saving).toBe(true);
    // The collection exists but the move is still running: still saving.
    state = libraryFlowReducer(state, {
      type: 'created',
      token,
      created: { id: 'c1', name: 'Soups' },
    });
    expect(state.sheet.kind === 'create' && state.sheet.saving).toBe(true);
    state = libraryFlowReducer(state, { type: 'failed', token, error: 'x' });
    expect(state.sheet.kind === 'create' && state.sheet.saving).toBe(false);
  });

  it('a stale submit does not mark a newer create sheet as saving', () => {
    let state = run({ type: 'startCreate' });
    const stale = state.token;
    state = libraryFlowReducer(state, { type: 'close' });
    state = libraryFlowReducer(state, { type: 'startCreate' });
    const fresh = state;
    expect(libraryFlowReducer(state, { type: 'submitting', token: stale })).toBe(fresh);
    expect(state.sheet.kind === 'create' && state.sheet.saving).toBe(false);
  });

  it.each([
    ['move', { type: 'openMove', recipeId: 'r1' }],
    ['rename', { type: 'openRename', collectionId: 'c1', name: 'Old' }],
  ] as const)('marks a %s as saving from submit until it fails', (_kind, openAction) => {
    let state = run(openAction);
    expect('saving' in state.sheet && state.sheet.saving).toBe(false);
    const token = state.token;
    state = libraryFlowReducer(state, { type: 'submitting', token });
    expect('saving' in state.sheet && state.sheet.saving).toBe(true);
    state = libraryFlowReducer(state, { type: 'failed', token, error: 'x' });
    expect('saving' in state.sheet && state.sheet.saving).toBe(false);
    expect(sheetError(state.sheet)).toBe('x');
  });

  it.each([
    ['move', { type: 'openMove', recipeId: 'r1' }],
    ['rename', { type: 'openRename', collectionId: 'c1', name: 'Old' }],
  ] as const)('a stale submit does not mark a newer %s sheet as saving', (_kind, openAction) => {
    let state = run(openAction);
    const stale = state.token;
    state = libraryFlowReducer(state, { type: 'close' });
    state = libraryFlowReducer(state, openAction);
    const fresh = state;
    expect(libraryFlowReducer(state, { type: 'submitting', token: stale })).toBe(fresh);
    expect(libraryFlowReducer(state, { type: 'failed', token: stale, error: 'x' })).toBe(fresh);
  });

  it('clears the name and error when a sheet is closed and reopened', () => {
    let state = run({ type: 'startCreate' }, { type: 'setName', name: 'Soups' });
    state = libraryFlowReducer(state, { type: 'failed', token: state.token, error: 'nope' });
    state = libraryFlowReducer(state, { type: 'close' });
    state = libraryFlowReducer(state, { type: 'startCreate' });
    expect(state.sheet).toEqual({ kind: 'create', name: '', saving: false });
  });

  it('ignores completions from a sheet that was closed, replaced or reset', () => {
    const started = run({ type: 'openRename', collectionId: 'c1', name: 'Old' });
    const stale = started.token;

    const reopened = libraryFlowReducer(
      libraryFlowReducer(started, { type: 'close' }),
      { type: 'openRename', collectionId: 'c1', name: 'Old' },
    );
    expect(reopened.token).not.toBe(stale);
    expect(libraryFlowReducer(reopened, { type: 'failed', token: stale, error: 'x' })).toBe(
      reopened,
    );
    expect(libraryFlowReducer(reopened, { type: 'submitting', token: stale })).toBe(reopened);

    const replaced = libraryFlowReducer(started, { type: 'openShare' });
    expect(libraryFlowReducer(replaced, { type: 'failed', token: stale, error: 'x' })).toBe(
      replaced,
    );
  });

  it('a stale leave failure does not touch a newer leave sheet', () => {
    let state = run({ type: 'openLeave', collectionId: 'c1', name: 'Shared' });
    const stale = state.token;
    state = libraryFlowReducer(state, { type: 'submitting', token: stale });
    state = libraryFlowReducer(state, { type: 'close' });
    state = libraryFlowReducer(state, { type: 'openLeave', collectionId: 'c1', name: 'Shared' });
    const fresh = state;
    state = libraryFlowReducer(state, { type: 'failed', token: stale, error: 'x' });
    expect(state).toBe(fresh);
    expect(state.sheet).toEqual({ kind: 'leave', collectionId: 'c1', name: 'Shared' });
  });

  it('a failed leave keeps its name and shows the error', () => {
    let state = run({ type: 'openLeave', collectionId: 'c1', name: 'Shared' });
    state = libraryFlowReducer(state, { type: 'submitting', token: state.token });
    state = libraryFlowReducer(state, { type: 'failed', token: state.token, error: 'x' });
    expect(state.sheet).toEqual({ kind: 'leave', collectionId: 'c1', name: 'Shared', error: 'x' });
  });

  it('opening one sheet replaces another', () => {
    const state = run({ type: 'openAdd' }, { type: 'openDeleteRecipe', recipeId: 'r1' });
    expect(state.sheet).toEqual({ kind: 'deleteRecipe', recipeId: 'r1' });
  });

  it('ignores a name change when no sheet takes a name', () => {
    const state = run({ type: 'openAdd' });
    expect(libraryFlowReducer(state, { type: 'setName', name: 'x' })).toBe(state);
  });

  it('closes the invite confirmation only while it is the open sheet', () => {
    const confirming = run({ type: 'openInviteConfirm' });
    expect(libraryFlowReducer(confirming, { type: 'closeInviteConfirm' }).sheet).toEqual({
      kind: 'closed',
    });
    const other = run({ type: 'openAdd' });
    expect(libraryFlowReducer(other, { type: 'closeInviteConfirm' })).toBe(other);
  });
});

describe('runCreate', () => {
  function effects(options: { current?: () => boolean; moveFails?: boolean } = {}) {
    const calls: string[] = [];
    const recorded: { id: string; name: string }[] = [];
    return {
      calls,
      recorded,
      input: {
        isCurrent: options.current ?? (() => true),
        create: async (name: string) => {
          calls.push(`create:${name}`);
          return { id: 'c-new' };
        },
        rename: async (id: string, name: string) => {
          calls.push(`rename:${id}:${name}`);
        },
        move: async (recipeId: string, collectionId: string) => {
          calls.push(`move:${recipeId}:${collectionId}`);
          if (options.moveFails) {
            throw new Error('move failed');
          }
        },
        onCreated: (created: { id: string; name: string }) => {
          recorded.push(created);
        },
      },
    };
  }

  it('creates, moves the recipe in, and returns the new id', async () => {
    const fx = effects();
    const result = await runCreate({ ...fx.input, name: ' Soups ', created: undefined, moveRecipeId: 'r1' });
    expect(result).toEqual({ kind: 'done', id: 'c-new' });
    expect(fx.calls).toEqual(['create: Soups ', 'move:r1:c-new']);
    expect(fx.recorded).toEqual([{ id: 'c-new', name: 'Soups' }]);
  });

  it('reuses a collection an earlier attempt made, renaming only when the name changed', async () => {
    const same = effects();
    await runCreate({
      ...same.input,
      name: 'Soups',
      created: { id: 'c1', name: 'Soups' },
      moveRecipeId: 'r1',
    });
    expect(same.calls).toEqual(['move:r1:c1']);

    const renamed = effects();
    await runCreate({
      ...renamed.input,
      name: 'Stews',
      created: { id: 'c1', name: 'Soups' },
      moveRecipeId: undefined,
    });
    expect(renamed.calls).toEqual(['rename:c1:Stews']);
    expect(renamed.recorded).toEqual([{ id: 'c1', name: 'Stews' }]);
  });

  it('does not move the recipe once the workflow was cancelled or left', async () => {
    let current = true;
    const fx = effects({ current: () => current });
    const create = fx.input.create;
    const result = await runCreate({
      ...fx.input,
      // The user cancels while the create is in flight.
      create: async (name) => {
        const made = await create(name);
        current = false;
        return made;
      },
      name: 'Soups',
      created: undefined,
      moveRecipeId: 'r1',
    });
    expect(result).toEqual({ kind: 'stale' });
    expect(fx.calls).toEqual(['create:Soups']);
    // The collection that landed is still recorded for a retry.
    expect(fx.recorded).toEqual([{ id: 'c-new', name: 'Soups' }]);
  });

  it('reports stale when the workflow ends during the move, so the caller does not navigate', async () => {
    let current = true;
    const fx = effects({ current: () => current });
    const move = fx.input.move;
    const result = await runCreate({
      ...fx.input,
      move: async (recipeId, collectionId) => {
        await move(recipeId, collectionId);
        current = false;
      },
      name: 'Soups',
      created: undefined,
      moveRecipeId: 'r1',
    });
    expect(result).toEqual({ kind: 'stale' });
  });

  it('lets a failed move throw after recording the collection', async () => {
    const fx = effects({ moveFails: true });
    await expect(
      runCreate({ ...fx.input, name: 'Soups', created: undefined, moveRecipeId: 'r1' }),
    ).rejects.toThrow('move failed');
    expect(fx.recorded).toEqual([{ id: 'c-new', name: 'Soups' }]);
  });
});
