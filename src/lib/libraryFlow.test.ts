import { describe, expect, it } from 'vitest';
import {
  initialLibraryFlow,
  libraryFlowReducer,
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
