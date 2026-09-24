import { describe, expect, it } from 'vitest';
import type { RecipeDraft } from '../src/lib/types.ts';
import { fakeImportDeps } from './fakeGemini.ts';
import {
  extractRecipeSource,
  fetchPageHtml,
  importFromHtml,
  importFromSource,
  normalizeImportedRecipe,
  type ImportedRecipe,
} from './recipeImport.ts';

// Drift guard: the server cannot import `src/` at runtime, so ImportedRecipe
// is declared separately. If it stops being a RecipeDraft, `tsc -b` fails here.
const importedIsDraft = (recipe: ImportedRecipe): RecipeDraft => recipe;
void importedIsDraft;

const ldBlock = (json: string) =>
  `<script type="application/ld+json">${json}</script>`;

const RECIPE = {
  '@type': 'Recipe',
  name: 'Cacio e Pepe',
  recipeYield: '2 servings',
};

describe('extractRecipeSource', () => {
  it('returns a bare JSON-LD Recipe object', () => {
    const html = `<html><body>${ldBlock(JSON.stringify(RECIPE))}</body></html>`;
    expect(JSON.parse(extractRecipeSource(html))).toEqual(RECIPE);
  });

  it('picks the Recipe out of a JSON-LD array', () => {
    const nodes = [{ '@type': 'WebSite', name: 'Blog' }, RECIPE];
    const html = ldBlock(JSON.stringify(nodes));
    expect(JSON.parse(extractRecipeSource(html))).toEqual(RECIPE);
  });

  it('unwraps @graph', () => {
    const html = ldBlock(
      JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [{ '@type': 'Person', name: 'Author' }, RECIPE],
      }),
    );
    expect(JSON.parse(extractRecipeSource(html))).toEqual(RECIPE);
  });

  it('accepts @type as an array containing Recipe', () => {
    const node = { ...RECIPE, '@type': ['Recipe', 'NewsArticle'] };
    const html = ldBlock(JSON.stringify(node));
    expect(JSON.parse(extractRecipeSource(html))).toEqual(node);
  });

  it('skips a malformed JSON-LD block and keeps looking', () => {
    const html =
      ldBlock('{ "@type": "Recipe", oops }') +
      ldBlock(JSON.stringify(RECIPE));
    expect(JSON.parse(extractRecipeSource(html))).toEqual(RECIPE);
  });

  it('swallows a JSON-LD block that parses to null', () => {
    const html = `${ldBlock('null')}<p>Fallback text</p>`;
    expect(extractRecipeSource(html).trim()).toBe('Fallback text');
  });

  it('falls through to the text path when no node is a Recipe', () => {
    const html =
      ldBlock(JSON.stringify({ '@type': 'BreadcrumbList' })) +
      '<p>Plain page</p>';
    expect(extractRecipeSource(html).trim()).toBe('Plain page');
  });

  it('strips markup, script and style contents, nbsp, and repeated whitespace', () => {
    const html = `
      <html>
        <head><style>body { color: red; }</style></head>
        <body>
          <script>var analytics = 'tracked';</script>
          <h1>Toast</h1>
          <p>Bread&nbsp;and    butter.</p>
        </body>
      </html>
    `;
    const text = extractRecipeSource(html);
    expect(text.trim()).toBe('Toast Bread and butter.');
    expect(text).not.toContain('analytics');
    expect(text).not.toContain('color');
    expect(text).not.toContain('<');
  });

  it('caps the JSON-LD path at 60,000 characters', () => {
    const node = { ...RECIPE, description: 'x'.repeat(80000) };
    const html = ldBlock(JSON.stringify(node));
    expect(extractRecipeSource(html)).toHaveLength(60000);
  });

  it('caps the text path at 60,000 characters', () => {
    const html = `<p>${'word '.repeat(20000)}</p>`;
    expect(extractRecipeSource(html)).toHaveLength(60000);
  });

  it('prefers article text when nav chrome would eat the cap', () => {
    const nav = `<nav>${'Menu item '.repeat(8000)}</nav>`;
    const html = `${nav}<article><h1>Kapusnyak</h1><p>Ingredients: sauerkraut</p></article>`;
    const text = extractRecipeSource(html);
    expect(text).toContain('Kapusnyak');
    expect(text).toContain('sauerkraut');
    expect(text).not.toContain('Menu item');
  });

  it('prefers main when there is no article', () => {
    const nav = `<nav>${'Menu item '.repeat(8000)}</nav>`;
    const html = `${nav}<main class="Page-main"><h2>Ingredients</h2><p>pork shoulder</p></main>`;
    const text = extractRecipeSource(html);
    expect(text).toContain('Ingredients');
    expect(text).toContain('pork shoulder');
    expect(text).not.toContain('Menu item');
  });

  it('still prefers a Recipe JSON-LD node over article text', () => {
    const html =
      ldBlock(JSON.stringify(RECIPE)) +
      '<article><h1>A different dish</h1></article>';
    expect(JSON.parse(extractRecipeSource(html))).toEqual(RECIPE);
  });

  it('ignores a Recipe block whose ingredients and steps are blank', () => {
    const shell = {
      '@type': 'Recipe',
      name: 'Braised beef short ribs',
      recipeIngredient: [],
      recipeInstructions: [
        { '@type': 'HowToStep', position: 1 },
        { '@type': 'HowToStep', position: 2 },
      ],
    };
    const html =
      ldBlock(JSON.stringify({ '@graph': [shell, { '@type': 'Person', name: 'Maangchi' }] })) +
      '<div id="main"><h1>Galbi-jjim</h1><p>Ingredients: beef short ribs and soy sauce</p></div>';
    const text = extractRecipeSource(html);
    expect(text).toContain('Galbi-jjim');
    expect(text).toContain('beef short ribs');
    expect(text).not.toContain('HowToStep');
  });

  it('keeps a Recipe block that has ingredient text', () => {
    const node = { ...RECIPE, recipeIngredient: ['200 g pecorino'] };
    const html = ldBlock(JSON.stringify(node)) + '<p>Some other page text</p>';
    expect(JSON.parse(extractRecipeSource(html))).toEqual(node);
  });

  it('keeps text after a nested related-story article', () => {
    const html =
      '<article><h1>Borscht</h1><article><h2>Related</h2><p>Another soup</p></article><p>Ingredients: beets and beef</p></article>';
    const text = extractRecipeSource(html);
    expect(text).toContain('Borscht');
    expect(text).toContain('beets and beef');
  });

  it('uses the longer article when a header teaser comes first', () => {
    const html =
      '<article><h2>See also</h2><p>A short card</p></article><article><h1>Borscht</h1><p>Ingredients: beets and dill</p></article>';
    const text = extractRecipeSource(html);
    expect(text).toContain('beets and dill');
    expect(text).not.toContain('See also');
  });

  it('does not treat a bare less-than in the copy as a tag', () => {
    const nav = `<nav>${'Menu item '.repeat(8000)}</nav>`;
    const html = `${nav}<article><p>Heat to <350°F, don't rush.</p><p>Ingredients: beets</p></article>`;
    const text = extractRecipeSource(html);
    expect(text).toContain('beets');
    expect(text).not.toContain('Menu item');
  });

  it('does not stop a role=main region at the first inner close', () => {
    const nav = `<nav>${'Menu item '.repeat(8000)}</nav>`;
    const html = `${nav}<div role="main"><div class="breadcrumbs">Home</div><h1>Borscht</h1><p>Ingredients: beets</p></div>`;
    const text = extractRecipeSource(html);
    expect(text).toContain('Borscht');
    expect(text).toContain('beets');
    expect(text).not.toContain('Menu item');
  });

  it('prefers a large main over a short header teaser article', () => {
    const html =
      '<article><h2>See also</h2><p>Card</p></article><main><h1>Borscht</h1><p>Ingredients: beets and cabbage</p></main>';
    const text = extractRecipeSource(html);
    expect(text).toContain('beets and cabbage');
    expect(text).not.toContain('See also');
  });
});

