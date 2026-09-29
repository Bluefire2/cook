/** Which mint helper to call. Does not fetch. */
export function inviteMintClient(user: { isOwner?: boolean }): 'admin' | 'member' {
  return user.isOwner === true ? 'admin' : 'member';
}

/** Clipboard write path. Does not read navigator and does not fetch. */
export function copyStrategy(input: { hasClipboardItem: boolean }): 'clipboard-item' | 'write-text' {
  return input.hasClipboardItem ? 'clipboard-item' : 'write-text';
}

const INVITE_QUOTA_CODES = new Set(['member-invite-limit', 'member-invite-cap', 'invite-cap']);

/** True when minting was refused because this person, or the shared pool, has no invite left. */
export function isInviteQuotaError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  const code = (err as { code: unknown }).code;
  return typeof code === 'string' && INVITE_QUOTA_CODES.has(code);
}
