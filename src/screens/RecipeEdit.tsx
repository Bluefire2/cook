import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import RecipeForm from '../components/RecipeForm';
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
  const [initial] = useState(blankDraft);

  const create = async (draft: RecipeDraft) => {
    const recipe = await recipeStore.create(draft);
    navigate(`/recipe/${recipe.id}`, { replace: true });
  };

  return (
    <Screen heading="New recipe" backTo="/" backLabel="Library">
      <RecipeForm
        initial={initial}
        submitLabel="Save"
        onSubmit={create}
        onCancel={() => navigate('/')}
      />
    </Screen>
  );
}

function EditRecipe({ id }: { id: string }) {
  const navigate = useNavigate();
  const recipe = useRecipe(id);

  if (recipe === undefined) return null;
  if (recipe === null) {
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
      />
    </Screen>
  );
}

export default function RecipeEdit() {
  const { id } = useParams<{ id: string }>();
  return id === undefined ? <CreateRecipe /> : <EditRecipe id={id} />;
}
