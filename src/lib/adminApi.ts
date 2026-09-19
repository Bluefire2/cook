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

export interface InviteEntry {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export interface InviteList {
  invites: InviteEntry[];
}

export interface CreatedInvite extends InviteList {
  url: string;
}

async function throwAdminError(response: Response): Promise<never> {
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
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (response.status === 409 && data !== null && data.error === 'invite-cap') {
    throw new Error(
      'You already have 20 unused invite links. Revoke one to mint another.',
    );
  }
  const err =
    data !== null && typeof data === 'object' && 'error' in data
      ? String(data.error)
      : null;
  throw new Error(err ?? `Request failed (${response.status}).`);
}

async function parseAdminResponse(response: Response): Promise<AccessRequestLists> {
  if (!response.ok) {
    await throwAdminError(response);
  }
  const data = (await response.json().catch(() => null)) as AccessRequestLists | null;
  if (data === null) {
    throw new Error(`Request failed (${response.status}).`);
  }
  return data;
}

async function parseInviteListResponse(response: Response): Promise<InviteList> {
  if (!response.ok) {
    await throwAdminError(response);
  }
  const data = (await response.json().catch(() => null)) as InviteList | null;
  if (data === null || !Array.isArray(data.invites)) {
    throw new Error(`Request failed (${response.status}).`);
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

export async function fetchInvites(): Promise<InviteList> {
  const response = await fetch('/api/admin/invites', {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  return parseInviteListResponse(response);
}

export async function createInvite(): Promise<CreatedInvite> {
  const response = await fetch('/api/admin/invites', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    await throwAdminError(response);
  }
  const data = (await response.json().catch(() => null)) as CreatedInvite | null;
  if (data === null || typeof data.url !== 'string' || !Array.isArray(data.invites)) {
    throw new Error(`Request failed (${response.status}).`);
  }
  return data;
}

export async function revokeInvite(id: string): Promise<InviteList> {
  const response = await fetch('/api/admin/invites/revoke', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id }),
  });
  return parseInviteListResponse(response);
}
