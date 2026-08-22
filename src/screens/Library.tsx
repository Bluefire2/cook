import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { usePhotoUrl } from '../lib/photoStore';
import { recipeStore, useRecipes } from '../lib/recipeStore';

function CardThumb({ photoId }: { photoId: string }) {
  const url = usePhotoUrl(photoId);
  return (
    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-stone-100">
      {url && <img src={url} alt="" className="h-full w-full object-cover" />}
    </div>
  );
}

function Sheet({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="flex-1 bg-black/20"
      />
      <div className="rounded-t-3xl bg-white px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl md:mx-auto md:w-full md:max-w-xl">
        {children}
      </div>
    </div>
  );
}

export default function Library() {
  const allRecipes = useRecipes();
  const [query, setQuery] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const recipes =
    q === ''
      ? allRecipes
      : allRecipes?.filter(
          (r) =>
            r.title.toLowerCase().includes(q) ||
            r.tags.some((tag) => tag.toLowerCase().includes(q)),
        );

  const pendingDelete = allRecipes?.find((r) => r.id === pendingDeleteId);

  const remove = async (id: string) => {
    setPendingDeleteId(null);
    await recipeStore.remove(id);
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="flex items-center justify-between py-4">
        <h1 className="text-2xl font-bold">Cook</h1>
        <Link
          to="/settings"
          className="rounded-full px-3 py-1 text-sm text-stone-500"
        >
          Settings
        </Link>
      </header>

      <input
        type="search"
        placeholder="Search recipes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-4 w-full rounded-xl border border-stone-200 bg-white px-4 py-2.5 shadow-sm outline-none focus:border-stone-400"
      />

      {recipes === undefined ? null : recipes.length === 0 ? (
        <p className="py-12 text-center text-stone-500">
          {q === ''
            ? 'No recipes yet. Import your first one!'
            : 'No recipes match your search.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {recipes.map((recipe) => (
            <li key={recipe.id} className="relative">
              <Link
                to={`/recipe/${recipe.id}`}
                className="flex gap-3 rounded-2xl border border-stone-200 bg-white p-4 pr-14 shadow-sm active:bg-stone-50"
              >
                {recipe.photoId !== undefined && (
                  <CardThumb photoId={recipe.photoId} />
                )}
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold">{recipe.title}</h2>
                  {recipe.description && (
                    <p className="mt-1 line-clamp-2 text-sm text-stone-500">
                      {recipe.description}
                    </p>
                  )}
                  {recipe.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {recipe.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </Link>

              <button
                type="button"
                aria-label={`Actions for ${recipe.title}`}
                onClick={() =>
                  setMenuId(menuId === recipe.id ? null : recipe.id)
                }
                className="absolute top-2 right-2 flex h-11 w-11 items-center justify-center rounded-full text-xl leading-none text-stone-400 active:bg-stone-100"
              >
                ⋯
              </button>

              {menuId === recipe.id && (
                <div className="absolute top-13 right-3 z-20 w-40 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xl">
                  <Link
                    to={`/recipe/${recipe.id}/edit`}
                    className="block px-4 py-3 active:bg-stone-50"
                  >
                    Edit
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuId(null);
                      setPendingDeleteId(recipe.id);
                    }}
                    className="block w-full border-t border-stone-100 px-4 py-3 text-left text-red-600 active:bg-stone-50"
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {menuId !== null && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMenuId(null)}
          className="fixed inset-0 z-10"
        />
      )}

      <button
        type="button"
        aria-label="Add recipe"
        onClick={() => setAddOpen(true)}
        className="fixed right-5 bottom-8 flex h-14 w-14 items-center justify-center rounded-full bg-stone-800 text-3xl leading-none text-white shadow-lg active:bg-stone-700"
      >
        +
      </button>

      {addOpen && (
        <Sheet onClose={() => setAddOpen(false)}>
          <h2 className="text-lg font-semibold">Add a recipe</h2>
          <Link
            to="/import"
            className="mt-3 block rounded-full bg-stone-800 py-3 text-center font-medium text-white"
          >
            Import from a link or text
          </Link>
          <Link
            to="/recipe/new"
            className="mt-2 block rounded-full border border-stone-300 py-3 text-center font-medium text-stone-700"
          >
            Write one from scratch
          </Link>
          <button
            type="button"
            onClick={() => setAddOpen(false)}
            className="mt-2 w-full py-2.5 text-sm text-stone-500"
          >
            Cancel
          </button>
        </Sheet>
      )}

      {pendingDelete && (
        <Sheet onClose={() => setPendingDeleteId(null)}>
          <h2 className="text-lg font-semibold">
            Delete “{pendingDelete.title}”?
          </h2>
          <p className="mt-1 text-sm text-stone-500">
            This also deletes its chat history. There is no undo.
          </p>
          <button
            type="button"
            onClick={() => void remove(pendingDelete.id)}
            className="mt-3 w-full rounded-full bg-red-600 py-3 font-medium text-white active:bg-red-700"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setPendingDeleteId(null)}
            className="mt-2 w-full rounded-full border border-stone-300 py-3 font-medium text-stone-600"
          >
            Cancel
          </button>
        </Sheet>
      )}
    </div>
  );
}
