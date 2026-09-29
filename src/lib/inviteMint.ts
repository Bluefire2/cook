/** Which mint helper to call. Does not fetch. */
export function inviteMintClient(user: { isOwner?: boolean }): 'admin' | 'member' {
  return user.isOwner === true ? 'admin' : 'member';
}
