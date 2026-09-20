import { useState, type ReactNode } from 'react';
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
      disabled={Boolean(disabled) && !busy}
      aria-busy={active || undefined}
      aria-disabled={busy || disabled || undefined}
      className={`inline-flex items-center justify-center gap-2 ${className} ${busy ? 'pointer-events-none' : ''} ${busy && !active ? 'opacity-40' : ''}`}
    >
      {active && <SpinnerIcon className="block h-5 w-5 animate-spin" />}
      {children}
    </button>
  );
}

export default function SaveToCollectionSheet({
  onSave,
  onCancel,
}: {
  onSave: (collectionId: string | undefined) => void | Promise<void>;
  onCancel: () => void;
}) {
  const collections = useCollections() ?? [];
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;

  const save = async (collectionId: string | undefined) => {
    if (busy) {
      return;
    }
    setPending(collectionId ?? UNFILED);
    setError(null);
    try {
      await onSave(collectionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the recipe.");
      setPending(null);
    }
  };

  const createAndSave = async () => {
    if (busy) {
      return;
    }
    setPending(CREATE);
    setError(null);
    try {
      const created = await collectionStore.create(name);
      await onSave(created.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't save the collection.",
      );
      setPending(null);
    }
  };

  return (
    <Sheet onClose={onCancel}>
      <h2 className="text-lg font-semibold">Save to</h2>
      <SaveActionButton
        active={pending === UNFILED}
        busy={busy}
        onClick={() => void save(undefined)}
        className="mt-3 w-full rounded-xl bg-surface-muted py-3 font-medium text-ink hover:bg-line active:bg-line"
      >
        No collection
      </SaveActionButton>
      {collections.length > 0 && (
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
          autoFocus={collections.length === 0}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          disabled={busy}
          className={`${inputClass} mt-1.5`}
        />
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        <SaveActionButton
          type="submit"
          active={pending === CREATE}
          busy={busy}
          disabled={name.trim() === ''}
          className={`${primaryBtn} mt-3 w-full py-3`}
        >
          Create and save
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
