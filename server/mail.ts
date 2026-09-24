import { mailFrom, ownerNotifyEmail, resendApiKey } from './env.ts';

export interface MailMessage {
  subject: string;
  text: string;
}

let loggedResendDisabled = false;

export async function sendMail(msg: MailMessage): Promise<boolean> {
  const key = resendApiKey();
  if (key === null) {
    if (!loggedResendDisabled) {
      loggedResendDisabled = true;
      console.log('RESEND_API_KEY unset — access-request notifications are disabled');
    }
    return false;
  }

  let from: string;
  let to: string;
  try {
    from = mailFrom();
    to = ownerNotifyEmail();
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
