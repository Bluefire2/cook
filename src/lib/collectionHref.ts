function collectionPath(collectionId: string): string {
  return `/collections/${encodeURIComponent(collectionId)}`;
}

export function libraryHref(collectionId: string | undefined): string {
  if (collectionId === undefined || collectionId === '') {
    return '/';
  }
  return collectionPath(collectionId);
}

export function importHref(collectionId: string | undefined): string {
  if (collectionId === undefined || collectionId === '') {
    return '/import';
  }
  return `${collectionPath(collectionId)}/import`;
}

export function newRecipeHref(collectionId: string | undefined): string {
  if (collectionId === undefined || collectionId === '') {
    return '/recipe/new';
  }
  return `${collectionPath(collectionId)}/recipe/new`;
}
