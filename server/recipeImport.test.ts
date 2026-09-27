import { MediaResolution, type Content } from '@google/genai';
import { describe, expect, it } from 'vitest';
import type { RecipeDraft } from '../src/lib/types.ts';
import { fakeImportDeps, fakeImportDepsReplies } from '../test/fakeGemini.ts';
import {
  extractRecipeSource,
  fetchPageHtml,
  importFromHtml,
  importFromImages,
  importFromSource,
  MAX_PHOTO_UNIT_CHARS,
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

describe('importFromImages', () => {
  const JPEG = { mediaType: 'image/jpeg', base64: 'AAAA' };

  async function promptFor(extraText: string): Promise<string> {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromImages([JPEG], extraText, deps);
    const parts = (calls[0].contents as Content[])[0].parts ?? [];
    return parts[parts.length - 1].text ?? '';
  }

  it('returns empty_source and does not call the model with no images', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    expect(await importFromImages([], 'notes', deps)).toEqual({ kind: 'empty_source' });
    expect(calls).toHaveLength(0);
  });

  it('sends each photo as an inlineData part, in order, then one prompt part', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    const images = [
      { mediaType: 'image/jpeg', base64: 'AAAA' },
      { mediaType: 'image/png', base64: 'BBBB' },
      { mediaType: 'image/webp', base64: 'CCCC' },
    ];
    await importFromImages(images, '', deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('test-model');
    const contents = calls[0].contents as Content[];
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
    const parts = contents[0].parts ?? [];
    expect(parts).toHaveLength(4);
    images.forEach((image, i) => {
      expect(parts[i]).toEqual({ inlineData: { mimeType: image.mediaType, data: image.base64 } });
    });
    expect(typeof parts[3].text).toBe('string');
    expect(parts[3].inlineData).toBeUndefined();
  });

  it('asks for high media resolution with the shared recipe schema', async () => {
    const photo = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromImages([JPEG], '', photo.deps);
    const text = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromSource('soup', text.deps);

    const config = photo.calls[0].config;
    expect(config?.mediaResolution).toBe(MediaResolution.MEDIA_RESOLUTION_HIGH);
    expect(config?.mediaResolution).toBe('MEDIA_RESOLUTION_HIGH');
    expect(config?.maxOutputTokens).toBe(4096);
    expect(config?.responseMimeType).toBe('application/json');
    expect(config?.responseSchema).toBe(text.calls[0].config?.responseSchema);
  });

  it('keeps the text import request unchanged', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromSource('soup', deps);
    expect('mediaResolution' in (calls[0].config ?? {})).toBe(false);
    expect(typeof calls[0].contents).toBe('string');
  });

  it('tells the model to transcribe faithfully', async () => {
    const prompt = await promptFor('');
    for (const phrase of [
      'in the order given',
      'crossed out',
      '(?)',
      'tablespoon',
      'teaspoon',
      'notes',
      'Never invent',
      'NOT_A_RECIPE',
    ]) {
      expect(prompt, phrase).toContain(phrase);
    }
  });

  it('adds the notes as context only when given', async () => {
    const withNotes = await promptFor("  Grandma's, 1970s  ");
    expect(withNotes).toContain('Notes from the person importing');
    expect(withNotes).toContain("Grandma's, 1970s");

    const blank = await promptFor('   ');
    expect(blank).not.toContain('Notes from');
    expect(blank.endsWith('If the photos contain no recipe, save a recipe with the title "NOT_A_RECIPE".')).toBe(
      true,
    );
  });

  it('maps the model reply like text import', async () => {
    for (const reply of [undefined, '', 'Sure!', '42', 'null']) {
      const { deps } = fakeImportDeps(reply);
      expect(await importFromImages([JPEG], '', deps), String(reply)).toEqual({
        kind: 'parse_error',
      });
    }
    const cases: [unknown, unknown][] = [
      [{ ...MINIMAL, title: 'NOT_A_RECIPE' }, { kind: 'not_a_recipe' }],
      [{ ...MINIMAL, title: ' ' }, { kind: 'unusable' }],
      [{ ...MINIMAL, servings: 0, photoId: 'x' }, { kind: 'ok', recipe: { ...MINIMAL, servings: 1 } }],
    ];
    for (const [reply, outcome] of cases) {
      const { deps } = fakeImportDeps(JSON.stringify(reply));
      expect(await importFromImages([JPEG], '', deps)).toEqual(outcome);
    }
  });

  describe('retry and unit check', () => {
    const runaway = 'lb combat/lb weight (#) converted to lb/lb format -> lb (1.5 lb)';

    function withUnit(unit: string) {
      return {
        ...MINIMAL,
        ingredientSections: [{ items: [{ item: 'tomatoes', quantity: 6, unit }] }],
      };
    }

    it('retries once after a reply that is not JSON, and returns the second outcome', async () => {
      const fake = fakeImportDepsReplies(['Sure!', JSON.stringify(MINIMAL)]);
      expect(await importFromImages([JPEG], '', fake.deps)).toEqual({ kind: 'ok', recipe: MINIMAL });
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[1]).toEqual(fake.calls[0]);
    });

    it('retries once after an unusable reply', async () => {
      const fake = fakeImportDepsReplies([
        JSON.stringify({ ...MINIMAL, title: ' ' }),
        JSON.stringify(MINIMAL),
      ]);
      expect(await importFromImages([JPEG], '', fake.deps)).toEqual({ kind: 'ok', recipe: MINIMAL });
      expect(fake.calls).toHaveLength(2);
    });

    it('retries once after a runaway unit', async () => {
      const fake = fakeImportDepsReplies([
        JSON.stringify(withUnit(runaway)),
        JSON.stringify(MINIMAL),
      ]);
      expect(await importFromImages([JPEG], '', fake.deps)).toEqual({ kind: 'ok', recipe: MINIMAL });
      expect(fake.calls).toHaveLength(2);
    });

    it('returns the second outcome without a third call', async () => {
      const blankTitle = JSON.stringify({ ...MINIMAL, title: ' ' });
      const bothRunaway = JSON.stringify(withUnit('x'.repeat(64)));
      const cases: [(string | undefined | Error)[], { kind: string }][] = [
        [['x', 'y'], { kind: 'parse_error' }],
        [[blankTitle, 'x'], { kind: 'parse_error' }],
        [['x', blankTitle], { kind: 'unusable' }],
        [[bothRunaway, bothRunaway], { kind: 'unusable' }],
      ];
      for (const [replies, outcome] of cases) {
        const fake = fakeImportDepsReplies(replies);
        expect(await importFromImages([JPEG], '', fake.deps)).toEqual(outcome);
        expect(fake.calls).toHaveLength(2);
      }
    });

    it('does not retry an ok reply', async () => {
      const fake = fakeImportDepsReplies([JSON.stringify(MINIMAL)]);
      expect(await importFromImages([JPEG], '', fake.deps)).toEqual({ kind: 'ok', recipe: MINIMAL });
      expect(fake.calls).toHaveLength(1);
    });

    it('does not retry NOT_A_RECIPE', async () => {
      const fake = fakeImportDepsReplies([JSON.stringify({ ...MINIMAL, title: 'NOT_A_RECIPE' })]);
      expect(await importFromImages([JPEG], '', fake.deps)).toEqual({ kind: 'not_a_recipe' });
      expect(fake.calls).toHaveLength(1);
    });

    it('does not retry when the model call throws', async () => {
      const fake = fakeImportDepsReplies([new Error('boom')]);
      await expect(importFromImages([JPEG], '', fake.deps)).rejects.toThrow('boom');
      expect(fake.calls).toHaveLength(1);
    });

    it('propagates a throw on the retry', async () => {
      const fake = fakeImportDepsReplies(['x', new Error('boom')]);
      await expect(importFromImages([JPEG], '', fake.deps)).rejects.toThrow('boom');
      expect(fake.calls).toHaveLength(2);
    });

    it('makes no call with no images', async () => {
      const fake = fakeImportDepsReplies([]);
      expect(await importFromImages([], '', fake.deps)).toEqual({ kind: 'empty_source' });
      expect(fake.calls).toHaveLength(0);
    });

    it('rejects a unit longer than MAX_PHOTO_UNIT_CHARS', async () => {
      expect(MAX_PHOTO_UNIT_CHARS).toBe(32);

      const over = JSON.stringify(withUnit('x'.repeat(33)));
      const bothOver = fakeImportDepsReplies([over, over]);
      expect(await importFromImages([JPEG], '', bothOver.deps)).toEqual({ kind: 'unusable' });
      expect(bothOver.calls).toHaveLength(2);

      const atCap = fakeImportDepsReplies([JSON.stringify(withUnit('x'.repeat(32)))]);
      expect(await importFromImages([JPEG], '', atCap.deps)).toEqual({
        kind: 'ok',
        recipe: withUnit('x'.repeat(32)),
      });
      expect(atCap.calls).toHaveLength(1);

      const padded = `  ${'x'.repeat(32)}  `;
      const trimmed = fakeImportDepsReplies([JSON.stringify(withUnit(padded))]);
      expect(await importFromImages([JPEG], '', trimmed.deps)).toEqual({
        kind: 'ok',
        recipe: withUnit('x'.repeat(32)),
      });
      expect(trimmed.calls).toHaveLength(1);

      const secondSection = {
        ...MINIMAL,
        ingredientSections: [
          { items: [{ item: 'tomatoes', quantity: 6 }] },
          { items: [{ item: 'salt', unit: 'x'.repeat(33) }] },
        ],
      };
      const second = JSON.stringify(secondSection);
      const inSecond = fakeImportDepsReplies([second, second]);
      expect(await importFromImages([JPEG], '', inSecond.deps)).toEqual({ kind: 'unusable' });
      expect(inSecond.calls).toHaveLength(2);
    });

    it('keeps ordinary units', async () => {
      const units = [
        'tsp',
        'tbsp',
        'cup',
        'lb',
        'oz',
        'g',
        'ml',
        'piece',
        'can',
        'square',
        'package',
        'slice',
        'stalk',
        'fl oz',
        'heaping tablespoons',
        'packages (10 ounces each)',
      ];
      const recipe = {
        ...MINIMAL,
        ingredientSections: [{ items: units.map((unit) => ({ item: unit, unit })) }],
      };
      const fake = fakeImportDepsReplies([JSON.stringify(recipe)]);
      expect(await importFromImages([JPEG], '', fake.deps)).toEqual({ kind: 'ok', recipe });
      expect(fake.calls).toHaveLength(1);
    });

    it('leaves text import without a retry or a unit check', async () => {
      const parse = fakeImportDepsReplies(['x']);
      expect(await importFromSource('soup', parse.deps)).toEqual({ kind: 'parse_error' });
      expect(parse.calls).toHaveLength(1);

      const unit = 'x'.repeat(64);
      const recipe = {
        ...MINIMAL,
        ingredientSections: [{ items: [{ item: 'flour', unit }] }],
      };
      const text = fakeImportDepsReplies([JSON.stringify(recipe)]);
      expect(await importFromSource('soup', text.deps)).toEqual({ kind: 'ok', recipe });
      expect(text.calls).toHaveLength(1);
    });

    it('sends the same photo request on the retry', async () => {
      const fake = fakeImportDepsReplies(['x', JSON.stringify(MINIMAL)]);
      expect(await importFromImages([JPEG], '', fake.deps)).toEqual({ kind: 'ok', recipe: MINIMAL });
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[1].config?.mediaResolution).toBe(MediaResolution.MEDIA_RESOLUTION_HIGH);
      expect(fake.calls[1].contents).toEqual(fake.calls[0].contents);
    });
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
