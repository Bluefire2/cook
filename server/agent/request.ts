import type { AgentMessage } from './harness/types.ts';
import type { AgentLibrary } from './sous/library.ts';
import { CARD_SPECS } from './sous/cards/index.ts';

export const MAX_AGENT_BODY_BYTES = 100_000;

const MAX_MESSAGES = 40;
const MAX_USER_CONTENT = 4_000;
const MAX_ASSISTANT_CONTENT = 20_000;
const MAX_CARDS_PER_MESSAGE = 4;

export type AgentRequestMessage = {
  role: 'user' | 'assistant';
  content: string;
  cards?: unknown[];
};

export type AgentRequestBody = {
  messages: AgentRequestMessage[];
  clientNow: string;
  timeZone: string;
};

export type ParseAgentRequestResult =
  | { ok: true; value: AgentRequestBody }
  | { ok: false; status: 400 };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeTimeZone(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return 'UTC';
  }
  const timeZone = raw.trim();
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function parseMessage(raw: unknown, isLast: boolean): AgentRequestMessage | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const role = raw.role;
  if (role !== 'user' && role !== 'assistant') {
    return null;
  }
  if (typeof raw.content !== 'string') {
    return null;
  }
  const content = raw.content;
  const maxLen = role === 'user' ? MAX_USER_CONTENT : MAX_ASSISTANT_CONTENT;
  if (content.length > maxLen) {
    return null;
  }
  if (isLast && role === 'user' && content === '') {
    return null;
  }

  let cards: unknown[] | undefined;
  if (raw.cards !== undefined) {
    if (!Array.isArray(raw.cards)) {
      return null;
    }
    if (raw.cards.length > MAX_CARDS_PER_MESSAGE) {
      return null;
    }
    cards = raw.cards;
  }

  const message: AgentRequestMessage = { role, content };
  if (cards !== undefined) {
    message.cards = cards;
  }
  return message;
}

export function parseAgentRequest(body: unknown): ParseAgentRequestResult {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400 };
  }

  if (typeof body.clientNow !== 'string') {
    return { ok: false, status: 400 };
  }
  // Date.parse accepts a timestamp followed by a NUL and any text, and this
  // value goes into the system prompt, so only the canonical form is kept.
  const clientNowMs = Date.parse(body.clientNow);
  if (Number.isNaN(clientNowMs)) {
    return { ok: false, status: 400 };
  }

  const timeZone = normalizeTimeZone(body.timeZone);

  if (!Array.isArray(body.messages)) {
    return { ok: false, status: 400 };
  }
  if (body.messages.length < 1 || body.messages.length > MAX_MESSAGES) {
    return { ok: false, status: 400 };
  }

  const messages: AgentRequestMessage[] = [];
  const lastIndex = body.messages.length - 1;
  for (let i = 0; i < body.messages.length; i += 1) {
    const parsed = parseMessage(body.messages[i], i === lastIndex);
    if (parsed === null) {
      return { ok: false, status: 400 };
    }
    messages.push(parsed);
  }

  if (messages[lastIndex]?.role !== 'user') {
    return { ok: false, status: 400 };
  }

  return {
    ok: true,
    value: {
      messages,
      clientNow: new Date(clientNowMs).toISOString(),
      timeZone,
    },
  };
}

function findCardSpec(type: string, version: number) {
  return CARD_SPECS.find((spec) => spec.type === type && spec.version === version);
}

/**
 * Gemini wants user and model turns to alternate. A turn that failed before
 * any reply leaves two user messages in a row, so adjacent messages with the
 * same role are joined, and an assistant message with no text is dropped.
 */
function coalesceTurns(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.text.trim() === '') {
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.role === message.role) {
      out[out.length - 1] = { role: last.role, text: `${last.text}\n\n${message.text}` };
      continue;
    }
    out.push(message);
  }
  return out;
}

export function replayCards(
  messages: AgentRequestMessage[],
  library: AgentLibrary,
): AgentMessage[] {
  return coalesceTurns(messages.map((message) => {
    let text = message.content;
    if (message.role === 'assistant' && message.cards !== undefined) {
      for (const raw of message.cards) {
        if (!isPlainObject(raw)) {
          continue;
        }
        const type = raw.type;
        const version = raw.v;
        const data = raw.data;
        if (typeof type !== 'string' || typeof version !== 'number') {
          continue;
        }
        const spec = findCardSpec(type, version);
        if (!spec) {
          continue;
        }
        const validate = spec.revalidate ?? spec.normalize;
        const normalized = validate(data, library);
        if (!normalized.ok) {
          continue;
        }
        text += `\n\n${spec.historyText(normalized.data)}`;
      }
    }
    return { role: message.role, text };
  }));
}
