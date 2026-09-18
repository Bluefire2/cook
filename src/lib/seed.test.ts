import { describe, expect, it } from 'vitest';
import {
  SAMPLE_RECIPE_DESCRIPTION,
  SAMPLE_RECIPE_TITLE,
  isUnmodifiedSampleLibrary,
  shouldSeed,
} from './seed';

describe('shouldSeed', () => {
  it('seeds only a first launch with an empty library', () => {
    expect(shouldSeed(0, false)).toBe(true);
  });

  it('does not resurrect a sample after the user empties the library', () => {
    expect(shouldSeed(0, true)).toBe(false);
  });

  it('does not seed when recipes already exist', () => {
    expect(shouldSeed(1, false)).toBe(false);
    expect(shouldSeed(3, true)).toBe(false);
  });
});

const sampleRecipe = {
  title: SAMPLE_RECIPE_TITLE,
  description: SAMPLE_RECIPE_DESCRIPTION,
  createdAt: 1,
  updatedAt: 1,
};

describe('isUnmodifiedSampleLibrary', () => {
  it('is true for the untouched first-launch sample', () => {
    expect(
      isUnmodifiedSampleLibrary({
        recipes: [sampleRecipe],
        chatCount: 0,
        photoCount: 0,
        cookCount: 0,
      }),
    ).toBe(true);
  });

  it('is false once the sample is edited or other rows exist', () => {
    expect(
      isUnmodifiedSampleLibrary({
        recipes: [{ ...sampleRecipe, updatedAt: 2 }],
        chatCount: 0,
        photoCount: 0,
        cookCount: 0,
      }),
    ).toBe(false);
    expect(
      isUnmodifiedSampleLibrary({
        recipes: [{ ...sampleRecipe, title: 'My pasta' }],
        chatCount: 0,
        photoCount: 0,
        cookCount: 0,
      }),
    ).toBe(false);
    expect(
      isUnmodifiedSampleLibrary({
        recipes: [sampleRecipe, sampleRecipe],
        chatCount: 0,
        photoCount: 0,
        cookCount: 0,
      }),
    ).toBe(false);
    expect(
      isUnmodifiedSampleLibrary({
        recipes: [sampleRecipe],
        chatCount: 1,
        photoCount: 0,
        cookCount: 0,
      }),
    ).toBe(false);
    expect(
      isUnmodifiedSampleLibrary({
        recipes: [{ ...sampleRecipe, photoId: 'p' }],
        chatCount: 0,
        photoCount: 1,
        cookCount: 0,
      }),
    ).toBe(false);
  });
});
