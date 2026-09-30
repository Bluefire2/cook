import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalRecipientProblem, sendMail } from './mail.ts';

describe('approvalRecipientProblem', () => {
  it('accepts a single at-sign with no whitespace or comma', () => {
    expect(approvalRecipientProblem('person@example.com')).toBeNull();
    expect(approvalRecipientProblem('a@b')).toBeNull();
  });

  it('treats blank addresses as missing', () => {
    expect(approvalRecipientProblem('')).toBe('missing');
    expect(approvalRecipientProblem('   ')).toBe('missing');
  });

  it('rejects whitespace, a comma, or an @ count other than one', () => {
    expect(approvalRecipientProblem('person @example.com')).toBe('invalid');
    expect(approvalRecipientProblem('a@b.com\n')).toBe('invalid');
    expect(approvalRecipientProblem('a@b.com,c@d.com')).toBe('invalid');
    expect(approvalRecipientProblem('nodomain')).toBe('invalid');
    expect(approvalRecipientProblem('a@b@c.com')).toBe('invalid');
  });
});

describe('sendMail', () => {
  const prev = {
    key: process.env.RESEND_API_KEY,
    from: process.env.MAIL_FROM,
    owner: process.env.OWNER_NOTIFY_EMAIL,
  };
  const fetchMock = vi.fn();

  function restore(name: 'RESEND_API_KEY' | 'MAIL_FROM' | 'OWNER_NOTIFY_EMAIL', value: string | undefined) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  beforeEach(() => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.MAIL_FROM = 'Sous <sous@example.com>';
    process.env.OWNER_NOTIFY_EMAIL = 'owner@example.com';
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restore('RESEND_API_KEY', prev.key);
    restore('MAIL_FROM', prev.from);
    restore('OWNER_NOTIFY_EMAIL', prev.owner);
  });

  function postedTo(): string[] {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { to: string[] };
    return body.to;
  }

  it('posts the given recipient and does not use the owner address', async () => {
    const ok = await sendMail({
      subject: 'Approved',
      text: 'You can sign in.',
      to: 'person@example.com',
    });
    expect(ok).toBe(true);
    expect(postedTo()).toEqual(['person@example.com']);
    expect(postedTo()).not.toContain('owner@example.com');
  });

  it('posts the owner address when to is omitted', async () => {
    const ok = await sendMail({ subject: 'Request', text: 'Someone asked.' });
    expect(ok).toBe(true);
    expect(postedTo()).toEqual(['owner@example.com']);
  });

  it('does not fall back to the owner when to is an empty string', async () => {
    const ok = await sendMail({ subject: 'Approved', text: 'You can sign in.', to: '' });
    expect(ok).toBe(true);
    expect(postedTo()).toEqual(['']);
  });

  it('does not call ownerNotifyEmail when to is set, even if OWNER_NOTIFY_EMAIL is unset', async () => {
    delete process.env.OWNER_NOTIFY_EMAIL;
    const ok = await sendMail({
      subject: 'Approved',
      text: 'You can sign in.',
      to: 'person@example.com',
    });
    expect(ok).toBe(true);
    expect(postedTo()).toEqual(['person@example.com']);
  });

  it('returns false and does not throw when to is omitted and OWNER_NOTIFY_EMAIL is unset', async () => {
    delete process.env.OWNER_NOTIFY_EMAIL;
    await expect(sendMail({ subject: 'Request', text: 'Someone asked.' })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
