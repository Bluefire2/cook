import { onSessionReset } from '../lib/session';
import type { AgentServerEvent, AgentWireCard, AgentWireMessage } from './protocol';

export type AgentMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cards?: AgentWireCard[];
  interim?: boolean;
};

export type AgentState = {
  messages: AgentMessage[];
  checked: Record<string, Record<string, true>>;
  streaming: boolean;
  error: string | null;
  toolLabel: string | null;
};

export const initialAgentState: AgentState = {
  messages: [],
  checked: {},
  streaming: false,
  error: null,
  toolLabel: null,
};

function newId(): string {
  return crypto.randomUUID();
}

function lastAssistant(state: AgentState): AgentMessage | undefined {
  const last = state.messages[state.messages.length - 1];
  if (last?.role === 'assistant') {
    return last;
  }
  return undefined;
}

function appendAssistant(state: AgentState, partial: Omit<AgentMessage, 'id' | 'role'>): AgentState {
  const message: AgentMessage = {
    id: newId(),
    role: 'assistant',
    ...partial,
  };
  return { ...state, messages: [...state.messages, message] };
}

function updateLastAssistant(
  state: AgentState,
  update: (msg: AgentMessage) => AgentMessage,
): AgentState {
  const idx = state.messages.length - 1;
  const last = state.messages[idx];
  if (!last || last.role !== 'assistant') {
    return state;
  }
  const next = [...state.messages];
  next[idx] = update(last);
  return { ...state, messages: next };
}

export function applyEvent(state: AgentState, event: AgentServerEvent): AgentState {
  switch (event.t) {
    case 'text': {
      let next = state;
      const current = lastAssistant(next);
      if (current?.interim) {
        next = appendAssistant(next, { content: event.d });
      } else if (current && next.streaming) {
        next = updateLastAssistant(next, (msg) => ({
          ...msg,
          content: msg.content + event.d,
        }));
      } else {
        next = appendAssistant(next, { content: event.d });
      }
      return { ...next, toolLabel: null };
    }
    case 'interim': {
      let next = state;
      const current = lastAssistant(next);
      if (!current || !next.streaming) {
        next = appendAssistant(next, { content: '', interim: true });
      } else {
        next = updateLastAssistant(next, (msg) => ({ ...msg, interim: true }));
      }
      return next;
    }
    case 'card': {
      let next = state;
      const current = lastAssistant(next);
      if (!current || !next.streaming) {
        next = appendAssistant(next, { content: '', cards: [event.card] });
      } else {
        next = updateLastAssistant(next, (msg) => ({
          ...msg,
          cards: [...(msg.cards ?? []), event.card],
        }));
      }
      return next;
    }
    case 'tool': {
      if (event.phase === 'start') {
        return { ...state, toolLabel: event.name };
      }
      return state;
    }
    case 'error':
      return { ...state, error: event.message, streaming: false };
    case 'done':
      return { ...state, streaming: false };
    default:
      return state;
  }
}

export function toggleChecked(state: AgentState, cardId: string, itemKey: string): AgentState {
  const card = state.checked[cardId] ?? {};
  const nextCard = { ...card };
  if (nextCard[itemKey]) {
    delete nextCard[itemKey];
  } else {
    nextCard[itemKey] = true;
  }
  const checked = { ...state.checked };
  if (Object.keys(nextCard).length === 0) {
    delete checked[cardId];
  } else {
    checked[cardId] = nextCard;
  }
  return { ...state, checked };
}

export function clearThread(_state: AgentState): AgentState {
  return { ...initialAgentState };
}

export function beginTurn(state: AgentState, userText: string): AgentState {
  const userMessage: AgentMessage = {
    id: newId(),
    role: 'user',
    content: userText,
  };
  return {
    ...state,
    messages: [...state.messages, userMessage],
    streaming: true,
    error: null,
    toolLabel: null,
  };
}

export function messagesForReplay(state: AgentState): AgentWireMessage[] {
  return state.messages
    .filter((m) => !m.interim)
    .map((m) => {
      const wire: AgentWireMessage = { role: m.role, content: m.content };
      if (m.cards && m.cards.length > 0) {
        wire.cards = m.cards.map((c) => ({
          type: c.type,
          v: c.v,
          id: c.id,
          data: c.data,
        }));
      }
      return wire;
    });
}

type AgentAction =
  | { type: 'event'; event: AgentServerEvent }
  | { type: 'toggle'; cardId: string; itemKey: string }
  | { type: 'clear' }
  | { type: 'begin'; userText: string };

let state: AgentState = { ...initialAgentState };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function reduce(current: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case 'event':
      return applyEvent(current, action.event);
    case 'toggle':
      return toggleChecked(current, action.cardId, action.itemKey);
    case 'clear':
      return clearThread(current);
    case 'begin':
      return beginTurn(current, action.userText);
    default:
      return current;
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentSnapshot(): AgentState {
  return state;
}

export function dispatch(action: AgentAction): void {
  state = reduce(state, action);
  emit();
}

export function clearAgentThread(): void {
  dispatch({ type: 'clear' });
}

onSessionReset(() => {
  dispatch({ type: 'clear' });
});