const MINIMAL = {
  title: 'Tomato soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'tomatoes', quantity: 6 }] }],
  steps: [{ text: 'Simmer.' }],
  tags: ['soup'],
};

describe('normalizeImportedRecipe', () => {
  it('keeps a well-formed recipe as is', () => {
    expect(normalizeImportedRecipe(MINIMAL)).toEqual(MINIMAL);
  });

  it('keeps only recipe keys', () => {
    const recipe = normalizeImportedRecipe({
      ...MINIMAL,
      description: 'Warming.',
      notes: 'Freezes well.',
      prepMinutes: 5,
      cookMinutes: 20,
      photoId: 'not-from-a-model',
      sourceUrl: 'https://model.example/invented',
      nutrition: { calories: 100 },
    });
    expect(Object.keys(recipe ?? {}).sort()).toEqual([
      'cookMinutes',
      'description',
      'ingredientSections',
      'notes',
      'prepMinutes',
      'servings',
      'steps',
      'tags',
      'title',
    ]);
  });

  it('returns null without a usable title', () => {
    expect(normalizeImportedRecipe({ ...MINIMAL, title: '   ' })).toBeNull();
    expect(normalizeImportedRecipe({ ...MINIMAL, title: 42 })).toBeNull();
    expect(normalizeImportedRecipe({ ...MINIMAL, title: undefined })).toBeNull();
    expect(normalizeImportedRecipe('not an object')).toBeNull();
    expect(normalizeImportedRecipe(null)).toBeNull();
    expect(normalizeImportedRecipe([MINIMAL])).toBeNull();
  });

  it('defaults an unusable serving count to 1', () => {
    for (const servings of [undefined, 0, -3, Number.NaN, Infinity, 'four']) {
      expect(normalizeImportedRecipe({ ...MINIMAL, servings })).toMatchObject({ servings: 1 });
    }
    expect(normalizeImportedRecipe({ ...MINIMAL, servings: 2.5 })).toMatchObject({
      servings: 2.5,
    });
  });

  it('trims strings and drops ingredients without an item', () => {
    const recipe = normalizeImportedRecipe({
      ...MINIMAL,
      title: '  Tomato soup  ',
      ingredientSections: [
        {
          name: '  Base  ',
          items: [
            { item: '  tomatoes  ', quantity: 6, unit: ' piece ', note: ' ripe ' },
            { item: '   ' },
            { quantity: 2 },
            'nonsense',
          ],
        },
      ],
    });
    expect(recipe).toMatchObject({
      title: 'Tomato soup',
      ingredientSections: [
        {
          name: 'Base',
          items: [{ item: 'tomatoes', quantity: 6, unit: 'piece', note: 'ripe' }],
        },
      ],
    });
  });

  it('drops sections that end up empty, and malformed steps and tags', () => {
    expect(
      normalizeImportedRecipe({
        ...MINIMAL,
        ingredientSections: [{ items: [] }, { items: ['x'] }, 'nope', { name: 'Sauce' }],
        steps: [{ text: 'Keep.' }, { text: '  ' }, { notText: 1 }, 'nope'],
        tags: ['soup', ' soup ', '', 7, 'winter'],
      }),
    ).toMatchObject({
      ingredientSections: [],
      steps: [{ text: 'Keep.' }],
      tags: ['soup', 'winter'],
    });
  });

  it('keeps arrays present when the model omits them entirely', () => {
    expect(normalizeImportedRecipe({ title: 'Bare', servings: 1 })).toEqual({
      title: 'Bare',
      servings: 1,
      ingredientSections: [],
      steps: [],
      tags: [],
    });
  });

  it('drops negative durations rather than keeping them', () => {
    const recipe = normalizeImportedRecipe({ ...MINIMAL, prepMinutes: -5, cookMinutes: 0 });
    expect('prepMinutes' in (recipe ?? {})).toBe(false);
    expect(recipe).toMatchObject({ cookMinutes: 0 });
  });
});

