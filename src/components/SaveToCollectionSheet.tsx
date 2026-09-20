import { useRef, useState, type ReactNode } from 'react';
import { collectionStore, useCollections } from '../lib/collectionStore';
import { SpinnerIcon } from '../lib/icons';
import { inputClass, primaryBtn, secondaryBtn } from '../lib/uiClasses';
import Sheet from './Sheet';

const UNFILED = 'unfiled';
const CREATE = 'create';

function SaveActionButton({
  active,
  busy,
  className,
  disabled,
  onClick,
  type = 'button',
  children,
}: {
  active: boolean;
  busy: boolean;
  className: string;
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={active || undefined}
      className={`inline-flex items-center justify-center gap-2 ${className}`}
      style={{ opacity: active ? 1 : busy || disabled ? 0.4 : undefined }}
    >
      {active && <SpinnerIcon className="block h-5 w-5 animate-spin" />}
      {children}
    </button>
  );
}

export default function SaveToCollectionSheet({
  onSave,
  onCancel,
  title = 'Save to',
  createLabel = 'Create and save',
}: {
  onSave: (collectionId: string | undefined) => void | Promise<void>;
  onCancel: () => void;
  title?: string;
  createLabel?: string;
}) {
  const collections = useCollections();
  const inFlight = useRef(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Survives a failed save so a retry reuses the collection instead of
  // creating a second one with the same name.
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const busy = pending !== null;

  const save = async (collectionId: string | undefined) => {
    if (inFlight.current || collections === undefined) {
      return;
    }
    inFlight.current = true;
    setPending(collectionId ?? UNFILED);
    setError(null);
    try {
      await onSave(collectionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the recipe.");
      setPending(null);
    } finally {
      inFlight.current = false;
    }
  };

  const createAndSave = async () => {
    if (inFlight.current || collections === undefined) {
      return;
    }
    inFlight.current = true;
    const trimmed = name.trim();
    setPending(CREATE);
    setError(null);
    try {
      let id: string;
      if (created === null || !collectionStore.get(created.id)) {
        id = (await collectionStore.create(name)).id;
        setCreated({ id, name: trimmed });
      } else {
        id = created.id;
        if (created.name !== trimmed) {
          await collectionStore.rename(id, name);
          setCreated({ id, name: trimmed });
        }
      }
      await onSave(id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't save the collection.",
      );
      setPending(null);
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <Sheet onClose={onCancel} dismissible={!busy}>
      <h2 className="text-lg font-semibold">{title}</h2>
      {collections === undefined && <p role="status">Loading collections…</p>}
      <SaveActionButton
        active={pending === UNFILED}
        busy={busy}
        disabled={collections === undefined}
        onClick={() => void save(undefined)}
        className="mt-3 w-full rounded-xl bg-surface-muted py-3 font-medium text-ink hover:bg-line active:bg-line"
      >
        No collection
      </SaveActionButton>
      {collections !== undefined && collections.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-sm font-medium text-ink-muted">Collections</p>
          {collections.map((collection) => (
            <SaveActionButton
              key={collection.id}
              active={pending === collection.id}
              busy={busy}
              onClick={() => void save(collection.id)}
              className={`${secondaryBtn} mt-2 w-full py-3`}
            >
              {collection.name}
            </SaveActionButton>
          ))}
        </div>
      )}
      <form
        className="mt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void createAndSave();
        }}
      >
        <label className="text-sm font-medium text-ink" htmlFor="save-new-collection">
          New collection
        </label>
        <input
          id="save-new-collection"
          autoFocus={collections?.length === 0}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          disabled={busy || collections === undefined}
          className={`${inputClass} mt-1.5`}
        />
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        <SaveActionButton
          type="submit"
          active={pending === CREATE}
          busy={busy}
          disabled={name.trim() === '' || collections === undefined}
          className={`${primaryBtn} mt-3 w-full py-3`}
        >
          {createLabel}
        </SaveActionButton>
      </form>
      <button
        type="button"
        disabled={busy}
        onClick={onCancel}
        className="mt-2 w-full py-2.5 text-sm text-ink-muted hover:text-ink"
      >
        Cancel
      </button>
    </Sheet>
  );
}
