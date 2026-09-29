import type { AgentWireMessage } from './protocol';

/** Match server/agent/request.ts. Duplicated because the client cannot import server/. */
export const MAX_REPLAY_MESSAGES = 40;
export const MAX_USER_CONTENT = 4_000;
export const MAX_ASSISTANT_CONTENT = 20_000;
export const MAX_CARDS_PER_MESSAGE = 4;
/** Under the 100 KB body cap, leaving room for clientNow and timeZone. */
export const MAX_REPLAY_BODY_BYTES = 90_000;

function clampMessage(message: AgentWireMessage): AgentWireMessage {
  const max = message.role === 'user' ? MAX_USER_CONTENT : MAX_ASSISTANT_CONTENT;
  const content = message.content.length > max ? message.content.slice(0, max) : message.content;
  const wire: AgentWireMessage = { role: message.role, content };
  if (message.cards && message.cards.length > 0) {
    wire.cards = message.cards.slice(0, MAX_CARDS_PER_MESSAGE);
  }
  return wire;
}

function replayBytes(messages: AgentWireMessage[]): number {
  return new TextEncoder().encode(JSON.stringify(messages)).length;
}

/** Truncate fields and drop the oldest messages until the body fits the server limits. */
export function fitReplay(messages: AgentWireMessage[]): AgentWireMessage[] {
  let kept = messages.map(clampMessage);
  while (
    kept.length > 1 &&
    (kept.length > MAX_REPLAY_MESSAGES || replayBytes(kept) > MAX_REPLAY_BODY_BYTES)
  ) {
    kept = kept.slice(1);
  }
  if (replayBytes(kept) > MAX_REPLAY_BODY_BYTES && kept.length === 1) {
    const only = kept[0]!;
    return [{ role: only.role, content: only.content.slice(0, MAX_USER_CONTENT) }];
  }
  return kept;
}
