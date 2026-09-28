import { t } from '../i18n';
import { serverErrorText } from './errorText';
import type { EncodedImage } from './image';
import { invalidateSession } from './session';
import type { RecipeDraft } from './types';

export type ExtractedRecipe = RecipeDraft;

/**
 * `translation` is the translated draft for the import preview.
 * Callers save `recipe` unless the preview is showing the translation.
 */
export interface ImportRecipeResult {
  recipe: ExtractedRecipe;
  translation?: { lang: string; recipe: ExtractedRecipe };
  translationFailed?: true;
}

function drafted(recipe: ExtractedRecipe): ExtractedRecipe {
  return {
    ...recipe,
    tags: recipe.tags ?? [],
    ingredientSections: recipe.ingredientSections ?? [],
    steps: recipe.steps ?? [],
  };
}

export const MAX_IMPORT_PHOTOS = 4;
export const IMPORT_PHOTO_LIMIT_ERROR = 'Up to 4 photos.';

// Mirrors of the server caps in `server/importRoute.ts`, which stay
// authoritative; these turn an after-upload 413 into an at-pick-time message.
export const MAX_IMPORT_PHOTO_BYTES = 3 * 1024 * 1024;
/** The 12 MiB body cap, less headroom for the JSON wrapper and notes. */
export const MAX_IMPORT_PHOTOS_BASE64_CHARS = 12 * 1024 * 1024 - 64 * 1024;
export const IMPORT_PHOTO_TOO_LARGE_ERROR = 'That photo is too large — try a smaller one.';
export const IMPORT_PHOTOS_TOTAL_TOO_LARGE_ERROR =
  'Those photos are too large together — remove one and try again.';

/** The leading picks that fit under `MAX_IMPORT_PHOTOS`, in order. */
export function fitImportPhotos<T>(
  currentCount: number,
  picked: readonly T[],
): { accepted: T[]; overflow: boolean } {
  const room = Math.max(0, MAX_IMPORT_PHOTOS - currentCount);
  const accepted = picked.slice(0, room);
  return { accepted, overflow: accepted.length < picked.length };
}

function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export function checkImportPhotoBytes(
  current: readonly EncodedImage[],
  next: EncodedImage,
): 'ok' | 'photo_too_large' | 'total_too_large' {
  if (decodedBytes(next.base64) > MAX_IMPORT_PHOTO_BYTES) return 'photo_too_large';
  const total = current.reduce((sum, image) => sum + image.base64.length, next.base64.length);
  if (total > MAX_IMPORT_PHOTOS_BASE64_CHARS) return 'total_too_large';
  return 'ok';
}

export async function importRecipe(params: {
  url?: string;
  text?: string;
  translateTo?: string;
  images?: EncodedImage[];
}): Promise<ImportRecipeResult> {
  const response = await fetch('/api/import', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  if (response.status === 401) {
    invalidateSession();
    throw new Error(t('error.sessionExpired'));
  }
  const data = (await response.json().catch(() => null)) as
    | {
        recipe?: ExtractedRecipe;
        translation?: { lang?: unknown; recipe?: ExtractedRecipe };
        translationFailed?: unknown;
        error?: string;
        code?: string;
        status?: number;
      }
    | null;
  if (!response.ok || !data?.recipe) {
    throw new Error(
      serverErrorText(data, 'error.importFailedStatus', { status: response.status }),
    );
  }

  const result: ImportRecipeResult = { recipe: drafted(data.recipe) };
  if (data.translationFailed === true) {
    result.translationFailed = true;
  }
  const translation = data.translation;
  if (
    translation !== undefined &&
    typeof translation.lang === 'string' &&
    translation.recipe !== undefined
  ) {
    result.translation = { lang: translation.lang, recipe: drafted(translation.recipe) };
  }
  return result;
}
