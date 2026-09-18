import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { exportLibrary, importLibrary } from '../lib/backup';
import { notifyImportComplete, sync, useSyncStatus } from '../lib/syncEngine';
import { signInHref, signOut, useSession } from '../lib/session';
import { settings, type Theme } from '../lib/settings';
import { applyTheme } from '../lib/theme';
import { backLink, primaryBtn, secondaryBtn } from '../lib/uiClasses';

export default function Settings() {
  const { user, status: sessionStatus } = useSession();
  const syncStatus = useSyncStatus();
  const [theme, setTheme] = useState(settings.getTheme());
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'ok' | 'err' | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const chooseTheme = (next: Theme) => {
    settings.setTheme(next);
    applyTheme(next);
    setTheme(next);
  };

  const doExport = async () => {
    const blob = await exportLibrary();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cook-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = async (file: File) => {
    try {
      const { imported, skipped } = await importLibrary(file);
      setStatus(
        `Imported ${imported} recipe${imported === 1 ? '' : 's'} ✓` +
          (skipped > 0
            ? ` — skipped ${skipped} unreadable entr${skipped === 1 ? 'y' : 'ies'}`
            : ''),
      );
      setStatusKind(skipped > 0 ? 'err' : 'ok');
      notifyImportComplete();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Import failed.');
      setStatusKind('err');
    }
  };

  const doRefresh = async () => {
    setBusy(true);
    try {
      await sync();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const syncedLabel = (() => {
    const at = syncStatus.lastSyncedAt;
    if (at === null) {
      return 'Not loaded yet';
    }
    const minutes = Math.round((Date.now() - at) / 60_000);
    if (minutes < 1) {
      return 'Loaded just now';
    }
    return `Loaded ${minutes} min ago`;
  })();

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to="/" className={backLink}>
          &larr; Library
        </Link>
        <h1 className="mt-2 text-2xl font-bold">Settings</h1>
      </header>

      {sessionStatus !== 'loading' && (
        <>
          <h2 className="mt-2 text-lg font-semibold">Account</h2>
          {sessionStatus === 'signedOut' && (
            <>
              <p className="mt-1 text-sm text-ink-muted">
                Sign in with Google to load your recipes from your account.
              </p>
              <a
                href={signInHref('/settings')}
                className={`${primaryBtn} mt-3 inline-block px-4 py-2.5`}
              >
                Sign in with Google
              </a>
            </>
          )}
          {sessionStatus === 'signedIn' && user && (
            <>
              <div className="mt-3 flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {user.email}
                </span>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className={`${secondaryBtn} shrink-0 px-4 py-2.5`}
                >
                  Sign out
                </button>
              </div>
            </>
          )}
          {sessionStatus === 'offline' && (
            <>
              {user && (
                <span className="mt-3 block truncate text-sm">
                  {user.email}
                </span>
              )}
              <p className="mt-1 text-sm text-ink-muted">
                Offline — sign-in is unavailable until you're back online.
              </p>
            </>
          )}
        </>
      )}

      {sessionStatus === 'signedIn' && (
        <>
          <h2 className="mt-8 text-lg font-semibold">Library</h2>
          <p className="mt-1 text-sm text-ink-muted">{syncedLabel}</p>
          {syncStatus.status === 'error' && (
            <p className="mt-1 text-sm text-danger">
              Couldn't load your recipes. Check your connection and try again.
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void doRefresh()}
              disabled={busy || syncStatus.status === 'loading'}
              className={`${secondaryBtn} flex-1 py-2.5`}
            >
              {busy || syncStatus.status === 'loading' ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </>
      )}

      <h2 className="mt-8 text-lg font-semibold">Appearance</h2>
      <div className="mt-3 flex gap-2">
        {(['dark', 'light'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={theme === option}
            onClick={() => chooseTheme(option)}
            className={`flex-1 rounded-full py-2.5 font-medium ${
              theme === option
                ? 'bg-ink text-page'
                : 'border border-line-strong text-ink-muted hover:bg-surface-muted active:bg-surface-muted'
            }`}
          >
            {option === 'dark' ? 'Dark' : 'Light'}
          </button>
        ))}
      </div>

      <h2 className="mt-8 text-lg font-semibold">Backup</h2>
      <p className="mt-1 text-sm text-ink-muted">
        {sessionStatus === 'signedIn'
          ? 'Export a file of your account library, or import a backup to add recipes to this account.'
          : 'Sign in to export or import a backup of your account library.'}
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void doExport()}
          disabled={sessionStatus !== 'signedIn'}
          className={`${secondaryBtn} flex-1 py-2.5 disabled:opacity-40`}
        >
          Export library
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={sessionStatus !== 'signedIn'}
          className={`${secondaryBtn} flex-1 py-2.5 disabled:opacity-40`}
        >
          Import backup
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void doImport(file);
            e.target.value = '';
          }}
        />
      </div>
      {status && (
        <p
          className={`mt-2 text-sm ${statusKind === 'ok' ? 'text-success' : 'text-danger'}`}
        >
          {status}
        </p>
      )}

      <footer className="mt-8">
        <a
          href="/privacy"
          target="_blank"
          rel="noreferrer"
          className={`${backLink} inline-block py-3 pr-4`}
        >
          Privacy
        </a>
        <a
          href="/terms"
          target="_blank"
          rel="noreferrer"
          className={`${backLink} inline-block py-3`}
        >
          Terms
        </a>
      </footer>
    </div>
  );
}
