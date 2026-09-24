import { describe, expect, it } from 'vitest';
import { relativeExpiryLabel, relativeMinutesLabel } from './relativeTime';

describe('relativeMinutesLabel', () => {
  const now = 1_000_000_000_000;

  it("is 'just now' while the rounded age is under a minute", () => {
    expect(relativeMinutesLabel(now, now)).toBe('just now');
    expect(relativeMinutesLabel(now - 29_999, now)).toBe('just now');
  });

  it('rounds half a minute up, matching the Settings idiom', () => {
    expect(relativeMinutesLabel(now - 30_000, now)).toBe('1 min ago');
    expect(relativeMinutesLabel(now - 89_999, now)).toBe('1 min ago');
    expect(relativeMinutesLabel(now - 90_000, now)).toBe('2 min ago');
  });

  it('labels whole minutes', () => {
    expect(relativeMinutesLabel(now - 5 * 60_000, now)).toBe('5 min ago');
  });
});

describe('relativeExpiryLabel', () => {
  const now = 1_000_000_000_000;

  it('describes the last minute, hours, and days', () => {
    expect(relativeExpiryLabel(now, now)).toBe('expires in under a minute');
    expect(relativeExpiryLabel(now + 5 * 60_000, now)).toBe('expires in 5 min');
    expect(relativeExpiryLabel(now + 3 * 60 * 60_000, now)).toBe('expires in 3 h');
    expect(relativeExpiryLabel(now + 7 * 24 * 60 * 60_000, now)).toBe('expires in 7 days');
  });
});
