import type { Recipe } from './types';

export function visibleLibraryRecipes({
  all,
  scoped,
  query,
  browseAll,
}: {
  all: readonly Recipe[] | undefined;
  scoped: readonly Recipe[] | undefined;
  query: string;
  browseAll: boolean;
}): Recipe[] | undefined {
  if (all === undefined || scoped === undefined) {
    return undefined;
  }
  const source = browseAll ? all : scoped;
  const q = query.trim().toLowerCase();
  if (q === '') {
    return [...source];
  }
  return source.filter(
    (recipe) =>
      recipe.title.toLowerCase().includes(q) ||
      recipe.tags.some((tag) => tag.toLowerCase().includes(q)),
  );
}
