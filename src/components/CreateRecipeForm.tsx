import { useEffect, useRef, useState } from 'react';
import { resolveCollectionDestination } from '../lib/collectionDestination';
import { useCollections } from '../lib/collectionStore';
import { getSnapshot } from '../lib/libraryMemory';
import { photoStore } from '../lib/photoStore';
import { recipePhotoIds } from '../lib/recipePhotos';
import { recipeStore } from '../lib/recipeStore';
import { SpinnerIcon } from '../lib/icons';
import type { Recipe, RecipeDraft } from '../lib/types';
import { primaryBtn, secondaryBtn } from '../lib/uiClasses';
import RecipeForm from './RecipeForm';
import SaveToCollectionSheet from './SaveToCollectionSheet';

/** Owns a staged creation draft until saved or explicitly abandoned. */
export default function CreateRecipeForm({
  initial,
  collectionId,
  onCreated,
  onCancel,
  formId,
  onSubmitLockedChange,
}: {
  initial: RecipeDraft;
  collectionId?: string;
  onCreated: (recipe: Recipe) => void;
  onCancel: () => void;
  /** Lets a Save button outside this form submit it (the import header). */
  formId?: string;
  /** True while another save must not start (loading, or a save already underway). */
  onSubmitLockedChange?: (locked: boolean) => void;
}) {
  const collections = useCollections();
  const destination = resolveCollectionDestination(collections, collectionId);
  const [draft, setDraft] = useState<RecipeDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canSubmit, setCanSubmit] = useState(true);
  const inFlight = useRef(false);
  const stagedPhotoIds = useRef<string[]>([]);

  const discardPhotos = () => {
    for (const id of stagedPhotoIds.current) {
      // A failed save may already have uploaded some photos. Only discard
      // bytes that are still local; never remove an existing photo's metadata.
      if (!getSnapshot().remotePhotoIds.has(id)) photoStore.discardLocal(id);
    }
    stagedPhotoIds.current = [];
  };
  useEffect(() => () => {
    if (!inFlight.current) discardPhotos();
  }, []);
  useEffect(() => {
    if (draft && destination.kind === 'choose' && !busy) setChoosing(true);
  }, [draft, destination.kind, busy]);
  const submitLocked = destination.kind === 'loading' || draft !== null || !canSubmit;
  useEffect(() => {
    onSubmitLockedChange?.(submitLocked);
  }, [submitLocked, onSubmitLockedChange]);

  const cancelDraft = () => {
    if (inFlight.current) return;
    discardPhotos();
    setDraft(null);
    setChoosing(false);
    setError(null);
  };

  const save = async (pending: RecipeDraft, id: string | undefined) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const recipe = await recipeStore.create(pending, id ? { collectionId: id } : undefined);
      stagedPhotoIds.current = [];
      setDraft(null);
      onCreated(recipe);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const saveDirect = async (pending: RecipeDraft) => {
    if (destination.kind !== 'save') return;
    try {
      await save(pending, destination.collectionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the recipe.");
    }
  };

  return (
    <>
      <fieldset disabled={destination.kind === 'loading' || draft !== null} className="min-w-0">
        <RecipeForm
          initial={initial}
          formId={formId}
          onCanSubmitChange={setCanSubmit}
          submitLabel="Save to library"
          onCancel={onCancel}
          onSubmit={async (pending) => {
            const existingPhotos = new Set(recipePhotoIds(initial));
            stagedPhotoIds.current = recipePhotoIds(pending).filter((id) => !existingPhotos.has(id));
            setDraft(pending);
            await saveDirect(pending);
          }}
        />
      </fieldset>
      {destination.kind === 'loading' && <p role="status">Loading collections…</p>}
      {busy && !choosing && (
        <p role="status" className="flex items-center gap-2">
          <SpinnerIcon className="h-5 w-5 animate-spin" /> Saving…
        </p>
      )}
      {draft && choosing && (
        <SaveToCollectionSheet onSave={(id) => save(draft, id)} onCancel={cancelDraft} />
      )}
      {draft && error && !choosing && destination.kind === 'save' && (
        <div>
          <p role="alert" className="mt-2 text-sm text-danger">{error}</p>
          <button type="button" disabled={busy} onClick={() => void saveDirect(draft)} className={`${primaryBtn} mt-2 px-4 py-2`}>
            Try again
          </button>
          <button type="button" disabled={busy} onClick={cancelDraft} className={`${secondaryBtn} mt-2 ml-2 px-4 py-2`}>
            Back to recipe
          </button>
        </div>
      )}
    </>
  );
}
