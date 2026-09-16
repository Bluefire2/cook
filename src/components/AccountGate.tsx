import { useEffect, useRef, useState } from 'react';
import { exportLibrary } from '../lib/backup';
import { confirmMigration, useSyncStatus } from '../lib/syncEngine';
import { signOut } from '../lib/session';
import { useRecipes } from '../lib/recipeStore';
import { primaryBtn, secondaryBtn } from '../lib/uiClasses';

export default function AccountGate() {
  const { status } = useSyncStatus();
  const recipes = useRecipes();
  const [exported, setExported] = useState(false);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status !== 'needsMigration') {
      return;
    }
    const first = panelRef.current?.querySelector('button, a');
    if (first instanceof HTMLElement) {
      first.focus();
    }
  }, [status]);

  if (status !== 'needsMigration' && !busy) {
    return null;
  }

  const count = recipes?.length ?? 0;
  const recipeWord = count === 1 ? 'recipe' : 'recipes';

  const doExport = async () => {
    const blob = await exportLibrary();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cook-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setExported(true);
  };

  const doContinue = async () => {
    if (!exported || busy) {
      return;
    }
    setBusy(true);
    try {
      await confirmMigration();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-gate-heading"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
        }
      }}
    >
      <div className="flex-1 bg-black/40" />
      <div
        ref={panelRef}
        className="rounded-t-3xl bg-surface px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl md:mx-auto md:w-full md:max-w-xl"
      >
        <h2 id="account-gate-heading" className="text-lg font-semibold">
          Add this device's recipes to your account
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          This device has <strong>{count}</strong> {recipeWord} that aren't in
          your account yet. Export a backup first, then continue — your
          account's library replaces the copy on this device, and you can
          import the backup afterwards to add these recipes to your account.
        </p>
        <button
          type="button"
          onClick={() => void doExport()}
          disabled={busy}
          className={`${primaryBtn} mt-4 w-full py-2.5`}
        >
          Export backup
        </button>
        <button
          type="button"
          onClick={() => void doContinue()}
          disabled={!exported || busy}
          className={`${secondaryBtn} mt-2 w-full py-2.5`}
        >
          {busy ? 'Loading your library…' : 'Continue'}
        </button>
        {!exported && !busy && (
          <p className="mt-2 text-sm text-ink-muted">
            Export a backup before continuing — this is the only way to keep a
            copy of what's on this device.
          </p>
        )}
        <button
          type="button"
          onClick={() => void signOut()}
          disabled={busy}
          className={`${secondaryBtn} mt-4 mb-2 w-full py-2.5 opacity-70`}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
