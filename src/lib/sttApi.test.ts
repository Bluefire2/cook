import { afterEach, describe, expect, it, vi } from 'vitest';
import * as session from './session';
import { settings } from './settings';
import { transcribeAudio } from './sttApi';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubSttFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function postedHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  expect(fetchMock).toHaveBeenCalledOnce();
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/stt');
  return init.headers as Record<string, string>;
}

describe('transcribeAudio', () => {
  it('returns stripped text on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ text: '"hello there"' }), { status: 200 }),
      ),
    );
    const text = await transcribeAudio({ blob: new Blob(['x'], { type: 'audio/webm' }) });
    expect(text).toBe('hello there');
  });

  it('invalidates the session on 401 only', async () => {
    const invalidateSpy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
      ),
    );
    await expect(
      transcribeAudio({ blob: new Blob(['x'], { type: 'audio/webm' }) }),
    ).rejects.toThrow('Please sign in again — your session expired.');
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('does not invalidate on 503', async () => {
    const invalidateSpy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'Membership unavailable' }), {
          status: 503,
        }),
      ),
    );
    await expect(
      transcribeAudio({ blob: new Blob(['x'], { type: 'audio/webm' }) }),
    ).rejects.toThrow('Membership unavailable');
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('sends a URI-encoded Cyrillic title, the uri marker, and the UI language', async () => {
    vi.spyOn(settings, 'getLocale').mockReturnValue('uk');
    const fetchMock = stubSttFetch();
    const title = 'Борщ український';

    await transcribeAudio({ blob: new Blob(['x'], { type: 'audio/webm' }), title });

    const headers = postedHeaders(fetchMock);
    expect(headers['x-recipe-title']).toBe(encodeURIComponent(title));
    expect(headers['x-recipe-title']).not.toBe(title);
    expect(headers['x-recipe-title-encoding']).toBe('uri');
    expect(headers['x-sous-language']).toBe('uk');
  });

  it('URI-encodes an ASCII title and still sends the uri marker and UI language', async () => {
    vi.spyOn(settings, 'getLocale').mockReturnValue('zh-Hans');
    const fetchMock = stubSttFetch();
    const title = 'Chicken soup';

    await transcribeAudio({ blob: new Blob(['x'], { type: 'audio/webm' }), title });

    const headers = postedHeaders(fetchMock);
    expect(headers['x-recipe-title']).toBe('Chicken%20soup');
    expect(headers['x-recipe-title']).toBe(encodeURIComponent(title));
    expect(headers['x-recipe-title-encoding']).toBe('uri');
    expect(headers['x-sous-language']).toBe('zh-Hans');
  });

  it('omits the title headers when the title is missing or blank', async () => {
    vi.spyOn(settings, 'getLocale').mockReturnValue('ru');
    const fetchMock = stubSttFetch();

    await transcribeAudio({ blob: new Blob(['x'], { type: 'audio/webm' }), title: '   ' });

    const headers = postedHeaders(fetchMock);
    expect(headers['x-recipe-title']).toBeUndefined();
    expect(headers['x-recipe-title-encoding']).toBeUndefined();
    expect(headers['x-sous-language']).toBe('ru');
  });
});
