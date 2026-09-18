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

function htmlPage(title: string, body: string, status: number): Response {
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>` +
    `<body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function expiredPage(): Response {
  return htmlPage(
    'Link expired',
    '<p>That link has expired. Sign in again to request access.</p><p><a href="/">Home</a></p>',
    400,
  );
}

function recordedPage(): Response {
  return htmlPage(
    'Request sent',
    '<p>Your request was recorded.</p>',
    200,
  );
}

function alreadyApprovedPage(): Response {
  return htmlPage(
    'Already approved',
    '<p>You already have access — try signing in again.</p>',
    200,
  );
}

function unavailablePage(): Response {
  return htmlPage(
    'Unavailable',
    '<p>Sign-in is temporarily unavailable. Try again in a few minutes.</p>',
    503,
  );
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
