import { t } from '../i18n';
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

function wireCards(cards: AgentWireCard[]): AgentWireCard[] {
  return cards.map((c) => ({
    type: c.type,
    v: c.v,
    id: c.id,
    data: c.data,
  }));
}

/** Keep partial text, clear the interim flag, and label the reply so it replays. */
export function markStopped(state: AgentState): AgentState {
  if (!state.streaming) {
    return state;
  }
  const label = t('assistant.stopped');
  const settled = { ...state, streaming: false, toolLabel: null };
  const last = lastAssistant(state);
  if (!last) {
    return appendAssistant(settled, { content: label });
  }
  return updateLastAssistant(settled, (msg) => ({
    ...msg,
    interim: false,
    content: msg.content === '' ? label : `${msg.content}\n\n${label}`,
  }));
}

export function messagesForReplay(state: AgentState): AgentWireMessage[] {
  const out: AgentWireMessage[] = [];
  let carried: AgentWireCard[] = [];

  const takeCarried = (): AgentWireCard[] => {
    const cards = carried;
    carried = [];
    return cards;
  };

  const pushAssistant = (content: string, cards: AgentWireCard[]) => {
    const wire: AgentWireMessage = { role: 'assistant', content };
    if (cards.length > 0) {
      wire.cards = cards;
    }
    out.push(wire);
  };

  for (const m of state.messages) {
    const own = m.cards && m.cards.length > 0 ? wireCards(m.cards) : [];
    if (m.interim) {
      if (own.length > 0) {
        carried = [...carried, ...own];
      }
      continue;
    }
    if (m.role === 'assistant') {
      pushAssistant(m.content, [...takeCarried(), ...own]);
      continue;
    }
    if (carried.length > 0) {
      pushAssistant('', takeCarried());
    }
    const wire: AgentWireMessage = { role: 'user', content: m.content };
    if (own.length > 0) {
      wire.cards = own;
    }
    out.push(wire);
  }
  if (carried.length > 0) {
    pushAssistant('', takeCarried());
  }
  return out;
}

type AgentAction =
  | { type: 'event'; event: AgentServerEvent }
  | { type: 'toggle'; cardId: string; itemKey: string }
  | { type: 'clear' }
  | { type: 'begin'; userText: string }
  | { type: 'stopped' };

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
    case 'stopped':
      return markStopped(current);
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

/**
 * The in-flight request lives beside the thread, not in the screen, so Stop
 * still works after the screen remounts and Clear or sign-out can end it.
 */
let activeRequest: AbortController | null = null;

export function beginAgentRequest(): AbortController {
  activeRequest?.abort();
  activeRequest = new AbortController();
  return activeRequest;
}

/** False once Clear, sign-out, or a newer turn has replaced this request. */
export function isActiveAgentRequest(controller: AbortController): boolean {
  return activeRequest === controller;
}

export function endAgentRequest(controller: AbortController): void {
  if (activeRequest === controller) {
    activeRequest = null;
  }
}

/** Stop keeps the request active so its partial reply is labelled Stopped. */
export function stopAgentRequest(): void {
  activeRequest?.abort();
}

function discardAgentRequest(): void {
  const controller = activeRequest;
  activeRequest = null;
  controller?.abort();
}

export function clearAgentThread(): void {
  discardAgentRequest();
  dispatch({ type: 'clear' });
}

onSessionReset(() => {
  discardAgentRequest();
  dispatch({ type: 'clear' });
});
