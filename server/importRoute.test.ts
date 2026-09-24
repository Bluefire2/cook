import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeImportDeps } from './fakeGemini.ts';
import { importPost } from './importRoute.ts';

const RECIPE = {
  title: 'Tomato soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'tomatoes', quantity: 6 }] }],
  steps: [{ text: 'Simmer.' }],
  tags: ['soup'],
};

const PAGE = '<html><body><main><p>Simmer the tomatoes.</p></main></body></html>';

async function post(body: unknown, reply: string | undefined = JSON.stringify(RECIPE)) {
  const { deps, calls } = fakeImportDeps(reply);
  const req = new Request('http://localhost/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await importPost(req, { authorizedSub: 'sub-1' }, deps);
  return { status: response.status, body: (await response.json()) as unknown, calls };
}

function serve(response: Response) {
  const fetchMock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/import', () => {
  it('returns the normalized recipe for pasted text, without sourceUrl', async () => {
    const result = await post(
      { text: '  Tomato soup: simmer.  ' },
      JSON.stringify({ ...RECIPE, servings: 0, photoId: 'x' }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ recipe: { ...RECIPE, servings: 1 } });
    expect(result.calls[0].contents).toContain('Tomato soup: simmer.');
  });

  it('returns the normalized recipe and sourceUrl for a URL', async () => {
    serve(new Response(PAGE));
    const result = await post({ url: 'https://example.com/soup' });
    expect(result).toMatchObject({
      status: 200,
      body: { recipe: { ...RECIPE, sourceUrl: 'https://example.com/soup' } },
    });
    expect(result.calls[0].contents).toContain('Simmer the tomatoes.');
  });

  it('prefers the URL when both are given', async () => {
    serve(new Response(PAGE));
    const result = await post({ url: 'https://example.com/soup', text: 'Other text' });
    expect(result.calls[0].contents).not.toContain('Other text');
  });

  it('rejects a request with nothing to import', async () => {
    for (const body of [{}, { text: '' }, { text: '   ' }]) {
      const result = await post(body);
      expect(result).toMatchObject({
        status: 400,
        body: { error: 'Provide a URL or recipe text.' },
      });
      expect(result.calls).toHaveLength(0);
    }
  });

  it('rejects a page with no readable text like an empty request', async () => {
    serve(new Response('<html><body><script>x()</script></body></html>'));
    const result = await post({ url: 'https://example.com/soup' });
    expect(result).toMatchObject({ status: 400, body: { error: 'Provide a URL or recipe text.' } });
    expect(result.calls).toHaveLength(0);
  });

  it('maps fetch failures to 422 with the existing copy', async () => {
    expect(await post({ url: 'soup' })).toMatchObject({
      status: 422,
      body: { error: 'That does not look like a web address.' },
    });
    expect(await post({ url: 'ftp://example.com/soup' })).toMatchObject({
      status: 422,
      body: { error: 'Only http and https URLs are supported.' },
    });

    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    expect(await post({ url: 'https://example.com/soup' })).toMatchObject({
      status: 422,
      body: { error: 'Could not reach that URL.' },
    });

    serve(new Response('challenge', { status: 403 }));
    expect(await post({ url: 'https://example.com/soup' })).toMatchObject({
      status: 422,
      body: {
        error: 'The site refused the request (403). Try pasting the recipe text instead.',
      },
    });
  });

  it('maps model outcomes to the existing statuses', async () => {
    expect(await post({ text: 'a poem' }, JSON.stringify({ title: 'NOT_A_RECIPE' }))).toMatchObject({
      status: 422,
      body: { error: "Couldn't find a recipe in that content." },
    });
    expect(await post({ text: 'soup' }, 'not json')).toMatchObject({
      status: 502,
      body: { error: 'Extraction failed — no structured result.' },
    });
    expect(await post({ text: 'soup' }, JSON.stringify({ servings: 2 }))).toMatchObject({
      status: 502,
      body: { error: 'Extraction failed — no structured result.' },
    });
  });
});
