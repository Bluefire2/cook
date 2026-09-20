import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extensionImport, isExtensionOrigin } from './extensionImport.ts';
import { SESSION_HEADER_NAME, signSession } from './session.ts';

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
    process.env.SESSION_SECRET = 'test-secret-for-session-hmac';
    process.env.ALLOWED_EMAILS = 'allowed@example.com';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

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

  async function expectNoFetch(body: unknown): Promise<void> {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await extensionImport(authedRequest(body));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'Could not read that page.' });
    expect(fetchMock).not.toHaveBeenCalled();
  }

  it('rejects missing html without fetching the url', async () => {
    await expectNoFetch({ url: 'https://apnews.com/article/example' });
  });

  it('rejects empty html without fetching the url', async () => {
    await expectNoFetch({ url: 'https://apnews.com/article/example', html: '' });
  });

  it('rejects whitespace html without fetching the url', async () => {
    await expectNoFetch({ url: 'https://apnews.com/article/example', html: '  \n\t  ' });
  });
});
