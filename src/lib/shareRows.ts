import type { CollectionGrant, GrantRole } from './remote';

/**
 * The one grant request the share sheet has in flight. Requests are
 * serialised, so there is at most one, and a row only claims what the server
 * has confirmed: the requested value is shown as pending until it lands.
 */
export type GrantPending =
  | { kind: 'add'; email: string; role: GrantRole }
  | { kind: 'role'; sub: string; role: GrantRole }
  | { kind: 'remove'; sub: string };

/** `saved` is what the server holds; every other state is a request in flight. */
export type GrantRowState = 'saved' | 'adding' | 'saving' | 'removing';

export type GrantRow = {
  key: string;
  email: string;
  role: GrantRole;
  state: GrantRowState;
  /** Absent on the placeholder for a person being added. */
  sub?: string;
};

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Older servers omit the role; that means viewer. */
export function grantRole(grant: CollectionGrant): GrantRole {
  return grant.role === 'editor' ? 'editor' : 'viewer';
}

/**
 * Rows for the people list. Saved grants come straight from the server list.
 * The row a request is about carries its requested role and a pending state
 * until the request settles. An add for someone who already has a grant
 * changes that row's role (the server applies the chosen role) rather than
 * adding a second row; an add for a new person is a placeholder at the end.
 */
export function deriveGrantRows(
  grants: readonly CollectionGrant[],
  pending: GrantPending | null,
): GrantRow[] {
  let matchedAdd = false;
  const rows = grants.map((grant): GrantRow => {
    const row: GrantRow = {
      key: grant.sub,
      sub: grant.sub,
      email: grant.email,
      role: grantRole(grant),
      state: 'saved',
    };
    if (pending?.kind === 'role' && pending.sub === grant.sub) {
      return { ...row, role: pending.role, state: 'saving' };
    }
    if (pending?.kind === 'remove' && pending.sub === grant.sub) {
      return { ...row, state: 'removing' };
    }
    if (pending?.kind === 'add' && sameEmail(pending.email, grant.email)) {
      matchedAdd = true;
      return { ...row, role: pending.role, state: 'saving' };
    }
    return row;
  });
  if (pending?.kind === 'add' && !matchedAdd) {
    rows.push({
      key: 'adding',
      email: pending.email.trim(),
      role: pending.role,
      state: 'adding',
    });
  }
  return rows;
}

/** The list after the server accepted a grant: replace that person's row, or append. */
export function withGrant(
  grants: readonly CollectionGrant[],
  grant: CollectionGrant,
): CollectionGrant[] {
  return grants.some((g) => g.sub === grant.sub)
    ? grants.map((g) => (g.sub === grant.sub ? grant : g))
    : [...grants, grant];
}

export function withGrantRole(
  grants: readonly CollectionGrant[],
  sub: string,
  role: GrantRole,
): CollectionGrant[] {
  return grants.map((g) => (g.sub === sub ? { ...g, role } : g));
}

export function withoutGrant(
  grants: readonly CollectionGrant[],
  sub: string,
): CollectionGrant[] {
  return grants.filter((g) => g.sub !== sub);
}
