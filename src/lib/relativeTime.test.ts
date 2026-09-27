import { describe, expect, it } from 'vitest';
import { relativeAgoLabel, relativeExpiryLabel } from './relativeTime';

describe('relativeAgoLabel', () => {
  const now = 1_000_000_000_000;

  it("is 'just now' when the timestamp is in the future", () => {
    expect(relativeAgoLabel(now + 1, now)).toBe('just now');
    expect(relativeAgoLabel(now + 5 * 60_000, now)).toBe('just now');
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
