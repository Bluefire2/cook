import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import RecipeForm from '../components/RecipeForm';
import { blankDraft } from '../lib/recipeDraft';
import { recipeStore, useRecipe } from '../lib/recipeStore';
import type { RecipeDraft } from '../lib/types';

function Screen({
  heading,
  backTo,
  backLabel,
  children,
}: {
  heading: string;
  backTo: string;
  backLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to={backTo} className="text-sm text-stone-500">
          &larr; {backLabel}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{heading}</h1>
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
      <div className="p-6 text-center text-stone-500">
        Recipe not found.{' '}
        <Link to="/" className="underline">
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
    >
      <RecipeForm
        initial={recipe}
        submitLabel="Save"
        onSubmit={save}
        onCancel={() => navigate(`/recipe/${recipe.id}`)}
      />
    </Screen>
  );
}

export default function RecipeEdit() {
  const { id } = useParams<{ id: string }>();
  return id === undefined ? <CreateRecipe /> : <EditRecipe id={id} />;
}
