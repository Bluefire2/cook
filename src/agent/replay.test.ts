import { describe, expect, it } from 'vitest';
import {
  fitReplay,
  MAX_ASSISTANT_CONTENT,
  MAX_REPLAY_BODY_BYTES,
  MAX_REPLAY_MESSAGES,
  MAX_USER_CONTENT,
} from './replay';
import type { AgentWireMessage } from './protocol';

function user(content: string): AgentWireMessage {
  return { role: 'user', content };
}

function assistant(content: string): AgentWireMessage {
  return { role: 'assistant', content };
}

describe('fitReplay', () => {
  it('truncates user and assistant content and keeps four cards', () => {
    const cards = Array.from({ length: 6 }, (_, i) => ({
      type: 'shopping_list',
      v: 1,
      id: `c${i}`,
      data: {},
    }));
    const fitted = fitReplay([
      user('u'.repeat(MAX_USER_CONTENT + 50)),
      { ...assistant('a'.repeat(MAX_ASSISTANT_CONTENT + 50)), cards },
      user('latest'),
    ]);
    expect(fitted[0]?.content).toHaveLength(MAX_USER_CONTENT);
    expect(fitted[1]?.content).toHaveLength(MAX_ASSISTANT_CONTENT);
    expect(fitted[1]?.cards).toHaveLength(4);
    expect(fitted[2]?.content).toBe('latest');
  });

  it('drops the oldest messages past the count cap and keeps the latest', () => {
    const messages = Array.from({ length: MAX_REPLAY_MESSAGES + 5 }, (_, i) =>
      i % 2 === 0 ? user(`u${i}`) : assistant(`a${i}`),
    );
    messages[messages.length - 1] = user('latest');
    const fitted = fitReplay(messages);
    expect(fitted).toHaveLength(MAX_REPLAY_MESSAGES);
    expect(fitted[fitted.length - 1]?.content).toBe('latest');
    expect(fitted[0]?.content).not.toBe('u0');
  });

  it('drops oldest messages until the JSON body fits', () => {
    const fat = 'x'.repeat(20_000);
    const messages: AgentWireMessage[] = [];
    for (let i = 0; i < 8; i += 1) {
      messages.push(assistant(fat));
      messages.push(user(`q${i}`));
    }
    const fitted = fitReplay(messages);
    const bytes = new TextEncoder().encode(JSON.stringify(fitted)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_REPLAY_BODY_BYTES);
    expect(fitted[fitted.length - 1]?.content).toBe('q7');
    expect(fitted.length).toBeLessThan(messages.length);
  });
});
