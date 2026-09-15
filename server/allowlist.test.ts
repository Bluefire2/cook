import { describe, expect, it } from 'vitest';
import { isAllowed, parseAllowedEmails } from './allowlist.ts';

describe('parseAllowedEmails', () => {
  it('lowercases, trims, and drops empties', () => {
    expect([...parseAllowedEmails(' A@B.C , , b@d.e ')]).toEqual(['a@b.c', 'b@d.e']);
  });
});

describe('isAllowed', () => {
  it('denies when the allowlist is blank', () => {
    expect(isAllowed('a@b.c', true, '')).toBe(false);
    expect(isAllowed('a@b.c', true, '   ')).toBe(false);
  });

  it('has no allow-all branch for an empty parsed list', () => {
    expect(isAllowed('a@b.c', true, ',')).toBe(false);
  });

  it('is case and whitespace insensitive', () => {
    expect(isAllowed('Chernyshov.K@Gmail.com', true, ' chernyshov.k@gmail.com ')).toBe(true);
  });

  it('denies unverified email', () => {
    expect(isAllowed('a@b.c', false, 'a@b.c')).toBe(false);
    expect(isAllowed('a@b.c', undefined, 'a@b.c')).toBe(false);
  });

  it('denies email not on the list', () => {
    expect(isAllowed('other@example.com', true, 'a@b.c')).toBe(false);
  });

  it('allows a listed verified email', () => {
    expect(isAllowed('a@b.c', true, 'a@b.c,b@d.e')).toBe(true);
  });
});
