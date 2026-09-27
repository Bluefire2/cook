import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMPORT_JPEG_QUALITY, IMPORT_MAX_EDGE_PX } from './image';
import {
  checkImportPhotoBytes,
  fitImportPhotos,
  IMPORT_PHOTO_LIMIT_ERROR,
  importRecipe,
  MAX_IMPORT_PHOTO_BYTES,
  MAX_IMPORT_PHOTOS,
  MAX_IMPORT_PHOTOS_BASE64_CHARS,
} from './importApi';
import * as session from './session';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof respond>): unknown {
  return JSON.parse(String(fetchMock.mock.calls[0][1].body));
}

/** Base64 of `bytes` decoded bytes, with the padding real base64 would have. */
function base64Of(bytes: number): string {
  const tail = ['', 'AA==', 'AAA='][bytes % 3];
  return 'A'.repeat(Math.floor(bytes / 3) * 4) + tail;
}

const photo = (base64: string) => ({ mediaType: 'image/jpeg', base64 });

describe('importRecipe', () => {
  it('posts photos and notes as JSON', async () => {
    const fetchMock = respond(200, { recipe: { title: 'Pie', servings: 1 } });
    const images = [{ mediaType: 'image/jpeg', base64: 'AAAA' }];
    const recipe = await importRecipe({ images, text: 'notes' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/import');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(sentBody(fetchMock)).toEqual({ images, text: 'notes' });
    expect(recipe).toEqual({
      title: 'Pie',
      servings: 1,
      tags: [],
      ingredientSections: [],
      steps: [],
    });
  });

  it('sends no images key for text import', async () => {
    const fetchMock = respond(200, { recipe: { title: 'Soup', servings: 1 } });
    await importRecipe({ text: 'soup' });
    expect('images' in (sentBody(fetchMock) as object)).toBe(false);
  });

  it("surfaces the server's photo error", async () => {
    const invalidateSpy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(413, { error: 'Those photos are too large.' });
    await expect(importRecipe({ images: [photo('AAAA')] })).rejects.toThrow(
      'Those photos are too large.',
    );
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('invalidates the session on 401', async () => {
    const invalidateSpy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(401, { error: 'Unauthorized' });
    await expect(importRecipe({ images: [photo('AAAA')] })).rejects.toThrow(
      'Please sign in again — your session expired.',
    );
    expect(invalidateSpy).toHaveBeenCalled();
  });
});

describe('checkImportPhotoBytes', () => {
  it('caps one photo at 3 MB decoded', () => {
    expect(MAX_IMPORT_PHOTO_BYTES).toBe(3 * 1024 * 1024);
    expect(checkImportPhotoBytes([], photo(base64Of(MAX_IMPORT_PHOTO_BYTES)))).toBe('ok');
    expect(checkImportPhotoBytes([], photo(base64Of(MAX_IMPORT_PHOTO_BYTES + 1)))).toBe(
      'photo_too_large',
    );
  });

  it('caps the photos together below the request body cap', () => {
    expect(MAX_IMPORT_PHOTOS_BASE64_CHARS).toBeLessThan(12 * 1024 * 1024);
    const current = [photo('A'.repeat(MAX_IMPORT_PHOTOS_BASE64_CHARS - 4))];
    expect(checkImportPhotoBytes(current, photo('AAAA'))).toBe('ok');
    expect(checkImportPhotoBytes(current, photo('AAAAAAAA'))).toBe('total_too_large');
  });

  it('reports an oversized photo as too large on its own', () => {
    const huge = photo('A'.repeat(MAX_IMPORT_PHOTOS_BASE64_CHARS + 4));
    expect(checkImportPhotoBytes([], huge)).toBe('photo_too_large');
  });
});

describe('fitImportPhotos', () => {
  it('keeps the leading picks that fit under the cap', () => {
    expect(fitImportPhotos(0, ['a', 'b'])).toEqual({ accepted: ['a', 'b'], overflow: false });
    expect(fitImportPhotos(3, ['d', 'e'])).toEqual({ accepted: ['d'], overflow: true });
    expect(fitImportPhotos(4, ['e'])).toEqual({ accepted: [], overflow: true });
    expect(fitImportPhotos(0, ['a', 'b', 'c', 'd', 'e'])).toEqual({
      accepted: ['a', 'b', 'c', 'd'],
      overflow: true,
    });
    expect(fitImportPhotos(1, [])).toEqual({ accepted: [], overflow: false });
  });
});

describe('import photo limits', () => {
  it('locks the constitution numbers', () => {
    expect(MAX_IMPORT_PHOTOS).toBe(4);
    expect(IMPORT_MAX_EDGE_PX).toBe(2048);
    expect(IMPORT_JPEG_QUALITY).toBe(0.85);
    expect(IMPORT_PHOTO_LIMIT_ERROR).toBe('Up to 4 photos.');
  });
});
