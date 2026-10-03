import { t } from '../i18n';
import { serverErrorText } from './errorText';
import { isUsableRecipe } from './recipeShape';
import { invalidateSession } from './session';
import type { Recipe } from './types';

/**
 * A public collection (`docs/plans/public-collections.md`): what anyone with
 * the link reads at `/p/<token>`. Fetched fresh on every screen; never put in
 * `libraryMemory`, synced, or cached, so turning the link off wins at once.
 */
export type PublicCollectionData = {
  collection: { id: string; name: string };
  recipes: Recipe[];
};

export type PublicCollectionResult =
  | { kind: 'ok'; data: PublicCollectionData }
  | { kind: 'missing' }
  | { kind: 'error' };

/** Drops anything malformed rather than failing the page. Null when the envelope is wrong. */
export function parsePublicCollection(body: unknown): PublicCollectionData | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const record = body as { collection?: unknown; recipes?: unknown };
  const collection = record.collection as { id?: unknown; name?: unknown } | undefined;
  if (
    !collection ||
    typeof collection !== 'object' ||
    typeof collection.id !== 'string' ||
    typeof collection.name !== 'string' ||
    !Array.isArray(record.recipes)
  ) {
    return null;
  }
  return {
    collection: { id: collection.id, name: collection.name },
    recipes: record.recipes.filter(isUsableRecipe),
  };
}

export async function fetchPublicCollection(token: string): Promise<PublicCollectionResult> {
  let response: Response;
  try {
    response = await fetch(`/api/public/${encodeURIComponent(token)}`, {
      // A visitor read: the cookie, if any, is not needed and not sent.
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    return { kind: 'error' };
  }
  if (response.status === 404) {
    return { kind: 'missing' };
  }
  if (!response.ok) {
    return { kind: 'error' };
  }
  try {
    const data = parsePublicCollection(await response.json());
    return data === null ? { kind: 'error' } : { kind: 'ok', data };
  } catch {
    return { kind: 'error' };
  }
}

export function publicPhotoUrl(token: string, recipeId: string, photoId: string): string {
  return `/api/public/${encodeURIComponent(token)}/recipes/${encodeURIComponent(
    recipeId,
  )}/photos/${encodeURIComponent(photoId)}`;
}

export type PublicJoinResult =
  | { kind: 'ok'; collectionId: string; result: 'joined' | 'already' | 'own' }
  | { kind: 'signedOut' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** A signed-in member adds the collection to their library as a viewer. */
export async function joinPublicCollection(token: string): Promise<PublicJoinResult> {
  let response: Response;
  try {
    response = await fetch('/api/public/join', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    return { kind: 'error', message: t('public.joinFailed') };
  }
  if (response.status === 401 || response.status === 403) {
    invalidateSession();
    return { kind: 'signedOut' };
  }
  if (response.status === 404) {
    return { kind: 'missing' };
  }
  if (response.status === 409) {
    // The grant cap. The server's `share-full` words are for the owner.
    return { kind: 'error', message: t('public.joinFull') };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    return { kind: 'error', message: serverErrorText(body, 'public.joinFailed') };
  }
  const record = (body ?? {}) as { collectionId?: unknown; result?: unknown };
  if (
    typeof record.collectionId !== 'string' ||
    (record.result !== 'joined' && record.result !== 'already' && record.result !== 'own')
  ) {
    return { kind: 'error', message: t('public.joinFailed') };
  }
  return { kind: 'ok', collectionId: record.collectionId, result: record.result };
}

/**
 * Sign-in from a public page comes back to `/p`, never `/p/<token>`: the
 * return path rides the OAuth start URL and cookie, and the token must stay
 * out of both. The token waits in this tab's sessionStorage instead.
 */
const RETURN_KEY = 'sous.publicReturn';

export const PUBLIC_RETURN_PATH = '/p';

export function rememberPublicReturn(token: string): void {
  try {
    sessionStorage.setItem(RETURN_KEY, token);
  } catch {
    // Storage can be blocked; sign-in then lands on the library instead.
  }
}

/** The token sign-in should come back to, if any. Read only: StrictMode may call this twice. */
export function readPublicReturn(): string | null {
  try {
    const token = sessionStorage.getItem(RETURN_KEY);
    return token !== null && /^[A-Za-z0-9_-]{20,64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function clearPublicReturn(): void {
  try {
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // Nothing to clear.
  }
}
