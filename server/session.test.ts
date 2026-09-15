import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearedSessionCookie,
  oauthCookie,
  readCookie,
  readSession,
  safeReturnTo,
  sessionCookie,
  sessionFrom,
  signOauthTx,
  signSession,
  verifyOauthTx,
  verifySession,
} from './session.ts';

const ORIGIN = 'http://localhost:5173';
function nowMs(): number {
  return Date.now();
}

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-for-session-hmac';
  process.env.ALLOWED_EMAILS = 'allowed@example.com';
});

describe('signSession / verifySession', () => {
  it('round-trips sub and email', () => {
    const now = nowMs();
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, now);
    const session = verifySession(token, now);
    expect(session).toEqual({
      sub: 'sub-1',
      email: 'allowed@example.com',
      iat: now,
      exp: now + 90 * 24 * 60 * 60 * 1000,
    });
  });

  it('rejects a tampered payload', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    const [p, s] = token.split('.');
    expect(verifySession(`${p}x.${s}`, nowMs())).toBeNull();
  });

  it('rejects a signature with extra non-alphabet characters', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    const [p, s] = token.split('.');
    expect(verifySession(`${p}.${s}!`, nowMs())).toBeNull();
  });

  it('rejects a signature from a different secret', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    process.env.SESSION_SECRET = 'other-secret';
    expect(verifySession(token, nowMs())).toBeNull();
  });

  it('rejects expired tokens', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    expect(verifySession(token, nowMs() + 100 * 24 * 3600 * 1000)).toBeNull();
  });

  it('rejects wrong version and malformed tokens', () => {
    process.env.SESSION_SECRET = 'test-secret-for-session-hmac';
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    const [p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
    payload.v = 2;
    const bad = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect(verifySession(bad, nowMs())).toBeNull();
    expect(verifySession('', nowMs())).toBeNull();
    expect(verifySession('a', nowMs())).toBeNull();
    expect(verifySession('a.b.c', nowMs())).toBeNull();
  });
});

describe('readSession', () => {
  it('is absent without a cookie header', () => {
    const req = new Request('http://localhost/');
    expect(readSession(req)).toEqual({ status: 'absent' });
  });

  it('is unusable for garbage cookie', () => {
    const req = new Request('http://localhost/', {
      headers: { cookie: 'sous_session=garbage.garbage' },
    });
    expect(readSession(req)).toEqual({ status: 'unusable' });
  });

  it('is unusable when allowlist misses', () => {
    const token = signSession({ sub: 'sub-1', email: 'not@listed.com' }, nowMs());
    const req = new Request('http://localhost/', {
      headers: { cookie: `sous_session=${token}` },
    });
    expect(readSession(req)).toEqual({ status: 'unusable' });
  });

  it('is ok for a valid allowlisted cookie', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    const req = new Request('http://localhost/', {
      headers: { cookie: `sous_session=${token}` },
    });
    const result = readSession(req);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.session.sub).toBe('sub-1');
    }
  });

  it('treats blank SESSION_SECRET as unusable when a cookie is present', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    process.env.SESSION_SECRET = '';
    const req = new Request('http://localhost/', {
      headers: { cookie: `sous_session=${token}` },
    });
    expect(readSession(req)).toEqual({ status: 'unusable' });
    expect(sessionFrom(req)).toBeNull();
  });

  it('is absent when secret is blank and no cookie', () => {
    process.env.SESSION_SECRET = '';
    const req = new Request('http://localhost/');
    expect(readSession(req)).toEqual({ status: 'absent' });
  });
});

describe('readCookie', () => {
  it('parses absent, single, multiple, and values with equals', () => {
    expect(readCookie(new Request('http://x/'), 'a')).toBeNull();
    expect(
      readCookie(new Request('http://x/', { headers: { cookie: 'a=1' } }), 'a'),
    ).toBe('1');
    expect(
      readCookie(
        new Request('http://x/', { headers: { cookie: 'a=1; b=2; c=3' } }),
        'b',
      ),
    ).toBe('2');
    expect(
      readCookie(
        new Request('http://x/', { headers: { cookie: ' a=1 ; b=2 ' } }),
        'a',
      ),
    ).toBe('1');
    expect(
      readCookie(
        new Request('http://x/', { headers: { cookie: 'sig=abc=def=' } }),
        'sig',
      ),
    ).toBe('abc=def=');
  });
});

describe('sessionCookie', () => {
  it('includes HttpOnly, SameSite=Lax, Path=/, and Secure when asked', () => {
    const withSecure = sessionCookie('tok', { secure: true });
    expect(withSecure).toContain('HttpOnly');
    expect(withSecure).toContain('SameSite=Lax');
    expect(withSecure).toContain('Path=/');
    expect(withSecure).toContain('Secure');
    const plain = sessionCookie('tok', { secure: false });
    expect(plain).not.toContain('Secure');
    expect(clearedSessionCookie({ secure: false })).toContain('Max-Age=0');
    expect(oauthCookie('tok', { secure: true })).toContain('Max-Age=600');
  });
});

describe('safeReturnTo', () => {
  it('keeps /settings and rejects open redirects', () => {
    expect(safeReturnTo('/settings', ORIGIN)).toBe('/settings');
    for (const bad of [
      '//evil.example',
      '/\\evil.example',
      '/%5Cevil.example',
      '/%5cevil.example',
      'https://evil.example/',
      '/path\\nasty',
      '/\n',
    ]) {
      expect(safeReturnTo(bad, ORIGIN)).toBe('/');
    }
  });
});

describe('signOauthTx / verifyOauthTx', () => {
  it('round-trips oauth transaction fields', () => {
    const token = signOauthTx(
      { state: 'st', nonce: 'no', verifier: 'ver', returnTo: '/settings' },
      nowMs(),
    );
    expect(verifyOauthTx(token, nowMs())).toMatchObject({
      state: 'st',
      nonce: 'no',
      verifier: 'ver',
      returnTo: '/settings',
    });
  });
});
