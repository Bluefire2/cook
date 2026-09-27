import { useEffect, useState } from 'react';
import Sheet from './Sheet';
import { collectionStore } from '../lib/collectionStore';
import type { CollectionGrant, GrantRole } from '../lib/remote';
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
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<GrantRole>('viewer');
  const [grants, setGrants] = useState<CollectionGrant[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          setError(err instanceof Error ? err.message : "Couldn't load sharing.");
          setGrants([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [collection.id]);

  const add = async () => {
    setError(null);
    setBusy(true);
    try {
      await collectionStore.addGrant(collection.id, email, role);
      setEmail('');
      setRole('viewer');
      setGrants(await collectionStore.listGrants(collection.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update sharing.");
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
      setError(err instanceof Error ? err.message : "Couldn't update sharing.");
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
      setError(err instanceof Error ? err.message : "Couldn't update sharing.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={onClose} dismissible={!busy}>
      <h2 className="text-lg font-semibold">Share “{collection.name}”</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Add someone who already has a Sous account. Viewers can see these
        recipes and photos. Editors can also edit the recipes, but not their
        photos.
      </p>
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
            placeholder="Email"
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
          Share
        </button>
      </form>
      <ul className="mt-4 flex flex-col gap-2">
        {grants === undefined && (
          <li className="text-sm text-ink-muted">Loading…</li>
        )}
        {grants?.length === 0 && (
          <li className="text-sm text-ink-muted">Nobody else can see this yet.</li>
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
              label={`Role for ${grant.email}`}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void revoke(grant.sub)}
              className={`${dangerBtn} px-3 py-1.5 text-xs`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onClose}
        className={`${secondaryBtn} mt-3 w-full py-3`}
      >
        Done
      </button>
    </Sheet>
  );
}

function RoleSelect({
  value,
  onChange,
  disabled,
  label = 'Role',
}: {
  value: GrantRole;
  onChange: (role: GrantRole) => void;
  disabled: boolean;
  label?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === 'editor' ? 'editor' : 'viewer')}
      className={`${cellClass} shrink-0 bg-surface text-sm`}
    >
      <option value="viewer">Viewer</option>
      <option value="editor">Editor</option>
    </select>
  );
}
