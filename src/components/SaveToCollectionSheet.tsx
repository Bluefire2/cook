import { useState } from 'react';
import { collectionStore, useCollections } from '../lib/collectionStore';
import { inputClass, primaryBtn, secondaryBtn } from '../lib/uiClasses';
import Sheet from './Sheet';

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
  const [busy, setBusy] = useState(false);

  const save = async (collectionId: string | undefined) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(collectionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the recipe.");
      setBusy(false);
    }
  };

  const createAndSave = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await collectionStore.create(name);
      await onSave(created.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't save the collection.",
      );
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={onCancel}>
      <h2 className="text-lg font-semibold">Save to</h2>
      <button
        type="button"
        disabled={busy}
        onClick={() => void save(undefined)}
        className={`${secondaryBtn} mt-3 w-full py-3`}
      >
        Without a collection
      </button>
      {collections.map((collection) => (
        <button
          key={collection.id}
          type="button"
          disabled={busy}
          onClick={() => void save(collection.id)}
          className={`${secondaryBtn} mt-2 w-full py-3`}
        >
          {collection.name}
        </button>
      ))}
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
        <button
          type="submit"
          disabled={busy || name.trim() === ''}
          className={`${primaryBtn} mt-3 w-full py-3`}
        >
          Create and save
        </button>
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