describe('importFromSource', () => {
  it('does not call the model for blank source', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    expect(await importFromSource('  \n\t ', deps)).toEqual({ kind: 'empty_source' });
    expect(calls).toHaveLength(0);
  });

  it('sends the source to the model it was given', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromSource('Tomato soup: simmer tomatoes.', deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('test-model');
    expect(calls[0].contents).toContain('Tomato soup: simmer tomatoes.');
  });

  it('returns the normalized recipe', async () => {
    const { deps } = fakeImportDeps(JSON.stringify({ ...MINIMAL, servings: 0, extra: true }));
    expect(await importFromSource('soup', deps)).toEqual({
      kind: 'ok',
      recipe: { ...MINIMAL, servings: 1 },
    });
  });

  it('reports output that is not a JSON object as a parse error', async () => {
    for (const reply of [undefined, '', 'Sure! Here is the recipe', '42', 'null']) {
      const { deps } = fakeImportDeps(reply);
      expect(await importFromSource('soup', deps), String(reply)).toEqual({
        kind: 'parse_error',
      });
    }
  });

  it('reports the NOT_A_RECIPE sentinel', async () => {
    const { deps } = fakeImportDeps(JSON.stringify({ ...MINIMAL, title: 'NOT_A_RECIPE' }));
    expect(await importFromSource('a poem', deps)).toEqual({ kind: 'not_a_recipe' });
  });

  it('reports JSON with no usable title as unusable', async () => {
    const { deps } = fakeImportDeps(JSON.stringify({ ...MINIMAL, title: ' ' }));
    expect(await importFromSource('soup', deps)).toEqual({ kind: 'unusable' });
  });
});

