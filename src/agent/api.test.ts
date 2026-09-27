import { afterEach, describe, expect, it, vi } from 'vitest';
import * as session from '../lib/session';
import { createNdjsonParser, postAgent } from './api';

describe('createNdjsonParser', () => {
  it('parses events split across chunks and lines', () => {
    const parser = createNdjsonParser();
    const a = parser.push('{"t":"text","step":1,"d":"hel');
    expect(a).toEqual([]);
    const b = parser.push('lo"}\n{"t":"done"}\n');
    expect(b).toEqual([
      { t: 'text', step: 1, d: 'hello' },
      { t: 'done' },
    ]);
    expect(parser.finish()).toEqual({ events: [] });
  });

  it('decodes UTF-8 characters split across byte chunks', () => {
    const parser = createNdjsonParser();
    const full = '{"t":"text","step":1,"d":"café"}\n{"t":"done"}\n';
    const bytes = new TextEncoder().encode(full);
    const splitAt = bytes.indexOf(0xc3);
    const first = bytes.slice(0, splitAt + 1);
    const second = bytes.slice(splitAt + 1);
    expect(parser.push(first)).toEqual([]);
    const events = parser.push(second);
    expect(events[0]).toEqual({ t: 'text', step: 1, d: 'café' });
    expect(events[1]).toEqual({ t: 'done' });
  });

  it('skips malformed JSON lines without throwing', () => {
    const parser = createNdjsonParser();
    const events = parser.push('not json\n{"t":"done"}\n');
    expect(events).toEqual([{ t: 'done' }]);
  });

  it('ignores events with unknown t', () => {
    const parser = createNdjsonParser();
    const events = parser.push('{"t":"future","x":1}\n{"t":"done"}\n');
    expect(events).toEqual([{ t: 'done' }]);
  });

  it('marks truncated when done is missing', () => {
    const parser = createNdjsonParser();
    parser.push('{"t":"text","step":1,"d":"x"}\n');
    expect(parser.finish()).toEqual({ events: [], truncated: true });
  });

  it('parses a trailing line without a newline on finish', () => {
    const parser = createNdjsonParser();
    parser.push('{"t":"text","step":1,"d":"tail"}');
    const finish = parser.finish();
    expect(finish.events).toEqual([{ t: 'text', step: 1, d: 'tail' }]);
    expect(finish.truncated).toBe(true);
  });

  it('returns error when a line exceeds 1_000_000 bytes', () => {
    const parser = createNdjsonParser();
    const huge = 'x'.repeat(1_000_001);
    parser.push(`${huge}\n`);
    expect(parser.finish().error).toBe('Response too large.');
  });

  it('accepts string chunks', () => {
    const parser = createNdjsonParser();
    const events = parser.push('{"t":"done"}\n');
    expect(events).toEqual([{ t: 'done' }]);
  });
});

describe('postAgent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('invalidates session and throws on 401', async () => {
    const invalidateSpy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unauthorized', { status: 401 })),
    );
    await expect(
      postAgent({
        messages: [{ role: 'user', content: 'hi' }],
        clientNow: new Date().toISOString(),
        timeZone: 'UTC',
        onEvent: () => {},
      }),
    ).rejects.toThrow('Please sign in again');
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('returns aborted when fetch aborts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    );
    const controller = new AbortController();
    const readPromise = postAgent({
      messages: [{ role: 'user', content: 'hi' }],
      clientNow: new Date().toISOString(),
      timeZone: 'UTC',
      signal: controller.signal,
      onEvent: () => {},
    });
    controller.abort();
    const result = await readPromise;
    expect(result.aborted).toBe(true);
  });
});
