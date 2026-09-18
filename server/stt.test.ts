import { describe, expect, it } from 'vitest';
import {
  MAX_STT_BYTES,
  clipRecipeTitle,
  isSttByteCountTooLarge,
  normalizeSttContentType,
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
