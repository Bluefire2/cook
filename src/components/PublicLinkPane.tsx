import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { collectionStore } from '../lib/collectionStore';
import { dangerBtn, inputClass, primaryBtn, secondaryBtn } from '../lib/uiClasses';

/**
 * The share sheet's Public pane: turn the collection's public link on, copy
 * it, or turn it off (`docs/plans/public-collections.md`). Unlike a join
 * link, the server keeps the URL, so it can be shown again.
 */
export default function PublicLinkPane({
  collectionId,
  onBusyChange,
}: {
  collectionId: string;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useT();
  // `undefined` until a load succeeds; null means the collection is not public.
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const inFlight = useRef(false);
  // Only the newest read or write may set the URL.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoadError(null);
    try {
      const next = await collectionStore.publicLink(collectionId);
      if (mine === seq.current) setUrl(next);
    } catch (err) {
      if (mine === seq.current) {
        setLoadError(err instanceof Error ? err.message : t('error.sharingLoad'));
      }
    }
  }, [collectionId]);

  useEffect(() => {
    void load();
    return () => {
      // A result that lands after the pane closed is stale.
      seq.current += 1;
    };
  }, [load]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard can be refused; the URL stays selectable.
      setCopied(false);
    }
  };

  const run = async (write: () => Promise<string | null>, copyAfter: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const mine = ++seq.current;
    setError(null);
    setBusy(true);
    onBusyChange(true);
    setCopied(false);
    try {
      const next = await write();
      if (mine !== seq.current) return;
      setUrl(next);
      if (copyAfter && next !== null) await copy(next);
    } catch (err) {
      if (mine === seq.current) {
        setError(err instanceof Error ? err.message : t('error.sharingUpdate'));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };

  const turnOn = () => run(() => collectionStore.enablePublicLink(collectionId), true);
  const turnOff = () =>
    run(async () => {
      await collectionStore.disablePublicLink(collectionId);
      return null;
    }, false);

  return (
    <>
      <p className="mt-3 text-sm text-ink-muted">{t('share.publicIntro')}</p>
      {url === undefined && loadError === null && (
        <p className="mt-3 text-sm text-ink-muted">{t('common.loading')}</p>
      )}
      {url === undefined && loadError !== null && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span role="alert" className="min-w-0 flex-1 text-danger">
            {loadError}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className={`${secondaryBtn} shrink-0 px-3 py-1.5 text-xs`}
          >
            {t('common.tryAgain')}
          </button>
        </div>
      )}
      {url === null && (
        <>
          <p className="mt-3 text-sm text-ink-muted">{t('share.publicOff')}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void turnOn()}
            className={`${primaryBtn} mt-3 w-full py-3`}
          >
            {busy ? t('common.saving') : t('share.publicTurnOn')}
          </button>
        </>
      )}
      {typeof url === 'string' && (
        <div className="mt-3">
          <label className="text-xs text-ink-muted" htmlFor="public-collection-link">
            {t('share.publicLinkLabel')}
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="public-collection-link"
              readOnly
              value={url}
              onFocus={(event) => event.currentTarget.select()}
              className={`${inputClass} min-w-0 flex-1 font-mono text-xs`}
            />
            <button
              type="button"
              onClick={() => void copy(url)}
              className={`${secondaryBtn} shrink-0 px-3 py-1.5 text-xs`}
            >
              {copied ? t('share.copied') : t('share.copy')}
            </button>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void turnOff()}
            aria-label={t('share.publicTurnOffLabel')}
            className={`${dangerBtn} mt-3 px-4 py-2 text-sm disabled:opacity-40`}
          >
            {busy ? t('common.saving') : t('share.publicTurnOff')}
          </button>
          <p className="mt-2 text-xs text-ink-muted">{t('share.publicOffHint')}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}
