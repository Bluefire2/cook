import type {
  AccessRequestEntry,
  AccessRequestLists,
  AccessRequestPage,
} from './adminApi';

/** The three /admin sections, keyed exactly as `AccessRequestLists` is. */
export type AdminSection = 'pending' | 'approved' | 'denied';

/**
 * Newest-first by request time, with a `sub` tie-break so the order is
 * stable. This is presentation only: the query pages in document-id order,
 * so no recency claim is made about *which* rows are loaded.
 */
export function sortAccessRequestRows(rows: AccessRequestEntry[]): AccessRequestEntry[] {
  return [...rows].sort(
    (a, b) =>
      b.requestedAt - a.requestedAt || (a.sub < b.sub ? -1 : a.sub > b.sub ? 1 : 0),
  );
}

/**
 * Display-sort for responses that replace all three sections: the initial
 * load, Refresh, and a decision response (which re-lists from the first
 * page). Cursors pass through untouched.
 */
export function sortAccessRequestLists(lists: AccessRequestLists): AccessRequestLists {
  return {
    pending: { ...lists.pending, rows: sortAccessRequestRows(lists.pending.rows) },
    approved: { ...lists.approved, rows: sortAccessRequestRows(lists.approved.rows) },
    denied: { ...lists.denied, rows: sortAccessRequestRows(lists.denied.rows) },
  };
}

/**
 * Load-more merge for one section. The response always carries all three
 * sections, but only the requested section's page is new: the other two
 * sections come back as their *first* pages, so both their returned rows and
 * their returned cursors are discarded — keeping state as it is. Overwriting
 * an already-paged section's cursor with its first-page cursor would rewind
 * it and make its next Load more re-fetch rows already on screen.
 *
 * A section's rows and cursor are only ever updated by a fetch that section
 * asked for: the initial load and Refresh ask for all three, a Load more
 * asks for exactly one.
 */
export function mergeSectionPage(
  current: AccessRequestLists,
  section: AdminSection,
  response: AccessRequestLists,
): AccessRequestLists {
  const seen = new Set<string>();
  const merged: AccessRequestEntry[] = [];
  for (const entry of [...current[section].rows, ...response[section].rows]) {
    if (seen.has(entry.sub)) {
      continue;
    }
    seen.add(entry.sub);
    merged.push(entry);
  }
  const nextPage: AccessRequestPage = {
    rows: sortAccessRequestRows(merged),
    nextCursor: response[section].nextCursor,
  };
  return {
    pending: section === 'pending' ? nextPage : current.pending,
    approved: section === 'approved' ? nextPage : current.approved,
    denied: section === 'denied' ? nextPage : current.denied,
  };
}
