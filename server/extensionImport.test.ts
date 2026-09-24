import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extensionImport, isExtensionOrigin } from './extensionImport.ts';
import { fakeImportDeps } from './fakeGemini.ts';
import * as recipeImport from './recipeImport.ts';
import { SESSION_HEADER_NAME, signSession } from './session.ts';

// Spied rather than replaced: the assertion that matters is that empty html
// short-circuits *before* the import pipeline. Without this the tests pass with
// the guard deleted, because an empty source answers with the same 422.
vi.mock('./recipeImport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./recipeImport.ts')>();
  return {
    ...actual,
    importFromHtml: vi.fn(actual.importFromHtml),
  };
});

const SESSION_ENV = {
  SESSION_SECRET: 'test-secret-for-session-hmac',
  ALLOWED_EMAILS: 'allowed@example.com',
};

function authedRequest(body: unknown): Request {
  const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, Date.now());
  return new Request('http://localhost/api/extension/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SESSION_HEADER_NAME]: token,
    },
    body: JSON.stringify(body),
  });
}

describe('isExtensionOrigin', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';

  it('accepts a real extension origin', () => {
    expect(isExtensionOrigin(`chrome-extension://${id}`)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const origin of [
      null,
      '',
      'https://sous.kyrylo.lol',
      'http://localhost:5173',
      `chrome-extension://${id.slice(0, 31)}`,
      `chrome-extension://${id}q`,
      `chrome-extension://${id.toUpperCase()}`,
      `chrome-extension://${id}/popup.html`,
      `chrome-extension://${id} https://evil.example`,
      `moz-extension://${id}`,
      `chrome-extension://${id.slice(0, 30)}12`,
    ]) {
      expect(isExtensionOrigin(origin)).toBe(false);
    }
  });
});

describe('extensionImport html is required', () => {
  beforeEach(() => {
    Object.assign(process.env, SESSION_ENV);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function expectRejectedUnread(body: unknown): Promise<void> {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(recipeImport.importFromHtml).mockClear();
    const { deps, calls } = fakeImportDeps(undefined);
    const response = await extensionImport(authedRequest(body), deps);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'Could not read that page.' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recipeImport.importFromHtml).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  }

  it('rejects missing html without fetching or extracting', async () => {
    await expectRejectedUnread({ url: 'https://apnews.com/article/example' });
  });

  it('rejects empty html without fetching or extracting', async () => {
    await expectRejectedUnread({ url: 'https://apnews.com/article/example', html: '' });
  });

  it('rejects whitespace html without fetching or extracting', async () => {
    await expectRejectedUnread({ url: 'https://apnews.com/article/example', html: '  \n\t  ' });
  });
});

describe('extensionImport maps import outcomes', () => {
  const url = 'https://example.com/soup';
  const page = '<html><body><main><p>Simmer the tomatoes.</p></main></body></html>';

  beforeEach(() => {
    Object.assign(process.env, SESSION_ENV);
  });

  async function post(html: string, reply: string | undefined) {
    const { deps, calls } = fakeImportDeps(reply);
    const response = await extensionImport(authedRequest({ url, html }), deps);
    return { status: response.status, body: (await response.json()) as unknown, calls };
  }

  it('answers a page with no text as unreadable, without calling the model', async () => {
    const result = await post('<html><body><script>x()</script></body></html>', '{}');
    expect(result).toMatchObject({ status: 422, body: { error: 'Could not read that page.' } });
    expect(result.calls).toHaveLength(0);
  });

  it('answers NOT_A_RECIPE with 422', async () => {
    expect(await post(page, JSON.stringify({ title: 'NOT_A_RECIPE' }))).toMatchObject({
      status: 422,
      body: { error: "Couldn't find a recipe in that content." },
    });
  });

  it('answers unparseable model output with 502', async () => {
    expect(await post(page, 'not json')).toMatchObject({
      status: 502,
      body: { error: 'Extraction failed — no structured result.' },
    });
  });

  it('answers a recipe with no title as unusable', async () => {
    expect(await post(page, JSON.stringify({ title: ' ', servings: 2 }))).toMatchObject({
      status: 502,
      body: { error: 'Extraction produced an unusable recipe.' },
    });
  });

  it('answers a recipe too large to push as unusable', async () => {
    const huge = JSON.stringify({ title: 'Soup', servings: 2, notes: 'x'.repeat(200_000) });
    expect(await post(page, huge)).toMatchObject({
      status: 502,
      body: { error: 'Extraction produced an unusable recipe.' },
    });
  });
});
