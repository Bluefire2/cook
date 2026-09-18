import { recordAccessRequest } from './members.ts';
import { readBoundedText } from './membership.ts';
import { sendMail } from './mail.ts';
import { verifyAccessRequestTx } from './session.ts';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Visual language follows public/privacy.html: one inline <style> block,
// system font stack, the same light/dark colour pairs, no external requests
// and no <script>. These pages are served to people who are not signed in,
// so they must be fully self-contained.
const PAGE_STYLES = `
:root {
  color-scheme: light dark;
}
body {
  max-width: 42rem;
  margin: 0 auto;
  padding: 2.5rem 1.25rem 4rem;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica,
    Arial, sans-serif;
  line-height: 1.65;
  overflow-wrap: break-word;
  background: #fafaf9;
  color: #1c1917;
}
h1 {
  margin: 0 0 0.25rem;
  font-size: 1.625rem;
  line-height: 1.3;
}
p {
  margin: 0.5rem 0;
}
a {
  color: inherit;
}
.muted {
  opacity: 0.7;
}
form {
  margin: 1.25rem 0;
}
button {
  font: inherit;
  padding: 0.5rem 1.25rem;
  border: none;
  border-radius: 0.375rem;
  background: #1c1917;
  color: #fafaf9;
  cursor: pointer;
}
button:hover {
  opacity: 0.85;
}
button:focus-visible {
  outline: 2px solid #1c1917;
  outline-offset: 2px;
}
footer {
  margin-top: 3rem;
  font-size: 0.875rem;
  opacity: 0.7;
}
@media (prefers-color-scheme: dark) {
  body {
    background: #1c1917;
    color: #e7e5e4;
  }
  button {
    background: #e7e5e4;
    color: #1c1917;
  }
  button:focus-visible {
    outline-color: #e7e5e4;
  }
}
`;

function pageHtml(title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(title)}</title>` +
    `<style>${PAGE_STYLES}</style></head>` +
    `<body>${body}</body></html>`
  );
}

function htmlPage(title: string, body: string, status: number): Response {
  return new Response(pageHtml(title, body), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// The 403 shown by the OAuth callback when the signed-in identity is not a
// member. `requestToken` is null when the token could not be minted — the
// page then renders without the form rather than with a broken button.
export function invitationOnlyPage(
  identity: { email: string; name?: string },
  requestToken: string | null,
): string {
  const signedInAs =
    identity.name !== undefined && identity.name !== ''
      ? `You signed in as ${escapeHtml(identity.name)} (${escapeHtml(identity.email)}).`
      : `You signed in as ${escapeHtml(identity.email)}.`;
  // With or without the form, the page keeps D14's substance: nobody is
  // emailed back, and signing in again works once they are approved. The
  // no-form copy says the request could not be started and that retrying
  // sign-in will offer it again — a mint failure is transient.
  const requestBlock =
    requestToken === null
      ? '<p class="muted">Your request could not be started right now — ' +
        'signing in again will offer it once more. Nobody will email you ' +
        'back; once you have been approved, you can try signing in again.</p>'
      : '<form method="POST" action="/api/access-request">' +
        `<input type="hidden" name="t" value="${escapeHtml(requestToken)}">` +
        '<button type="submit">Request access</button>' +
        '</form>' +
        '<p class="muted">Your request goes to the owner of this app. ' +
        'Nobody will email you back — once it is approved, you can try ' +
        'signing in again.</p>';
  return pageHtml(
    'Invitation only',
    '<h1>Sous is invitation-only</h1>' +
      `<p>${signedInAs}</p>` +
      requestBlock +
      '<footer><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>',
  );
}

function expiredPage(): Response {
  return htmlPage(
    'Link expired',
    '<h1>Link expired</h1>' +
      '<p>That link has expired. Sign in again to request access.</p>' +
      '<p><a href="/">Home</a></p>',
    400,
  );
}

function recordedPage(): Response {
  return htmlPage(
    'Request sent',
    '<h1>Request sent</h1><p>Your request was recorded.</p>',
    200,
  );
}

function alreadyApprovedPage(): Response {
  return htmlPage(
    'Already approved',
    '<h1>Already approved</h1><p>You already have access — try signing in again.</p>',
    200,
  );
}

// Shared with the OAuth callback's Firestore-error branch in server/auth.ts,
// which wraps this HTML in its own response (it must also clear the oauth
// cookie, so it cannot reuse htmlPage's Response).
export function unavailablePageHtml(): string {
  return pageHtml(
    'Unavailable',
    '<h1>Unavailable</h1>' +
      '<p>Sign-in is temporarily unavailable. Try again in a few minutes.</p>',
  );
}

function unavailablePage(): Response {
  return new Response(unavailablePageHtml(), {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function accessRequestPost(req: Request): Promise<Response> {
  const contentType = req.headers.get('content-type');
  if (contentType === null || !contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return new Response('Unsupported Media Type', { status: 415 });
  }

  const text = await readBoundedText(req, 4096);
  if (text === null) {
    return new Response('Payload too large', { status: 413 });
  }

  const params = new URLSearchParams(text);
  const tokenPayload = verifyAccessRequestTx(params.get('t') ?? '', Date.now());
  if (tokenPayload === null) {
    return expiredPage();
  }

  try {
    const result = await recordAccessRequest(
      {
        sub: tokenPayload.sub,
        email: tokenPayload.email,
        name: tokenPayload.name,
      },
      Date.now(),
    );

    if (result.notify) {
      const stamp = new Date().toISOString();
      const nameLine = tokenPayload.name ? `Name: ${tokenPayload.name}\n` : '';
      await sendMail({
        subject: 'Sous access request',
        text:
          `Email: ${tokenPayload.email}\n` +
          nameLine +
          `Requested at (UTC): ${stamp}\n` +
          'Approve or decline at https://sous.kyrylo.lol/admin',
      });
    }

    if (result.outcome === 'already-approved') {
      return alreadyApprovedPage();
    }
    return recordedPage();
  } catch (err) {
    console.error('accessRequestPost failed:', err);
    return unavailablePage();
  }
}
