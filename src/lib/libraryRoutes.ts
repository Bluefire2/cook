import { matchPath } from 'react-router-dom';

/** `/` and `/collections/:id` (not import, new-recipe, or junk paths). */
export function isLibraryListPath(pathname: string): boolean {
  if (pathname === '/') {
    return true;
  }
  return (
    matchPath({ path: '/collections/:collectionId', end: true }, pathname) !== null
  );
}
