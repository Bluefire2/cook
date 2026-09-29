import { describe, expect, it } from 'vitest';
import {
  MAX_GALLERY_PHOTOS,
  compactGalleryPhotoIds,
  recipePhotoIds,
  remapPhotoIds,
} from './recipePhotos';

describe('compactGalleryPhotoIds', () => {
  it('returns undefined for missing or empty lists', () => {
    expect(compactGalleryPhotoIds(undefined, undefined)).toBeUndefined();
    expect(compactGalleryPhotoIds([], 'cover')).toBeUndefined();
  });

  it('drops the cover id, blanks, and duplicates while keeping order', () => {
    expect(
      compactGalleryPhotoIds(['a', '', 'cover', 'b', 'a', 'c'], 'cover'),
    ).toEqual(['a', 'b', 'c']);
  });

  it('caps at MAX_GALLERY_PHOTOS', () => {
    const ids = Array.from({ length: MAX_GALLERY_PHOTOS + 3 }, (_, i) => `p${i}`);
    expect(compactGalleryPhotoIds(ids, undefined)).toEqual(
      ids.slice(0, MAX_GALLERY_PHOTOS),
    );
  });
});

describe('recipePhotoIds', () => {
  it('lists cover then gallery without repeating the cover', () => {
    expect(
      recipePhotoIds({
        photoId: 'cover',
        galleryPhotoIds: ['a', 'cover', 'b'],
      }),
    ).toEqual(['cover', 'a', 'b']);
  });
});

describe('remapPhotoIds', () => {
  it('replaces mapped cover and gallery ids and keeps the rest', () => {
    const remap = new Map([
      ['a', 'a2'],
      ['c', 'c2'],
    ]);
    expect(
      remapPhotoIds({ title: 'Soup', photoId: 'a', galleryPhotoIds: ['b', 'c'] }, remap),
    ).toEqual({ title: 'Soup', photoId: 'a2', galleryPhotoIds: ['b', 'c2'] });
  });

  it('returns the same draft for an empty remap', () => {
    const draft = { photoId: 'a' };
    expect(remapPhotoIds(draft, new Map())).toBe(draft);
  });
});
