import { describe, expect, it } from 'vitest';
import { extractRecipeSource } from '../../api/import';

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
