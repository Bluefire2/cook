import { describe, expect, it } from 'vitest';
import { buildAgentLibrary, type AgentRecipe } from './library.ts';
import { buildSystemPrompt } from './prompt.ts';

function recipe(overrides: Partial<AgentRecipe> & { id: string; title: string }): AgentRecipe {
  return {
    servings: 4,
    ingredientSections: [],
    steps: [],
    tags: ['dinner'],
    createdAt: 1,
    updatedAt: 1,
    sourceUrl: 'https://secret.example/recipe?auth=token',
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('includes index wrapper, untrusted note, card rule, and omits sourceUrl', () => {
    const library = buildAgentLibrary([recipe({ id: 'r1', title: 'Pasta' })], [], {
      truncated: false,
      maxIndexEntries: 500,
      maxIndexChars: 40_000,
    });
    const prompt = buildSystemPrompt({
      library,
      clientNow: '2026-01-01T12:00:00.000Z',
      timeZone: 'UTC',
      cards: [{ rule: 'Emit shopping list after combine_ingredients.' }],
    });
    expect(prompt).toContain('<library_data>');
    expect(prompt).toContain('</library_data>');
    expect(prompt).toContain('untrusted data');
    expect(prompt).toContain('Emit shopping list after combine_ingredients.');
    expect(prompt).toContain('r1\tPasta\tdinner');
    expect(prompt).not.toContain('sourceUrl');
    expect(prompt).not.toContain('auth=token');
  });

  it('mentions truncation when library is truncated', () => {
    const library = buildAgentLibrary([recipe({ id: 'r1', title: 'Pasta' })], [], {
      truncated: true,
      maxIndexEntries: 500,
      maxIndexChars: 40_000,
    });
    const prompt = buildSystemPrompt({
      library,
      clientNow: '2026-01-01T12:00:00.000Z',
      timeZone: 'UTC',
      cards: [],
    });
    expect(prompt.toLowerCase()).toContain('truncated');
  });
});
