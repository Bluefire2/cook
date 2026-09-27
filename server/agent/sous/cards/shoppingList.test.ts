import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAgentLibrary, type AgentRecipe } from '../library.ts';
import { normalizeShoppingList, shoppingListCard } from './shoppingList.ts';

/**
 * Fixture shape at test/fixtures/agent-cards/shopping_list.v1.json:
 * { "cases": [ { "ok": true, "args": {...}, "expect": {...} } | { "ok": false, "args": {...} } ] }
 */
type FixtureCase =
  | { ok: true; args: unknown; expect: unknown }
  | { ok: false; args: unknown };

type Fixture = { cases: FixtureCase[] };

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../test/fixtures/agent-cards/shopping_list.v1.json',
);

function testLibrary(): ReturnType<typeof buildAgentLibrary> {
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

describe('shoppingListCard', () => {
  it('has the v1 rule text', () => {
    expect(shoppingListCard.rule).toContain('combine_ingredients');
    expect(shoppingListCard.toolName).toBe('show_shopping_list');
  });

  it('runs fixture cases', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
    const ctx = testLibrary();
    for (const c of fixture.cases) {
      const result = normalizeShoppingList(c.args, ctx);
      if (c.ok) {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data).toEqual(c.expect);
        }
      } else {
        expect(result.ok).toBe(false);
      }
    }
  });
});
