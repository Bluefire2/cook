import { invalidateSession } from './session';

export interface AccessRequestEntry {
  sub: string;
  email: string;
  name?: string;
  requestedAt: number;
  decidedAt?: number;
  requestCount: number;
}

export interface AccessRequestPage {
  rows: AccessRequestEntry[];
  /** `sub` to pass back as this section's cursor; null when fully loaded. */
  nextCursor: string | null;
}

export interface AccessRequestLists {
  pending: AccessRequestPage;
  approved: AccessRequestPage;
  denied: AccessRequestPage;
}

async function parseAdminResponse(response: Response): Promise<AccessRequestLists> {
  if (response.status === 401) {
    invalidateSession();
    throw new Error('Please sign in again — your session expired.');
  }
  if (response.status === 403) {
    throw new Error("This account can't manage invitations.");
  }
  if (response.status === 503) {
    throw new Error('Invitations are temporarily unavailable.');
  }
  const data = (await response.json().catch(() => null)) as AccessRequestLists | null;
  if (!response.ok || data === null) {
    const err =
      data !== null && typeof data === 'object' && 'error' in data
        ? String((data as { error?: unknown }).error)
        : null;
    throw new Error(err ?? `Request failed (${response.status}).`);
  }
  return data;
}

function cursorQuery(cursors?: {
  pending?: string;
  approved?: string;
  denied?: string;
}): string {
  if (cursors === undefined) {
    return '';
  }
  const params = new URLSearchParams();
  if (cursors.pending !== undefined) {
    params.set('afterPending', cursors.pending);
  }
  if (cursors.approved !== undefined) {
    params.set('afterApproved', cursors.approved);
  }
  if (cursors.denied !== undefined) {
    params.set('afterDenied', cursors.denied);
  }
  const q = params.toString();
  return q === '' ? '' : `?${q}`;
}

export async function fetchAccessRequests(cursors?: {
  pending?: string;
  approved?: string;
  denied?: string;
}): Promise<AccessRequestLists> {
  const response = await fetch(`/api/admin/requests${cursorQuery(cursors)}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  return parseAdminResponse(response);
}

export async function decideAccessRequest(params: {
  sub: string;
  action: 'approve' | 'deny' | 'revoke';
}): Promise<AccessRequestLists> {
  const response = await fetch('/api/admin/decision', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  return parseAdminResponse(response);
}
