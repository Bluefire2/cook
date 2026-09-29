import { describe, expect, it } from 'vitest';
import {
  assertPhotoId,
  isAllowedPhotoContentType,
  isPhotoByteCountTooLarge,
  isPhotoContentLengthTooLarge,
  MAX_PHOTO_BYTES,
  photoUploadDecision,
  photoUploadStopsAtLiveReplay,
  planUploadIntent,
} from './photos.ts';

describe('assertPhotoId', () => {
  it('rejects non-uuid paths', () => {
    expect(assertPhotoId('not-a-uuid')).toBe(false);
    expect(assertPhotoId('../escape')).toBe(false);
    expect(assertPhotoId('')).toBe(false);
  });

  it('accepts uuid', () => {
    expect(assertPhotoId('11111111-1111-4111-8111-111111111111')).toBe(true);
  });
});

describe('photoUploadDecision', () => {
  it('allows idempotent replay on live docs at equal timestamp', () => {
    expect(photoUploadDecision({ updatedAt: 5 }, 5)).toEqual({
      allow: true,
      undeleting: false,
    });
  });

  it('tombstone wins against put at equal timestamp', () => {
    expect(photoUploadDecision({ updatedAt: 5, deletedAt: 5 }, 5)).toEqual({
      allow: false,
      reason: 'already-deleted',
    });
  });
});

describe('photoUploadStopsAtLiveReplay', () => {
  it('stops intent for live photos regardless of client timestamp', () => {
    expect(
      photoUploadStopsAtLiveReplay({
        status: 'live',
        updatedAt: 100,
        recipeId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toBe(true);
  });

  it('does not stop for uploading or missing metadata', () => {
    expect(photoUploadStopsAtLiveReplay(undefined)).toBe(false);
    expect(
      photoUploadStopsAtLiveReplay({ status: 'uploading', updatedAt: 1 }),
    ).toBe(false);
    expect(
      photoUploadStopsAtLiveReplay({ status: 'live', updatedAt: 1, deletedAt: 1 }),
    ).toBe(false);
  });
});

describe('isAllowedPhotoContentType', () => {
  it('allows jpeg and png', () => {
    expect(isAllowedPhotoContentType('image/jpeg')).toBe(true);
    expect(isAllowedPhotoContentType('image/png')).toBe(true);
    expect(isAllowedPhotoContentType('image/jpeg; charset=binary')).toBe(true);
  });

  it('rejects other types', () => {
    expect(isAllowedPhotoContentType('image/webp')).toBe(false);
    expect(isAllowedPhotoContentType('application/octet-stream')).toBe(false);
  });
});

describe('photo body size predicates', () => {
  it('flags content-length over 2 MB before upload', () => {
    expect(isPhotoContentLengthTooLarge(null)).toBe(false);
    expect(isPhotoContentLengthTooLarge(MAX_PHOTO_BYTES)).toBe(false);
    expect(isPhotoContentLengthTooLarge(MAX_PHOTO_BYTES + 1)).toBe(true);
  });

  it('flags streamed byte counts over 2 MB', () => {
    expect(isPhotoByteCountTooLarge(MAX_PHOTO_BYTES)).toBe(false);
    expect(isPhotoByteCountTooLarge(MAX_PHOTO_BYTES + 1)).toBe(true);
  });
});

describe('planUploadIntent', () => {
  const RECIPE = '11111111-1111-4111-8111-111111111111';

  it('accepts a revived id after its tombstone and drops the queued object delete', () => {
    expect(planUploadIntent(true, { id: 'p', updatedAt: 10, deletedAt: 10 }, 11)).toEqual({
      kind: 'proceed',
      clearQueuedGcsDelete: true,
    });
  });

  it('accepts a new id and a retried uploading id', () => {
    expect(planUploadIntent(true, undefined, 1)).toEqual({
      kind: 'proceed',
      clearQueuedGcsDelete: true,
    });
    expect(planUploadIntent(true, { status: 'uploading', updatedAt: 5 }, 5)).toEqual({
      kind: 'proceed',
      clearQueuedGcsDelete: true,
    });
  });

  it('leaves the queue alone when the upload is not accepted', () => {
    expect(planUploadIntent(false, undefined, 1)).toEqual({
      kind: 'conflict',
      error: 'recipe-deleted',
    });
    expect(planUploadIntent(true, { updatedAt: 10, deletedAt: 10 }, 10)).toEqual({
      kind: 'conflict',
      error: 'already-deleted',
    });
    expect(planUploadIntent(true, { status: 'uploading', updatedAt: 10 }, 9)).toEqual({
      kind: 'conflict',
      error: 'stale',
    });
    expect(
      planUploadIntent(true, { status: 'live', updatedAt: 10, recipeId: RECIPE }, 1),
    ).toEqual({ kind: 'stop' });
  });
});
