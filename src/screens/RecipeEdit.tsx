import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import RecipeForm from '../components/RecipeForm';
import CreateRecipeForm from '../components/CreateRecipeForm';
import { libraryHref, useCollections } from '../lib/collectionStore';
import { isSharedCollection, isSharedRecipe } from '../lib/libraryMemory';
import { blankDraft } from '../lib/recipeDraft';
import { recipeStore, useRecipe } from '../lib/recipeStore';
import { backLink, primaryBtn } from '../lib/uiClasses';
import type { RecipeDraft } from '../lib/types';

const EDIT_FORM_ID = 'recipe-edit-form';

function Screen({
  heading,
  backTo,
  backLabel,
  action,
  children,
}: {
  heading: string;
  backTo: string;
  backLabel: string;
  /** Optional control shown on the right, opposite the heading. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to={backTo} className={backLink}>
          &larr; {backLabel}
        </Link>
        <div className="mt-2 flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">{heading}</h1>
          {action}
        </div>
      </header>
      {children}
    </div>
  );
}

function CreateRecipe() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const collectionId = params.get('c') ?? undefined;
  // Subscribed, not a one-shot store read: on a cold load of `?c=<id>` the
  // pull has not landed yet, and only a subscriber re-renders once it does.
  const collections = useCollections();
  const knownCollectionId =
    collectionId &&
    collections?.some((c) => c.id === collectionId && !isSharedCollection(c.id))
      ? collectionId
      : undefined;
  const backTo = libraryHref(knownCollectionId);
  const [initial] = useState(blankDraft);

  return (
    <Screen heading="New recipe" backTo={backTo} backLabel="Library">
      <CreateRecipeForm
        initial={initial}
        collectionId={knownCollectionId}
        onCreated={(recipe) => navigate(`/recipe/${recipe.id}`, { replace: true })}
        onCancel={() => navigate(backTo)}
      />
    </Screen>
  );
}

function EditRecipe({ id }: { id: string }) {
  const navigate = useNavigate();
  const recipe = useRecipe(id);
  const [canSubmit, setCanSubmit] = useState(true);
  const onCanSubmitChange = useCallback((next: boolean) => {
    setCanSubmit((prev) => (prev === next ? prev : next));
  }, []);

  if (recipe === undefined) {
    return (
      <div className="p-6 text-center text-ink-muted">Loading recipe…</div>
    );
  }
  if (recipe === null || isSharedRecipe(id)) {
    return (
      <div className="p-6 text-center text-ink-muted">
        Recipe not found.{' '}
        <Link to="/" className="underline hover:text-ink">
          Back to library
        </Link>
      </div>
    );
  }

  // `save` replaces the whole record, so identity and the fields the form has
  // no UI for are carried over by hand rather than by spreading the old recipe
  // — a spread would resurrect optional fields the user just cleared.
  const save = async (draft: RecipeDraft) => {
    await recipeStore.save({
      ...draft,
      id: recipe.id,
      createdAt: recipe.createdAt,
      updatedAt: recipe.updatedAt,
      ...(recipe.sourceUrl !== undefined ? { sourceUrl: recipe.sourceUrl } : {}),
    });
    navigate(`/recipe/${recipe.id}`, { replace: true });
  };

  return (
    <Screen
      heading="Edit recipe"
      backTo={`/recipe/${recipe.id}`}
      backLabel="Recipe"
      action={
        <button
          type="submit"
          form={EDIT_FORM_ID}
          disabled={!canSubmit}
          className={`${primaryBtn} shrink-0 px-5 py-2`}
        >
          Save
        </button>
      }
    >
      <RecipeForm
        initial={recipe}
        submitLabel="Save"
        onSubmit={save}
        onCancel={() => navigate(`/recipe/${recipe.id}`)}
        formId={EDIT_FORM_ID}
        onCanSubmitChange={onCanSubmitChange}
      />
    </Screen>
  );
}

export default function RecipeEdit() {
  const { id } = useParams<{ id: string }>();
  return id === undefined ? <CreateRecipe /> : <EditRecipe id={id} />;
}
