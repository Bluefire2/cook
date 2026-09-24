import { afterEach, describe, expect, it, vi } from 'vitest';
import * as session from './session';
import { transcribeAudio } from './sttApi';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
});
