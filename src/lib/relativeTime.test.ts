import { describe, expect, it } from 'vitest';
import { relativeAgoLabel, relativeExpiryLabel } from './relativeTime';

describe('relativeAgoLabel', () => {
  const now = 1_000_000_000_000;

  it("is 'just now' for a future or unusable timestamp", () => {
    expect(relativeAgoLabel(now + 1, now)).toBe('just now');
    expect(relativeAgoLabel(now + 5 * 60_000, now)).toBe('just now');
    expect(relativeAgoLabel(Number.NaN, now)).toBe('just now');
    expect(relativeAgoLabel(now, Number.NaN)).toBe('just now');
  });

  it('switches unit at the date-fns boundaries', () => {
    expect(relativeAgoLabel(now - 29_999, now)).toBe('less than a minute ago');
    expect(relativeAgoLabel(now - 30_000, now)).toBe('1 minute ago');
    expect(relativeAgoLabel(now - 89_999, now)).toBe('1 minute ago');
    expect(relativeAgoLabel(now - 90_000, now)).toBe('2 minutes ago');
    expect(relativeAgoLabel(now - (44 * 60_000 + 29_000), now)).toBe('44 minutes ago');
    expect(relativeAgoLabel(now - (44 * 60_000 + 30_000), now)).toBe('about 1 hour ago');
    expect(relativeAgoLabel(now - ((23 * 60 + 59) * 60_000 + 30_000), now)).toBe('1 day ago');
    expect(relativeAgoLabel(now - 30 * 24 * 60 * 60_000, now)).toBe('about 1 month ago');
  });

  it('uses minutes, hours, and days as the delta grows', () => {
    expect(relativeAgoLabel(now, now)).toBe('less than a minute ago');
    expect(relativeAgoLabel(now - 20_000, now)).toBe('less than a minute ago');
    expect(relativeAgoLabel(now - 60_000, now)).toBe('1 minute ago');
    expect(relativeAgoLabel(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(relativeAgoLabel(now - 3 * 60 * 60_000, now)).toBe('about 3 hours ago');
    expect(relativeAgoLabel(now - 10112 * 60_000, now)).toBe('7 days ago');
    expect(relativeAgoLabel(now - 11828 * 60_000, now)).toBe('8 days ago');
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
