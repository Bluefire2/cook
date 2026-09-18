import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { sessionSub as chatSessionSub } from './chat';
import { sessionSub as importSessionSub } from './import';

const SECRET = 'gate-test-secret';

function signToken(payload: Record<string, unknown>): string {
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payloadPart).digest('base64url');
  return `${payloadPart}.${sig}`;
}

function reqWithCookie(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers.cookie = `sous_session=${token}`;
  }
  return new Request('http://localhost/api/chat', { method: 'POST', headers });
}

const runners = [
  { name: 'chat', fn: chatSessionSub },
  { name: 'import', fn: importSessionSub },
] as const;

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  process.env.ALLOWED_EMAILS = 'allowed@example.com';
});

for (const { name, fn } of runners) {
  describe(`sessionSub (${name})`, () => {
    it('returns sub for a valid cookie', () => {
      const token = signToken({
        v: 1,
        sub: 'user-sub',
        email: 'allowed@example.com',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      expect(fn(reqWithCookie(token))).toBe('user-sub');
    });

    it('returns null for wrong secret', () => {
      const token = signToken({
        v: 1,
        sub: 'user-sub',
        email: 'allowed@example.com',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      process.env.SESSION_SECRET = 'other';
      expect(fn(reqWithCookie(token))).toBeNull();
    });

    it('returns null when expired', () => {
      const token = signToken({
        v: 1,
        sub: 'user-sub',
        email: 'allowed@example.com',
        iat: Date.now() - 1000,
        exp: Date.now() - 1,
      });
      expect(fn(reqWithCookie(token))).toBeNull();
    });

    it('returns null for malformed tokens', () => {
      expect(fn(reqWithCookie(''))).toBeNull();
      expect(fn(reqWithCookie('a'))).toBeNull();
      expect(fn(reqWithCookie('a.b.c'))).toBeNull();
      const token = signToken({
        v: 1,
        sub: 'user-sub',
        email: 'allowed@example.com',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      expect(fn(reqWithCookie(`${token}!`))).toBeNull();
    });

    it('returns null when email was removed from allowlist', () => {
      const token = signToken({
        v: 1,
        sub: 'user-sub',
        email: 'removed@example.com',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      expect(fn(reqWithCookie(token))).toBeNull();
    });

    it('returns null when SESSION_SECRET is blank', () => {
      process.env.SESSION_SECRET = '   ';
      const token = signToken({
        v: 1,
        sub: 'user-sub',
        email: 'allowed@example.com',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      expect(fn(reqWithCookie(token))).toBeNull();
    });

    it('returns null when only x-sous-user header is present', () => {
      const req = new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'x-sous-user': 'user-sub' },
      });
      expect(fn(req)).toBeNull();
    });
  });
}
