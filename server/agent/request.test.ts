import { describe, expect, it } from 'vitest';
import { buildAgentLibrary, type AgentRecipe } from './sous/library.ts';
import { parseAgentRequest, replayCards } from './request.ts';

function validUserMessage(content = 'Hello') {
  return { role: 'user' as const, content };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    messages: [validUserMessage()],
    clientNow: '2026-03-27T12:00:00.000Z',
    timeZone: 'America/New_York',
    ...overrides,
  };
}

function tinyLibrary() {
  const recipe: AgentRecipe = {
    id: 'r1',
    title: 'Library title',
    servings: 4,
    ingredientSections: [],
    steps: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  };
  return buildAgentLibrary([recipe], [], {
    truncated: false,
    maxIndexEntries: 500,
    maxIndexChars: 40_000,
  });
}

describe('parseAgentRequest', () => {
  it('accepts a valid body', () => {
    const result = parseAgentRequest(validBody());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages).toHaveLength(1);
      expect(result.value.timeZone).toBe('America/New_York');
    }
  });

  it('rejects 41 messages', () => {
    const messages = Array.from({ length: 41 }, () => validUserMessage('x'));
    const result = parseAgentRequest(validBody({ messages }));
    expect(result).toEqual({ ok: false, status: 400 });
  });

  it('rejects when the last message is assistant', () => {
    const result = parseAgentRequest(
      validBody({
        messages: [
          validUserMessage('first'),
          { role: 'assistant', content: 'reply' },
        ],
      }),
    );
    expect(result).toEqual({ ok: false, status: 400 });
  });

  it('rejects user content over 4000 characters', () => {
    const result = parseAgentRequest(
      validBody({ messages: [validUserMessage('a'.repeat(4001))] }),
    );
    expect(result).toEqual({ ok: false, status: 400 });
  });

  it('rejects more than 4 cards on a message', () => {
    const cards = Array.from({ length: 5 }, () => ({ type: 'x', v: 1, data: {} }));
    const result = parseAgentRequest(
      validBody({
        messages: [
          { role: 'assistant', content: 'x', cards },
          validUserMessage('follow up'),
        ],
      }),
    );
    expect(result).toEqual({ ok: false, status: 400 });
  });

  it('rejects invalid clientNow', () => {
    const result = parseAgentRequest(validBody({ clientNow: 'not-a-date' }));
    expect(result).toEqual({ ok: false, status: 400 });
  });

  it('coerces invalid timeZone to UTC', () => {
    const result = parseAgentRequest(validBody({ timeZone: 'Not/A_Real_Zone' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timeZone).toBe('UTC');
    }
  });

  it('rejects a non-object body', () => {
    expect(parseAgentRequest(null)).toEqual({ ok: false, status: 400 });
    expect(parseAgentRequest([])).toEqual({ ok: false, status: 400 });
  });
});

describe('replayCards', () => {
  it('drops an unknown card type', () => {
    const library = tinyLibrary();
    const out = replayCards(
      [
        {
          role: 'assistant',
          content: 'Here',
          cards: [{ type: 'unknown_card', v: 1, data: {} }],
        },
        validUserMessage('next'),
      ],
      library,
    );
    expect(out[0]?.text).toBe('Here');
  });

  it('appends history text for a valid shopping_list card', () => {
    const library = tinyLibrary();
    const cardData = {
      title: 'Weekend shop',
      recipes: [{ id: 'r1', servings: 2 }],
      sections: [
        {
          name: 'Produce',
          items: [
            {
              key: 'onion',
              item: 'Yellow onion',
              quantity: 2,
              unit: 'piece',
              recipeIds: ['r1'],
            },
          ],
        },
      ],
    };
    const out = replayCards(
      [
        {
          role: 'assistant',
          content: 'List ready',
          cards: [{ type: 'shopping_list', v: 1, data: cardData }],
        },
        validUserMessage('thanks'),
      ],
      library,
    );
    expect(out[0]?.text).toContain('List ready');
    expect(out[0]?.text).toContain('Shopping list: Weekend shop');
    expect(out[0]?.text).toContain('Yellow onion');
  });
});
