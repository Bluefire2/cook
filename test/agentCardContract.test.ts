import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAgentLibrary, type AgentRecipe } from '../server/agent/sous/library.ts';
import { normalizeCollectionMove } from '../server/agent/sous/cards/collectionMove.ts';
import { normalizeShoppingList } from '../server/agent/sous/cards/shoppingList.ts';
import { parseCollectionMove, parseShoppingList } from '../src/agent/cards/parse.ts';

type FixtureCase =
  | { ok: true; args: unknown; expect: unknown }
  | { ok: false; args: unknown };

type Fixture = { cases: FixtureCase[] };

const shoppingFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/agent-cards/shopping_list.v1.json',
);

const collectionMoveFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/agent-cards/collection_move.v1.json',
);

function testLibrary(): ReturnType<typeof buildAgentLibrary> {
  const recipes: AgentRecipe[] = [
    {
      id: 'r1',
      title: 'Library title',
      servings: 4,
      ingredientSections: [],
      steps: [],
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'r2',
      title: 'Second recipe',
      servings: 2,
      ingredientSections: [],
      steps: [],
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  return buildAgentLibrary(recipes, [{ id: 'c-weeknight', name: 'Weeknight', recipeIds: ['r2'] }], {
    truncated: false,
    maxIndexEntries: 500,
    maxIndexChars: 40_000,
  });
}

describe('shopping_list card contract', () => {
  it('matches server normalize and client parse on fixtures', () => {
    const fixture = JSON.parse(readFileSync(shoppingFixturePath, 'utf8')) as Fixture;
    const ctx = testLibrary();
    for (const c of fixture.cases) {
      if (c.ok) {
        const result = normalizeShoppingList(c.args, ctx);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          continue;
        }
        expect(result.data).toEqual(c.expect);
        const parsed = parseShoppingList(1, result.data);
        expect(parsed).toEqual(result.data);
      } else {
        const normalized = normalizeShoppingList(c.args, ctx);
        const parsedRaw = parseShoppingList(1, c.args);
        expect(normalized.ok === false || parsedRaw === undefined).toBe(true);
      }
    }
  });
});

describe('collection_move card contract', () => {
  it('matches server normalize and client parse on fixtures', () => {
    const fixture = JSON.parse(readFileSync(collectionMoveFixturePath, 'utf8')) as Fixture;
    const ctx = testLibrary();
    for (const c of fixture.cases) {
      if (c.ok) {
        const result = normalizeCollectionMove(c.args, ctx);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          continue;
        }
        expect(result.data).toEqual(c.expect);
        const parsed = parseCollectionMove(1, result.data);
        expect(parsed).toEqual(result.data);
      } else {
        const normalized = normalizeCollectionMove(c.args, ctx);
        const parsedRaw = parseCollectionMove(1, c.args);
        expect(normalized.ok === false || parsedRaw === undefined).toBe(true);
      }
    }
  });
});
