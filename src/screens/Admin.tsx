import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createInvite,
  decideAccessRequest,
  fetchAccessRequests,
  fetchInvites,
  revokeInvite,
  type AccessRequestEntry,
  type AccessRequestLists,
  type InviteEntry,
} from '../lib/adminApi';
import {
  mergeSectionPage,
  sortAccessRequestLists,
  type AdminSection,
} from '../lib/adminLists';
import { relativeExpiryLabel, relativeMinutesLabel } from '../lib/relativeTime';
import { backLink, dangerBtn, inputClass, primaryBtn, secondaryBtn } from '../lib/uiClasses';

const SECTION_META: { key: AdminSection; title: string; empty: string }[] = [
  { key: 'pending', title: 'Pending', empty: 'No pending requests.' },
  { key: 'approved', title: 'Approved', empty: 'No approved members.' },
  { key: 'denied', title: 'Declined', empty: 'No declined requests.' },
];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

export default function Admin() {
  // `lists` stays null until a response succeeds, so no request data can
  // render before one — a 403 or a network failure is just the error line.
  const [lists, setLists] = useState<AccessRequestLists | null>(null);
  const [invites, setInvites] = useState<InviteEntry[] | null>(null);
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [decidingSub, setDecidingSub] = useState<string | null>(null);
  const [pagingSection, setPagingSection] = useState<AdminSection | null>(null);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // One thing at a time: a decision response replaces all three sections and
  // a Load more merges one, so letting them overlap could resurrect a row.
  const busy =
    refreshing ||
    decidingSub !== null ||
    pagingSection !== null ||
    creatingInvite ||
    revokingId !== null;

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAccessRequests(), fetchInvites()])
      .then(([requestData, inviteData]) => {
        if (!cancelled) {
          setLists(sortAccessRequestLists(requestData));
          setInvites(inviteData.invites);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(errorMessage(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setInitialLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const [requestData, inviteData] = await Promise.all([
        fetchAccessRequests(),
        fetchInvites(),
      ]);
      setLists(sortAccessRequestLists(requestData));
      setInvites(inviteData.invites);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };

  const decide = async (sub: string, action: 'approve' | 'deny' | 'revoke') => {
    setDecidingSub(sub);
    setError(null);
    try {
      // The POST returns all three sections re-listed from the first page.
      setLists(sortAccessRequestLists(await decideAccessRequest({ sub, action })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDecidingSub(null);
    }
  };

  const loadMore = async (section: AdminSection) => {
    const cursor = lists?.[section].nextCursor;
    if (cursor === null || cursor === undefined) {
      return;
    }
    setPagingSection(section);
    setError(null);
    try {
      const cursors: { pending?: string; approved?: string; denied?: string } = {};
      cursors[section] = cursor;
      const response = await fetchAccessRequests(cursors);
      setLists((current) =>
        current === null
          ? sortAccessRequestLists(response)
          : mergeSectionPage(current, section, response),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPagingSection(null);
    }
  };

  const mint = async () => {
    setCreatingInvite(true);
    setError(null);
    setCopied(false);
    try {
      const created = await createInvite();
      setInvites(created.invites);
      setMintedUrl(created.url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCreatingInvite(false);
    }
  };

  const copyMintedUrl = async () => {
    if (mintedUrl === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(mintedUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const revoke = async (id: string) => {
    setRevokingId(id);
    setError(null);
    try {
      const next = await revokeInvite(id);
      setInvites(next.invites);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRevokingId(null);
    }
  };

  const renderActions = (entry: AccessRequestEntry, section: AdminSection) => {
    if (section === 'approved') {
      return (
        <button
          type="button"
          aria-label={`Remove access for ${entry.email}`}
          disabled={busy}
          onClick={() => void decide(entry.sub, 'revoke')}
          className={`${dangerBtn} px-3 py-1.5 text-sm`}
        >
          Remove access
        </button>
      );
    }
    return (
      <>
        <button
          type="button"
          aria-label={`Approve ${entry.email}`}
          disabled={busy}
          onClick={() => void decide(entry.sub, 'approve')}
          className={`${primaryBtn} px-3 py-1.5 text-sm`}
        >
          Approve
        </button>
        {section === 'pending' && (
          <button
            type="button"
            aria-label={`Decline ${entry.email}`}
            disabled={busy}
            onClick={() => void decide(entry.sub, 'deny')}
            className={`${secondaryBtn} px-3 py-1.5 text-sm disabled:opacity-40`}
          >
            Decline
          </button>
        )}
      </>
    );
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to="/" className={backLink}>
          &larr; Library
        </Link>
        <h1 className="mt-2 text-2xl font-bold">Invitations</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Approving gives the person their own empty library. Remove access
          takes effect within a minute.
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy || initialLoading}
          className={`${secondaryBtn} mt-3 px-4 py-2.5 disabled:opacity-40`}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {initialLoading && <p className="mt-2 text-sm text-ink-muted">Loading…</p>}
      {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}

      {invites !== null && (
        <section>
          <h2 className="mt-8 text-lg font-semibold">Invite links</h2>
          <p className="mt-1 text-sm text-ink-muted">
            A link admits the first Google account that signs in with it. It
            works once and expires after 7 days. The URL is shown only when
            you create it — copy it now.
          </p>
          <button
            type="button"
            onClick={() => void mint()}
            disabled={busy}
            className={`${primaryBtn} mt-3 px-4 py-2.5 disabled:opacity-40`}
          >
            {creatingInvite ? 'Creating…' : 'Create link'}
          </button>
          {mintedUrl !== null && (
            <div className="mt-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
              <label className="text-xs text-ink-muted" htmlFor="minted-invite-url">
                New invite link
              </label>
              <input
                id="minted-invite-url"
                className={`${inputClass} mt-1 font-mono text-sm`}
                readOnly
                value={mintedUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                type="button"
                onClick={() => void copyMintedUrl()}
                className={`${secondaryBtn} mt-2 px-3 py-1.5 text-sm`}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
          {invites.length === 0 ? (
            <p className="mt-3 text-sm text-ink-muted">No unused invite links.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {invites.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">Unused link</p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      Created {relativeMinutesLabel(entry.createdAt)} ·{' '}
                      {relativeExpiryLabel(entry.expiresAt)}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Revoke this invite link"
                    disabled={busy}
                    onClick={() => void revoke(entry.id)}
                    className={`${dangerBtn} px-3 py-1.5 text-sm`}
                  >
                    {revokingId === entry.id ? 'Revoking…' : 'Revoke'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {lists !== null &&
        SECTION_META.map(({ key, title, empty }) => {
          const sectionPage = lists[key];
          return (
            <section key={key}>
              <h2 className="mt-8 text-lg font-semibold">{title}</h2>
              {sectionPage.rows.length === 0 ? (
                <p className="mt-1 text-sm text-ink-muted">{empty}</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-3">
                  {sectionPage.rows.map((entry) => {
                    const hasName = entry.name !== undefined && entry.name !== '';
                    return (
                      <li
                        key={entry.sub}
                        className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm"
                      >
                        <div className="min-w-0 flex-1">
                          {hasName && (
                            <p className="truncate text-sm font-medium">{entry.name}</p>
                          )}
                          <p
                            className={`truncate text-sm ${hasName ? 'text-ink-muted' : ''}`}
                          >
                            {entry.email}
                          </p>
                          <p className="mt-0.5 text-xs text-ink-muted">
                            Requested {relativeMinutesLabel(entry.requestedAt)}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          {renderActions(entry, key)}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {sectionPage.nextCursor !== null && (
                <>
                  <p className="mt-2 text-sm text-ink-muted">
                    This section has more entries — they load 200 at a time.
                  </p>
                  <button
                    type="button"
                    onClick={() => void loadMore(key)}
                    disabled={busy}
                    className={`${secondaryBtn} mt-2 px-4 py-2.5 disabled:opacity-40`}
                  >
                    {pagingSection === key ? 'Loading…' : 'Load more'}
                  </button>
                </>
              )}
            </section>
          );
        })}
    </div>
  );
}
