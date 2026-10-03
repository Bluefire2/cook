/**
 * Responses for model-backed routes, served through Playwright so captures
 * are deterministic and the test server needs no Gemini key
 * (docs/plans/i18n-review-ci.md, Decisions). Each mock answers one route the
 * same way every time.
 */
import type { BrowserContext } from 'playwright';

/** A clean single-recipe import: no language, no warnings, no translation. */
const CLEAN_IMPORT = {
  recipe: {
    title: 'Spring pea soup',
    servings: 4,
    prepMinutes: 10,
    cookMinutes: 20,
    tags: ['soup'],
    ingredientSections: [
      {
        items: [
          { quantity: 500, unit: 'g', item: 'frozen peas' },
          { quantity: 1, item: 'onion', note: 'chopped' },
          { quantity: 750, unit: 'ml', item: 'vegetable stock' },
        ],
      },
    ],
    steps: [
      { text: 'Soften the onion in a little butter.' },
      { text: 'Add the peas and stock and simmer for 5 minutes.' },
      { text: 'Blend until smooth and season.' },
    ],
  },
};

export const MOCKS = {
  /** `POST /api/import` returns a clean recipe. */
  importClean: async (context: BrowserContext) => {
    await context.route('**/api/import', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CLEAN_IMPORT) }),
    );
  },
} satisfies Record<string, (context: BrowserContext) => Promise<void>>;

export type MockName = keyof typeof MOCKS;
