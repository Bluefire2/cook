import { mailFrom, ownerNotifyEmail, resendApiKey } from './env.ts';

export interface MailMessage {
  subject: string;
  text: string;
  to?: string;
}

let loggedResendDisabled = false;

export async function sendMail(msg: MailMessage): Promise<boolean> {
  const key = resendApiKey();
  if (key === null) {
    if (!loggedResendDisabled) {
      loggedResendDisabled = true;
      console.log('RESEND_API_KEY unset — access-request and approval emails are disabled');
    }
    return false;
  }

  if (msg.to !== undefined && approvalRecipientProblem(msg.to) !== null) {
    console.log('resend send skipped: invalid recipient');
    return false;
  }

  let from: string;
  let to: string;
  try {
    from = mailFrom();
    to = msg.to === undefined ? ownerNotifyEmail() : msg.to;
  } catch {
    return false;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: msg.subject,
        text: msg.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.log(`resend send failed: ${response.status}`);
      return false;
    }
    return true;
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : 'Error';
    console.log(`resend send failed: ${name}`);
    return false;
  }
}

export function approvalRecipientProblem(
  email: string,
): 'missing' | 'invalid' | null {
  if (email.trim() === '') {
    return 'missing';
  }
  const atCount = email.split('@').length - 1;
  if (/[\s,]/.test(email) || atCount !== 1) {
    return 'invalid';
  }
  return null;
}

// The Resend sandbox sender (onboarding@resend.dev) only delivers to the
// Resend account's own address. Mail to anyone else is refused with a 403.
export function isResendSandboxSender(from: string): boolean {
  const bracketed = /<([^>]*)>\s*$/.exec(from);
  const address = (bracketed === null ? from : bracketed[1]).trim().toLowerCase();
  return address.endsWith('@resend.dev');
}
