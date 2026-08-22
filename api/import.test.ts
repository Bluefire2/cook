import { describe, expect, it } from 'vitest';
import { extractRecipeSource } from './import';

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
});