describe('importFromHtml', () => {
  it('sends the extracted source, not the page', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    const html =
      '<html><head><script>var tracking = 1;</script></head>' +
      '<body><nav>Home</nav><main><p>Simmer the tomatoes.</p></main></body></html>';
    await importFromHtml(html, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].contents).toContain('Simmer the tomatoes.');
    expect(calls[0].contents).not.toContain('tracking');
  });

  it('treats a page with no text as empty', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    expect(await importFromHtml('<html><body> </body></html>', deps)).toEqual({
      kind: 'empty_source',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('fetchPageHtml', () => {
  const neverCalled: typeof fetch = () => {
    throw new Error('fetch should not be called');
  };

  it('rejects what is not a URL', async () => {
    expect(await fetchPageHtml('soup', neverCalled)).toEqual({ kind: 'invalid_url' });
  });

  it('rejects schemes other than http and https', async () => {
    expect(await fetchPageHtml('ftp://example.com/soup', neverCalled)).toEqual({
      kind: 'unsupported_scheme',
    });
  });

  it('reports a network failure as unreachable', async () => {
    const failing: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    expect(await fetchPageHtml('https://example.com/soup', failing)).toEqual({
      kind: 'unreachable',
    });
  });

  it('reports a non-2xx response with its status', async () => {
    const refusing: typeof fetch = () =>
      Promise.resolve(new Response('challenge page', { status: 403 }));
    expect(await fetchPageHtml('https://example.com/soup', refusing)).toEqual({
      kind: 'refused',
      status: 403,
    });
  });

  it('returns the page body', async () => {
    const serving: typeof fetch = () => Promise.resolve(new Response('<html>soup</html>'));
    expect(await fetchPageHtml('https://example.com/soup', serving)).toEqual({
      kind: 'ok',
      html: '<html>soup</html>',
    });
  });
});
