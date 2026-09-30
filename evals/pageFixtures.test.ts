import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractRecipeSource } from '../server/recipeImport.ts';

// Offline companion to recipeImport.eval.ts: runs the deterministic
// extraction step (no Gemini) over every cached page. Only the website page
// fixtures; import-handwritten/ is out of scope here (see evals/AGENTS.md).

const evalsRoot = dirname(fileURLToPath(import.meta.url));
const PAGE_DIRS = ['import', 'import-sites'] as const;
const MAX_SOURCE_CHARS = 60_000;

type Expected = { path: 'jsonld' } | { path: 'text'; mustContain: string[] };

/**
 * Which branch of extractRecipeSource each page takes. A JSON-LD page that
 * falls back to stripped text, or the reverse, is a behaviour change worth a
 * look, so update this map deliberately. A new page fixture needs an entry.
 */
const EXPECTED: Record<string, Expected> = {
  'import/beef-noodle-soup': { path: 'jsonld' },
  'import/beef-stew': { path: 'jsonld' },
  'import/gumbo': { path: 'jsonld' },
  'import-sites/atk-chicken-noodle-soup': { path: 'jsonld' },
  'import-sites/bbcgoodfood-bolognese': { path: 'jsonld' },
  'import-sites/cookpad-bbq-chicken': { path: 'jsonld' },
  'import-sites/delish-marry-me-chicken': { path: 'jsonld' },
  'import-sites/foodcom-banana-bread': {
    path: 'text',
    mustContain: ['banana', 'flour', 'baking soda'],
  },
  'import-sites/giallozafferano-carbonara': { path: 'jsonld' },
  'import-sites/hebbarskitchen-paneer-butter-masala': { path: 'jsonld' },
  'import-sites/indianhealthyrecipes-chicken-biryani': { path: 'jsonld' },
  'import-sites/justonecookbook-okonomiyaki': { path: 'jsonld' },
  'import-sites/kingarthur-sandwich-bread': { path: 'jsonld' },
  'import-sites/loveandlemons-guacamole': {
    path: 'text',
    mustContain: ['avocado', 'lime', 'cilantro'],
  },
  'import-sites/marmiton-boeuf-bourguignon': { path: 'jsonld' },
  'import-sites/natashaskitchen-borscht': { path: 'jsonld' },
  'import-sites/nytcooking-chocolate-chip-cookies': { path: 'jsonld' },
  'import-sites/ottolenghi-shakshuka': { path: 'jsonld' },
  'import-sites/patijinich-chicken-tinga': { path: 'jsonld' },
  'import-sites/recipetineats-chicken-chow-mein': { path: 'jsonld' },
  'import-sites/seriouseats-chocolate-chip-cookies': { path: 'jsonld' },
  'import-sites/spendwithpennies-beef-stew': { path: 'jsonld' },
  'import-sites/tasty-garlic-parmesan-pasta': { path: 'jsonld' },
  'import-sites/wikibooks-pancake': { path: 'text', mustContain: ['flour', 'egg'] },
  'import-sites/woksoflife-ma-po-tofu': { path: 'jsonld' },
};

function pageFixtures(): string[] {
  const found: string[] = [];
  for (const dir of PAGE_DIRS) {
    for (const name of readdirSync(join(evalsRoot, dir))) {
      if (existsSync(join(evalsRoot, dir, name, 'page.html'))) {
        found.push(`${dir}/${name}`);
      }
    }
  }
  return found.sort();
}

function parsedRecipeNode(source: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(source);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

describe('extractRecipeSource over cached page fixtures', () => {
  it('every page fixture has an expected entry, and every entry has a page', () => {
    expect(pageFixtures()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [fixture, expected] of Object.entries(EXPECTED)) {
    it(`${fixture} extracts via ${expected.path}`, () => {
      const html = readFileSync(join(evalsRoot, fixture, 'page.html'), 'utf8');
      const source = extractRecipeSource(html);

      expect(source.trim()).not.toBe('');
      expect(source.length).toBeLessThanOrEqual(MAX_SOURCE_CHARS);

      const node = parsedRecipeNode(source);
      if (expected.path === 'jsonld') {
        expect(node).not.toBeNull();
        const type = node?.['@type'];
        expect(type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))).toBe(true);
        expect(typeof node?.name).toBe('string');
      } else {
        expect(node).toBeNull();
        expect(source).not.toMatch(/<script|<style/i);
        const lower = source.toLowerCase();
        for (const word of expected.mustContain) {
          expect(lower).toContain(word);
        }
      }
    });
  }
});
