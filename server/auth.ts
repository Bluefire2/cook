import { createHash, timingSafeEqual } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { invitationOnlyPage, unavailablePageHtml } from './access.ts';
import { googleClient, isSecureOrigin, publicOrigin, redirectUri } from './env.ts';
import { redeemInvite } from './invites.ts';
import { touchRequestIdentity } from './members.ts';
import { accessAllows, clearMembershipCache, requireMember } from './membership.ts';
import {
  INVITE_COOKIE_NAME,
  clearedInviteCookie,
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
  signAccessRequestTx,
  signOauthTx,
  signSession,
  verifyInviteTx,
  verifyOauthTx,
} from './session.ts';
import { upsertUser as upsertUserDoc } from './store.ts';

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

async function upsertUser(sub: string, email: string, name: string | undefined): Promise<void> {
  try {
    await upsertUserDoc(sub, { email, name });
  } catch (err) {
    console.error('upsertUser failed (sign-in continues):', err);
  }
}

export async function authStart(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const returnTo = safeReturnTo(url.searchParams.get('returnTo'), publicOrigin());
  const state = randomToken(32);
  const nonce = randomToken(32);
  const pkce = pkcePair();
  const now = Date.now();
  const inviteRaw = readCookie(req, INVITE_COOKIE_NAME);
  const inviteTx = inviteRaw === null ? null : verifyInviteTx(inviteRaw, now);
  const txToken = signOauthTx(
    {
      state,
      nonce,
      verifier: pkce.verifier,
      returnTo,
      invite: inviteTx?.id,
    },
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
  headers.append('Set-Cookie', clearedInviteCookie({ secure }));
  return new Response(null, { status: 302, headers });
}

export async function authCallbackGoogle(req: Request): Promise<Response> {
  const secure = isSecureOrigin();
  const clearOauth = clearedOauthCookie({ secure });
  const clearInvite = clearedInviteCookie({ secure });
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
    headers.append('Set-Cookie', clearInvite);
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

    const name = typeof payload.name === 'string' ? payload.name : undefined;
    let access = await accessAllows({
      sub: payload.sub,
      email,
      emailVerified: payload.email_verified,
    });

    if (access === 'unknown') {
      return respond(503, {
        body: unavailablePageHtml(),
        contentType: 'text/html; charset=utf-8',
      });
    }

    if (access === 'denied' && txToken.invite !== undefined) {
      try {
        const redeemed = await redeemInvite(
          txToken.invite,
          { sub: payload.sub, email, name },
          Date.now(),
        );
        if (redeemed.kind === 'ok') {
          clearMembershipCache(payload.sub);
          access = 'member';
        }
      } catch (err) {
        console.error('redeemInvite failed:', err);
        return respond(503, {
          body: unavailablePageHtml(),
          contentType: 'text/html; charset=utf-8',
        });
      }
    }

    if (access === 'denied') {
      console.log(`sign-in refused: ${email}`);
      let requestToken: string | null = null;
      try {
        requestToken = signAccessRequestTx({ sub: payload.sub, email, name }, Date.now());
      } catch (err) {
        // Only possible when SESSION_SECRET is unset — the 403 then renders
        // without the request form rather than with a broken button.
        console.error('signAccessRequestTx failed:', err);
      }
      return respond(403, {
        body: invitationOnlyPage({ email, name }, requestToken),
        contentType: 'text/html; charset=utf-8',
      });
    }

    await upsertUser(payload.sub, email, name);
    if (access === 'member') {
      await touchRequestIdentity(payload.sub, { sub: payload.sub, email, name });
    }

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

  const membership = await requireMember(req);
  if (membership.kind === 'denied') {
    headers.append('Set-Cookie', clearedSessionCookie({ secure }));
    return new Response(JSON.stringify({ user: null }), { status: 200, headers });
  }
  if (membership.kind === 'unknown') {
    return new Response(JSON.stringify({ error: 'Membership unavailable' }), {
      status: 503,
      headers,
    });
  }

  const body: { user: { sub: string; email: string; isOwner: boolean } } = {
    user: {
      sub: membership.sub,
      email: membership.email,
      isOwner: membership.isOwner,
    },
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
