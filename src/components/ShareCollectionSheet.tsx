import { useEffect, useState } from 'react';
import { useLocale, useT } from '../i18n';
import Sheet from './Sheet';
import {
  collectionStore,
  visibleMintedUrl,
  type MintedLink,
} from '../lib/collectionStore';
import { relativeExpiryLabel } from '../lib/relativeTime';
import type { CollectionGrant, CollectionLink, GrantRole } from '../lib/remote';
import {
  cellClass,
  dangerBtn,
  inputClass,
  primaryBtn,
  secondaryBtn,
} from '../lib/uiClasses';
import type { Collection } from '../lib/types';

export default function ShareCollectionSheet({
  collection,
  onClose,
}: {
  collection: Collection;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<GrantRole>('viewer');
  const [grants, setGrants] = useState<CollectionGrant[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<CollectionLink[] | undefined>(undefined);
  const [linkRole, setLinkRole] = useState<GrantRole>('viewer');
  // The raw link is only in this state: the server never returns it again.
  const [minted, setMinted] = useState<MintedLink | null>(null);
  const [copied, setCopied] = useState(false);
  // Hidden as soon as its link is revoked or drops out of a refreshed list.
  const mintedUrl = visibleMintedUrl(minted, links);

  useEffect(() => {
    let cancelled = false;
    void collectionStore
      .listGrants(collection.id)
      .then((rows) => {
        if (!cancelled) {
          setGrants(rows);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('error.sharingLoad'));
          setGrants([]);
        }
      });
    void collectionStore
      .listLinks(collection.id)
      .then((rows) => {
        if (!cancelled) {
          setLinks(rows);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('error.sharingLoad'));
          setLinks([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [collection.id]);

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard can be refused; the URL stays selectable below.
      setCopied(false);
    }
  };

  const createLink = async () => {
    setError(null);
    setBusy(true);
    setCopied(false);
    try {
      const created = await collectionStore.createLink(collection.id, linkRole);
      setLinks(created.links);
      setMinted({ url: created.url, id: created.linkId });
      await copyUrl(created.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.sharingUpdate'));
    } finally {
      setBusy(false);
    }
  };

  const revokeLink = async (linkId: string) => {
    setError(null);
    setBusy(true);
    try {
      setLinks(await collectionStore.revokeLink(collection.id, linkId));
      if (minted?.id === linkId) {
        setMinted(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.sharingUpdate'));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setError(null);
    setBusy(true);
    try {
      await collectionStore.addGrant(collection.id, email, role);
      setEmail('');
      setRole('viewer');
      setGrants(await collectionStore.listGrants(collection.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.sharingUpdate'));
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (sub: string, next: GrantRole) => {
    setError(null);
    setBusy(true);
    try {
      await collectionStore.setGrantRole(collection.id, sub, next);
      setGrants(await collectionStore.listGrants(collection.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.sharingUpdate'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (sub: string) => {
    setError(null);
    setBusy(true);
    try {
      await collectionStore.revokeGrant(collection.id, sub);
      setGrants(await collectionStore.listGrants(collection.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.sharingUpdate'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={onClose} dismissible={!busy}>
      <h2 className="text-lg font-semibold">{t('share.title', { name: collection.name })}</h2>
      <p className="mt-1 text-sm text-ink-muted">{t('share.intro')}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <div className="mt-3 flex gap-2">
          <input
            autoFocus
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('share.emailPlaceholder')}
            disabled={busy}
            className={`${inputClass} min-w-0 flex-1`}
          />
          <RoleSelect value={role} onChange={setRole} disabled={busy} />
        </div>
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        <button
          type="submit"
          disabled={busy || email.trim() === ''}
          className={`${primaryBtn} mt-3 w-full py-3`}
        >
          {t('common.share')}
        </button>
      </form>
      <ul className="mt-4 flex flex-col gap-2">
        {grants === undefined && (
          <li className="text-sm text-ink-muted">{t('common.loading')}</li>
        )}
        {grants?.length === 0 && (
          <li className="text-sm text-ink-muted">{t('share.nobodyYet')}</li>
        )}
        {grants?.map((grant) => (
          <li
            key={grant.sub}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span className="min-w-0 flex-1 truncate">{grant.email}</span>
            <RoleSelect
              value={grant.role ?? 'viewer'}
              onChange={(next) => void changeRole(grant.sub, next)}
              disabled={busy}
              label={t('share.roleFor', { email: grant.email })}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void revoke(grant.sub)}
              className={`${dangerBtn} px-3 py-1.5 text-xs`}
            >
              {t('common.remove')}
            </button>
          </li>
        ))}
      </ul>
      <h3 className="mt-6 text-sm font-semibold">{t('share.linkTitle')}</h3>
      <p className="mt-1 text-sm text-ink-muted">{t('share.linkIntro')}</p>
      <div className="mt-3 flex gap-2">
        <RoleSelect
          value={linkRole}
          onChange={setLinkRole}
          disabled={busy}
          label={t('share.linkRoleLabel')}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void createLink()}
          className={`${secondaryBtn} min-w-0 flex-1 py-2`}
        >
          {t('share.copyLink')}
        </button>
      </div>
      {mintedUrl !== null && (
        <div className="mt-3">
          <label className="text-xs text-ink-muted" htmlFor="minted-collection-link">
            {copied ? t('share.linkCopiedHint') : t('share.linkCopyNowHint')}
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="minted-collection-link"
              readOnly
              value={mintedUrl}
              onFocus={(event) => event.currentTarget.select()}
              className={`${inputClass} min-w-0 flex-1 font-mono text-xs`}
            />
            <button
              type="button"
              onClick={() => void copyUrl(mintedUrl)}
              className={`${secondaryBtn} shrink-0 px-3 py-1.5 text-xs`}
            >
              {copied ? t('share.copied') : t('share.copy')}
            </button>
          </div>
        </div>
      )}
      <ul className="mt-3 flex flex-col gap-2">
        {links === undefined && (
          <li className="text-sm text-ink-muted">{t('common.loading')}</li>
        )}
        {links?.length === 0 && (
          <li className="text-sm text-ink-muted">{t('share.noLinks')}</li>
        )}
        {links?.map((link) => (
          <li key={link.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                {link.role === 'editor' ? t('share.editorLink') : t('share.viewerLink')}
              </span>
              <span className="block truncate text-xs text-ink-muted">
                {relativeExpiryLabel(link.expiresAt, Date.now(), locale)}
              </span>
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void revokeLink(link.id)}
              aria-label={
                link.role === 'editor'
                  ? t('share.revokeEditorLink')
                  : t('share.revokeViewerLink')
              }
              className={`${dangerBtn} shrink-0 px-3 py-1.5 text-xs`}
            >
              {t('share.revoke')}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onClose}
        className={`${secondaryBtn} mt-3 w-full py-3`}
      >
        {t('common.done')}
      </button>
    </Sheet>
  );
}

function RoleSelect({
  value,
  onChange,
  disabled,
  label,
}: {
  value: GrantRole;
  onChange: (role: GrantRole) => void;
  disabled: boolean;
  label?: string;
}) {
  const t = useT();
  return (
    <select
      aria-label={label ?? t('share.role')}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === 'editor' ? 'editor' : 'viewer')}
      className={`${cellClass} shrink-0 bg-surface text-sm`}
    >
      <option value="viewer">{t('share.viewer')}</option>
      <option value="editor">{t('share.editor')}</option>
    </select>
  );
}
