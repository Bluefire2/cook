import { t } from '../i18n';
import { serverErrorText } from './errorText';
import { invalidateSession } from './session';

export interface MemberInvite {
  url: string;
}

async function throwInviteError(response: Response): Promise<never> {
  if (response.status === 401) {
    invalidateSession();
    throw new Error(t('error.sessionExpired'));
  }
  if (response.status === 503) {
    throw new Error(t('error.adminUnavailable'));
  }
  const data = (await response.json().catch(() => null)) as unknown;
  throw new Error(serverErrorText(data, 'error.requestFailed', { status: response.status }));
}

export async function createMemberInvite(): Promise<MemberInvite> {
  const response = await fetch('/api/invites', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    await throwInviteError(response);
  }
  const data = (await response.json().catch(() => null)) as { url?: unknown } | null;
  if (data === null || typeof data.url !== 'string' || data.url === '') {
    throw new Error(t('error.requestFailed', { status: response.status }));
  }
  return { url: data.url };
}
