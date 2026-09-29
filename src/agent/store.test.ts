import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateSession } from '../lib/session';
import {
  applyEvent,
  beginTurn,
  clearAgentThread,
  dispatch,
  getAgentSnapshot,
  initialAgentState,
  markStopped,
  messagesForReplay,
  STOPPED_LABEL,
  toggleChecked,
} from './store';

const clearLibraryMock = vi.fn();

vi.mock('../lib/libraryMemory', () => ({
  clearLibrary: () => clearLibraryMock(),
}));

beforeEach(() => {
  clearAgentThread();
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
});

afterEach(() => {
  clearAgentThread();
  vi.restoreAllMocks();
});

describe('applyEvent', () => {
  it('streams text into one assistant message', () => {
    let state = beginTurn(initialAgentState, 'hello');
    state = applyEvent(state, { t: 'text', step: 1, d: 'Hi ' });
    state = applyEvent(state, { t: 'text', step: 1, d: 'there' });
    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.content).toBe('Hi there');
  });

  it('starts a new assistant message after interim text', () => {
    let state = beginTurn(initialAgentState, 'q');
    state = applyEvent(state, { t: 'text', step: 1, d: 'draft' });
    state = applyEvent(state, { t: 'interim', step: 1 });
    state = applyEvent(state, { t: 'text', step: 2, d: 'final' });
    const assistants = state.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.interim).toBe(true);
    expect(assistants[0]?.content).toBe('draft');
    expect(assistants[1]?.content).toBe('final');
    expect(messagesForReplay(state).map((m) => m.content)).toEqual(['q', 'final']);
  });

  it('carries cards from an interim message onto the next assistant reply', () => {
    let state = beginTurn(initialAgentState, 'list');
    const card = { type: 'shopping_list', v: 1, id: 'c1', data: { title: 'Shop' } };
    state = applyEvent(state, { t: 'text', step: 1, d: 'draft' });
    state = applyEvent(state, { t: 'interim', step: 1 });
    state = applyEvent(state, { t: 'card', card });
    state = applyEvent(state, { t: 'text', step: 2, d: 'final' });
    const replay = messagesForReplay(state);
    expect(replay.map((m) => m.content)).toEqual(['list', 'final']);
    expect(replay[1]?.cards).toEqual([card]);
  });

  it('keeps interim cards when no later assistant text arrives', () => {
    let state = beginTurn(initialAgentState, 'list');
    const card = { type: 'shopping_list', v: 1, id: 'c1', data: {} };
    state = applyEvent(state, { t: 'text', step: 1, d: 'draft' });
    state = applyEvent(state, { t: 'interim', step: 1 });
    state = applyEvent(state, { t: 'card', card });
    const replay = messagesForReplay(state);
    expect(replay.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(replay[1]?.content).toBe('');
    expect(replay[1]?.cards).toEqual([card]);
  });

  it('labels a stopped reply and replays it', () => {
    let state = beginTurn(initialAgentState, 'q');
    state = applyEvent(state, { t: 'text', step: 1, d: 'partial' });
    state = markStopped(state);
    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.interim).toBe(false);
    expect(assistant?.content).toBe(`partial\n\n${STOPPED_LABEL}`);
    expect(state.streaming).toBe(false);
    expect(messagesForReplay(state).map((m) => m.content)).toEqual([
      'q',
      `partial\n\n${STOPPED_LABEL}`,
    ]);
  });

  it('records tool label and clears on non-interim text', () => {
    let state = beginTurn(initialAgentState, 'q');
    state = applyEvent(state, { t: 'tool', name: 'search_recipes', phase: 'start' });
    expect(state.toolLabel).toBe('search_recipes');
    state = applyEvent(state, { t: 'text', step: 1, d: 'answer' });
    expect(state.toolLabel).toBeNull();
  });

  it('attaches cards to the streaming assistant message', () => {
    let state = beginTurn(initialAgentState, 'list');
    const card = { type: 'shopping_list', v: 1, id: 'c1', data: {} };
    state = applyEvent(state, { t: 'card', card });
    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.cards).toEqual([card]);
  });

  it('sets error and stops streaming on error event', () => {
    let state = beginTurn(initialAgentState, 'q');
    state = applyEvent(state, { t: 'error', message: 'nope' });
    expect(state.error).toBe('nope');
    expect(state.streaming).toBe(false);
  });

  it('ends streaming on done', () => {
    let state = beginTurn(initialAgentState, 'q');
    state = applyEvent(state, { t: 'done' });
    expect(state.streaming).toBe(false);
  });
});

describe('toggleChecked', () => {
  it('toggles item keys per card', () => {
    let state = initialAgentState;
    state = toggleChecked(state, 'card-1', 'onion');
    expect(state.checked['card-1']?.onion).toBe(true);
    state = toggleChecked(state, 'card-1', 'onion');
    expect(state.checked['card-1']).toBeUndefined();
  });
});

describe('session reset', () => {
  it('clears the thread when invalidateSession runs', () => {
    dispatch({ type: 'begin', userText: 'keep?' });
    dispatch({ type: 'event', event: { t: 'text', step: 1, d: 'x' } });
    expect(getAgentSnapshot().messages.length).toBeGreaterThan(0);
    invalidateSession();
    expect(getAgentSnapshot()).toEqual(initialAgentState);
  });
});
