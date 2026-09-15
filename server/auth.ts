import { createHash, timingSafeEqual } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import {
  allowedEmails,
  googleClient,
  isSecureOrigin,
  publicOrigin,
  redirectUri,
} from './env.ts';
import { isAllowed } from './allowlist.ts';
import {
  clearedOauthCookie,
  clearedSessionCookie,
  oauthCookie,
  OAUTH_COOKIE_NAME,
  randomToken,
  readCookie,
  readSession,
  safeReturnTo,
  sessionCookie,
  shouldRefresh,
  signOauthTx,
  signSession,
  verifyOauthTx,
} from './session.ts';

let oauthClient: OAuth2Client | null = null;

function getOauthClient(): OAuth2Client {
  if (oauthClient === null) {
    const cfg = googleClient();
    oauthClient = new OAuth2Client(cfg.id, cfg.secret, redirectUri());
  }
  return oauthClient;
}

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function upsertUser(_sub: string, _email: string, _name: string | undefined): Promise<void> {
  // TODO(step 13): merge users/{sub} in Firestore when server/store.ts exists.
}

export async function authStart(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const returnTo = safeReturnTo(url.searchParams.get('returnTo'), publicOrigin());
  const state = randomToken(32);
  const nonce = randomToken(32);
  const pkce = pkcePair();
  const now = Date.now();
  const txToken = signOauthTx(
    { state, nonce, verifier: pkce.verifier, returnTo },
    now,
  );
  const secure = isSecureOrigin();
  const authUrl = getOauthClient().generateAuthUrl({
    scope: SCOPES,
    state,
    nonce,
    code_challenge: pkce.challenge,
    code_challenge_method: CodeChallengeMethod.S256,
    include_granted_scopes: false,
  });
  const headers = new Headers({ Location: authUrl });
  headers.append('Set-Cookie', oauthCookie(txToken, { secure }));
  return new Response(null, { status: 302, headers });
}

export async function authCallbackGoogle(req: Request): Promise<Response> {
  const secure = isSecureOrigin();
  const clearOauth = clearedOauthCookie({ secure });
  const respond = (
    status: number,
    options: {
      body?: string | null;
      location?: string;
      contentType?: string;
      extraCookies?: string[];
    } = {},
  ): Response => {
    const headers = new Headers();
    if (options.location !== undefined) {
      headers.set('Location', options.location);
    }
    if (options.contentType !== undefined) {
      headers.set('Content-Type', options.contentType);
    }
    headers.append('Set-Cookie', clearOauth);
    for (const cookie of options.extraCookies ?? []) {
      headers.append('Set-Cookie', cookie);
    }
    return new Response(options.body ?? null, { status, headers });
  };

  try {
    const url = new URL(req.url);
    const error = url.searchParams.get('error');
    if (error !== null && error !== '') {
      return respond(302, {
        location: `${publicOrigin()}/settings?signin=cancelled`,
      });
    }

    const oauthRaw = readCookie(req, OAUTH_COOKIE_NAME);
    if (oauthRaw === null) {
      return respond(400, { body: 'Sign-in failed' });
    }
    const txToken = verifyOauthTx(oauthRaw, Date.now());
    if (!txToken) {
      return respond(400, { body: 'Sign-in failed' });
    }

    const queryState = url.searchParams.get('state');
    if (queryState === null || !timingSafeEqualString(queryState, txToken.state)) {
      return respond(400, { body: 'Sign-in failed' });
    }

    const code = url.searchParams.get('code');
    if (code === null || code === '') {
      return respond(400, { body: 'Sign-in failed' });
    }

    const client = getOauthClient();
    const tokenResponse = await client.getToken({
      code,
      codeVerifier: txToken.verifier,
    });
    const idToken = tokenResponse.tokens.id_token;
    if (!idToken) {
      return respond(400, { body: 'Sign-in failed' });
    }

    const ticket = await client.verifyIdToken({
      idToken,
      audience: googleClient().id,
    });
    const payload = ticket.getPayload();
    if (!payload) {
      return respond(400, { body: 'Sign-in failed' });
    }

    if (payload.nonce !== txToken.nonce) {
      return respond(400, { body: 'Sign-in failed' });
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      return respond(400, { body: 'Sign-in failed' });
    }
    if (payload.email_verified !== true) {
      return respond(400, { body: 'Sign-in failed' });
    }
    const email = payload.email;
    if (typeof email !== 'string' || email === '') {
      return respond(400, { body: 'Sign-in failed' });
    }

    if (!isAllowed(email, payload.email_verified, allowedEmails())) {
      console.log(`sign-in refused: ${email}`);
      const body =
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invitation only</title></head>' +
        '<body><p>This app is invitation-only.</p><p><a href="/privacy">Privacy</a></p></body></html>';
      return respond(403, {
        body,
        contentType: 'text/html; charset=utf-8',
      });
    }

    const name = typeof payload.name === 'string' ? payload.name : undefined;
    await upsertUser(payload.sub, email, name);

    const sessionToken = signSession({ sub: payload.sub, email }, Date.now());
    return respond(302, {
      location: `${publicOrigin()}${txToken.returnTo}`,
      extraCookies: [sessionCookie(sessionToken, { secure })],
    });
  } catch {
    return respond(400, { body: 'Sign-in failed' });
  }
}

export async function authSession(req: Request): Promise<Response> {
  const secure = isSecureOrigin();
  const result = readSession(req);
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  });

  if (result.status === 'absent') {
    return new Response(JSON.stringify({ user: null }), { status: 200, headers });
  }
  if (result.status === 'unusable') {
    headers.append('Set-Cookie', clearedSessionCookie({ secure }));
    return new Response(JSON.stringify({ user: null }), { status: 200, headers });
  }

  const body: { user: { sub: string; email: string } } = {
    user: { sub: result.session.sub, email: result.session.email },
  };
  if (shouldRefresh(result.session, Date.now())) {
    const refreshed = signSession(
      { sub: result.session.sub, email: result.session.email },
      Date.now(),
    );
    headers.append('Set-Cookie', sessionCookie(refreshed, { secure }));
  }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

export async function authSignout(_req: Request): Promise<Response> {
  const headers = new Headers();
  headers.append('Set-Cookie', clearedSessionCookie({ secure: isSecureOrigin() }));
  return new Response(null, { status: 204, headers });
}
