import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { exportLibrary, importLibrary } from '../lib/backup';
import { settings, type Theme } from '../lib/settings';
import { applyTheme } from '../lib/theme';
import { backLink, inputClass, primaryBtn, secondaryBtn } from '../lib/uiClasses';

export default function Settings() {
  const [password, setPassword] = useState(settings.getPassword());
  const [theme, setTheme] = useState(settings.getTheme());
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'ok' | 'err' | null>(null);
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
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Import failed.');
      setStatusKind('err');
    }
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to="/" className={backLink}>
          &larr; Library
        </Link>
        <h1 className="mt-2 text-2xl font-bold">Settings</h1>
      </header>

      <label className="block">
        <span className="text-sm font-medium text-ink-muted">App password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setSaved(false);
          }}
          placeholder="Password for the assistant API"
          className={`mt-1 ${inputClass}`}
        />
      </label>
      <p className="mt-1.5 text-sm text-ink-muted">
        Must match the APP_PASSWORD configured on the server. Stored only on
        this device.
      </p>
      <button
        type="button"
        onClick={() => {
          settings.setPassword(password);
          setSaved(true);
        }}
        className={`${primaryBtn} mt-3 px-5 py-3`}
      >
        {saved ? 'Saved ✓' : 'Save'}
      </button>

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
        Recipes live only on this device. Export a backup file now and then,
        so a lost phone doesn't mean a lost library.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void doExport()}
          className={`${secondaryBtn} flex-1 py-2.5`}
        >
          Export library
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className={`${secondaryBtn} flex-1 py-2.5`}
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
    </div>
  );
}
