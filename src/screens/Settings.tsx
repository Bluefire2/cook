import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { exportLibrary, importLibrary } from '../lib/backup';
import { settings } from '../lib/settings';

export default function Settings() {
  const [password, setPassword] = useState(settings.getPassword());
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      const count = await importLibrary(file);
      setStatus(`Imported ${count} recipe${count === 1 ? '' : 's'} ✓`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Import failed.');
    }
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to="/" className="text-sm text-stone-500">
          &larr; Library
        </Link>
        <h1 className="mt-2 text-2xl font-bold">Settings</h1>
      </header>

      <label className="block">
        <span className="text-sm font-medium text-stone-600">App password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setSaved(false);
          }}
          placeholder="Password for the assistant API"
          className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-4 py-2.5 shadow-sm outline-none focus:border-stone-400"
        />
      </label>
      <p className="mt-1.5 text-sm text-stone-500">
        Must match the APP_PASSWORD configured on the server. Stored only on
        this device.
      </p>
      <button
        type="button"
        onClick={() => {
          settings.setPassword(password);
          setSaved(true);
        }}
        className="mt-3 rounded-full bg-stone-800 px-5 py-2 font-medium text-white"
      >
        {saved ? 'Saved ✓' : 'Save'}
      </button>

      <h2 className="mt-8 text-lg font-semibold">Backup</h2>
      <p className="mt-1 text-sm text-stone-500">
        Recipes live only on this device. Export a backup file now and then,
        so a lost phone doesn't mean a lost library.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void doExport()}
          className="flex-1 rounded-full border border-stone-300 py-2.5 font-medium text-stone-700"
        >
          Export library
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex-1 rounded-full border border-stone-300 py-2.5 font-medium text-stone-700"
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
      {status && <p className="mt-2 text-sm text-stone-600">{status}</p>}
    </div>
  );
}
