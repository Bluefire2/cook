import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME, signSession } from './session.ts';
import {
  MAX_STT_BYTES,
  clipRecipeTitle,
  isSttByteCountTooLarge,
  normalizeSttContentType,
  sttPost,
} from './stt.ts';

describe('normalizeSttContentType', () => {
  it('strips codecs and accepts webm', () => {
    expect(normalizeSttContentType('audio/webm;codecs=opus')).toBe('audio/webm');
  });

  it('accepts mp4', () => {
    expect(normalizeSttContentType('audio/mp4')).toBe('audio/mp4');
  });

  it('rejects non-audio types', () => {
    expect(normalizeSttContentType('text/plain')).toBeNull();
    expect(normalizeSttContentType('image/jpeg')).toBeNull();
  });
});

describe('isSttByteCountTooLarge', () => {
  it('allows the cap and rejects above it', () => {
    expect(isSttByteCountTooLarge(MAX_STT_BYTES)).toBe(false);
    expect(isSttByteCountTooLarge(MAX_STT_BYTES + 1)).toBe(true);
  });
});

describe('clipRecipeTitle', () => {
  it('strips C0 controls and clips to 200 scalars', () => {
    expect(clipRecipeTitle('Soup\nStew')).toBe('SoupStew');
    const long = 'a'.repeat(250);
    expect(clipRecipeTitle(long).length).toBe(200);
  });

  it('trims leftover whitespace', () => {
    expect(clipRecipeTitle('  Gumbo  ')).toBe('Gumbo');
  });
});

describe('sttPost error codes', () => {
  const prev = {
    secret: process.env.SESSION_SECRET,
    allowed: process.env.ALLOWED_EMAILS,
    gemini: process.env.GEMINI_API_KEY,
  };

  beforeEach(() => {
    process.env.SESSION_SECRET = 'test-secret-for-session-hmac';
    process.env.ALLOWED_EMAILS = 'allowed@example.com';
  });

  afterEach(() => {
    restoreEnv('SESSION_SECRET', prev.secret);
    restoreEnv('ALLOWED_EMAILS', prev.allowed);
    restoreEnv('GEMINI_API_KEY', prev.gemini);
  });

  function ownerPost(): Request {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, Date.now());
    return new Request('http://localhost/api/stt', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
  }

  it('returns stt-unavailable when the assistant key is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    const response = await sttPost(ownerPost());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Assistant is unavailable.',
      code: 'stt-unavailable',
    });
  });

  it('returns stt-bad-request when the audio type is missing', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const response = await sttPost(ownerPost());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Bad request',
      code: 'stt-bad-request',
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
