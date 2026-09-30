/** Route patterns for the library and the collection paths that hang off it. */
export const routePaths = {
  home: '/',
  collection: '/collections/:collectionId',
  collectionImport: '/collections/:collectionId/import',
  collectionNewRecipe: '/collections/:collectionId/recipe/new',
  collectionsIndex: '/collections',
  collectionsUnknown: '/collections/*',
  import: '/import',
  newRecipe: '/recipe/new',
} as const;
