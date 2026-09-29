import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { t, useT, type MessageKey } from '../i18n';
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
import { relativeAgoLabel, relativeExpiryLabel } from '../lib/relativeTime';
import { backLink, dangerBtn, inputClass, primaryBtn, secondaryBtn } from '../lib/uiClasses';

const SECTION_META: { key: AdminSection; title: MessageKey; empty: MessageKey }[] = [
  { key: 'pending', title: 'admin.pending', empty: 'admin.noPending' },
  { key: 'approved', title: 'admin.approved', empty: 'admin.noApproved' },
  { key: 'denied', title: 'admin.declined', empty: 'admin.noDeclined' },
];

const ADMIN_PAGE_SIZE = 200;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : t('common.somethingWentWrong');
}

export default function Admin() {
  const tr = useT();
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
          aria-label={tr('admin.removeAccessFor', { email: entry.email })}
          disabled={busy}
          onClick={() => void decide(entry.sub, 'revoke')}
          className={`${dangerBtn} px-3 py-1.5 text-sm`}
        >
          {tr('admin.removeAccess')}
        </button>
      );
    }
    return (
      <>
        <button
          type="button"
          aria-label={tr('admin.approveEmail', { email: entry.email })}
          disabled={busy}
          onClick={() => void decide(entry.sub, 'approve')}
          className={`${primaryBtn} px-3 py-1.5 text-sm`}
        >
          {tr('admin.approve')}
        </button>
        {section === 'pending' && (
          <button
            type="button"
            aria-label={tr('admin.declineEmail', { email: entry.email })}
            disabled={busy}
            onClick={() => void decide(entry.sub, 'deny')}
            className={`${secondaryBtn} px-3 py-1.5 text-sm disabled:opacity-40`}
          >
            {tr('admin.decline')}
          </button>
        )}
      </>
    );
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to="/" className={backLink}>
          &larr; {tr('common.library')}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{tr('admin.title')}</h1>
        <p className="mt-1 text-sm text-ink-muted">{tr('admin.intro')}</p>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy || initialLoading}
          className={`${secondaryBtn} mt-3 px-4 py-2.5 disabled:opacity-40`}
        >
          {refreshing ? tr('admin.refreshing') : tr('common.refresh')}
        </button>
      </header>

      {initialLoading && <p className="mt-2 text-sm text-ink-muted">{tr('common.loading')}</p>}
      {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}

      {invites !== null && (
        <section>
          <h2 className="mt-8 text-lg font-semibold">{tr('admin.inviteLinks')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{tr('admin.inviteIntro')}</p>
          <button
            type="button"
            onClick={() => void mint()}
            disabled={busy}
            className={`${primaryBtn} mt-3 px-4 py-2.5 disabled:opacity-40`}
          >
            {creatingInvite ? tr('admin.creating') : tr('admin.createLink')}
          </button>
          {mintedUrl !== null && (
            <div className="mt-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
              <label className="text-xs text-ink-muted" htmlFor="minted-invite-url">
                {tr('admin.newInviteLink')}
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
                {copied ? tr('admin.copied') : tr('admin.copy')}
              </button>
            </div>
          )}
          {invites.length === 0 ? (
            <p className="mt-3 text-sm text-ink-muted">{tr('admin.noInvites')}</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {invites.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{tr('admin.unusedLink')}</p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {tr('admin.createdAgo', { time: relativeAgoLabel(entry.createdAt) })}
                      {' · '}
                      {relativeExpiryLabel(entry.expiresAt)}
                    </p>
                    {entry.creatorEmail !== undefined && entry.creatorEmail !== '' && (
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {tr('admin.createdBy', { email: entry.creatorEmail })}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label={tr('admin.revokeInvite')}
                    disabled={busy}
                    onClick={() => void revoke(entry.id)}
                    className={`${dangerBtn} px-3 py-1.5 text-sm`}
                  >
                    {revokingId === entry.id ? tr('admin.revoking') : tr('admin.revoke')}
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
              <h2 className="mt-8 text-lg font-semibold">{tr(title)}</h2>
              {sectionPage.rows.length === 0 ? (
                <p className="mt-1 text-sm text-ink-muted">{tr(empty)}</p>
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
                            {tr('admin.requestedAgo', { time: relativeAgoLabel(entry.requestedAt) })}
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
                    {tr('admin.moreEntries', { pageSize: ADMIN_PAGE_SIZE })}
                  </p>
                  <button
                    type="button"
                    onClick={() => void loadMore(key)}
                    disabled={busy}
                    className={`${secondaryBtn} mt-2 px-4 py-2.5 disabled:opacity-40`}
                  >
                    {pagingSection === key ? tr('common.loading') : tr('admin.loadMore')}
                  </button>
                </>
              )}
            </section>
          );
        })}
    </div>
  );
}
