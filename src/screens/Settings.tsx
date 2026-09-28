import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { isSupportedLocale, languageName, SUPPORTED_LOCALES, useLocale, useT } from '../i18n';
import { exportLibrary, importLibrary } from '../lib/backup';
import { relativeAgoLabel } from '../lib/relativeTime';
import { notifyImportComplete, sync, useSyncStatus } from '../lib/syncEngine';
import { signInHref, signOut, useSession } from '../lib/session';
import { settings, type Theme } from '../lib/settings';
import { applyTheme } from '../lib/theme';
import { backLink, inputClass, primaryBtn, secondaryBtn } from '../lib/uiClasses';

export default function Settings() {
  const { user, status: sessionStatus } = useSession();
  const syncStatus = useSyncStatus();
  const t = useT();
  const locale = useLocale();
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
    if (!user) {
      return;
    }
    const blob = await exportLibrary(user.sub);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cook-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = async (file: File) => {
    if (!user) {
      return;
    }
    try {
      const { imported, skipped } = await importLibrary(file, user.sub);
      const importedLine = t('settings.importedRecipes', { count: imported });
      const skippedLine =
        skipped > 0 ? t('settings.importSkipped', { count: skipped }) : '';
      setStatus(skippedLine === '' ? importedLine : `${importedLine} ${skippedLine}`);
      setStatusKind(skipped > 0 ? 'err' : 'ok');
      notifyImportComplete();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : t('error.importFailed'));
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
      return t('settings.notLoaded');
    }
    return t('settings.loadedAgo', { time: relativeAgoLabel(at) });
  })();

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to="/" className={backLink}>
          &larr; {t('common.library')}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{t('settings.title')}</h1>
      </header>

      {sessionStatus !== 'loading' && (
        <>
          <h2 className="mt-2 text-lg font-semibold">{t('settings.account')}</h2>
          {sessionStatus === 'signedOut' && (
            <>
              <p className="mt-1 text-sm text-ink-muted">
                {t('settings.signInPrompt')}
              </p>
              <a
                href={signInHref('/settings')}
                className={`${primaryBtn} mt-3 inline-block px-4 py-2.5`}
              >
                {t('settings.signInWithGoogle')}
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
                  {t('settings.signOut')}
                </button>
              </div>
              {user.isOwner === true && (
                <>
                  <p className="mt-4 text-sm text-ink-muted">
                    {t('settings.ownerHint')}
                  </p>
                  <Link
                    to="/admin"
                    className={`${secondaryBtn} mt-2 inline-block px-4 py-2.5`}
                  >
                    {t('admin.title')}
                  </Link>
                </>
              )}
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
                {t('settings.offline')}
              </p>
            </>
          )}
        </>
      )}

      {sessionStatus === 'signedIn' && (
        <>
          <h2 className="mt-8 text-lg font-semibold">{t('common.library')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{syncedLabel}</p>
          {syncStatus.status === 'error' && (
            <p className="mt-1 text-sm text-danger">
              {t('settings.loadError')}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void doRefresh()}
              disabled={busy || syncStatus.status === 'loading'}
              className={`${secondaryBtn} flex-1 py-2.5`}
            >
              {busy || syncStatus.status === 'loading' ? t('common.loading') : t('common.refresh')}
            </button>
          </div>
        </>
      )}

      <h2 className="mt-8 text-lg font-semibold">{t('settings.appearance')}</h2>
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
            {option === 'dark' ? t('settings.dark') : t('settings.light')}
          </button>
        ))}
      </div>

      <label htmlFor="settings-language" className="mt-8 block text-lg font-semibold">
        {t('settings.language')}
      </label>
      <select
        id="settings-language"
        value={locale}
        onChange={(event) => {
          const next = event.target.value;
          if (isSupportedLocale(next)) {
            settings.setLocale(next);
          }
        }}
        className={`${inputClass} mt-3`}
      >
        {SUPPORTED_LOCALES.map((code) => (
          <option key={code} value={code}>
            {languageName(code, code) ?? code}
          </option>
        ))}
      </select>

      <h2 className="mt-8 text-lg font-semibold">{t('settings.backup')}</h2>
      <p className="mt-1 text-sm text-ink-muted">
        {sessionStatus === 'signedIn'
          ? t('settings.backupSignedIn')
          : t('settings.backupSignedOut')}
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void doExport()}
          disabled={sessionStatus !== 'signedIn'}
          className={`${secondaryBtn} flex-1 py-2.5 disabled:opacity-40`}
        >
          {t('settings.exportLibrary')}
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={sessionStatus !== 'signedIn'}
          className={`${secondaryBtn} flex-1 py-2.5 disabled:opacity-40`}
        >
          {t('settings.importBackup')}
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
          href="/about"
          target="_blank"
          rel="noreferrer"
          className={`${backLink} inline-block py-3 pr-4`}
        >
          {t('settings.about')}
        </a>
        <a
          href="/privacy"
          target="_blank"
          rel="noreferrer"
          className={`${backLink} inline-block py-3 pr-4`}
        >
          {t('settings.privacy')}
        </a>
        <a
          href="/terms"
          target="_blank"
          rel="noreferrer"
          className={`${backLink} inline-block py-3`}
        >
          {t('settings.terms')}
        </a>
      </footer>
    </div>
  );
}
