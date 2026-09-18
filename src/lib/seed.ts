import { db } from './db';
import { OWNER_UID_KEY } from './cacheOwner';
import { recipeStore } from './recipeStore';
import type { Recipe } from './types';

const SEEDED_KEY = 'cook.hasSeeded';
const SESSION_CACHE_KEY = 'cook.session';

export const SAMPLE_RECIPE_TITLE = 'Spaghetti al Pomodoro';
export const SAMPLE_RECIPE_DESCRIPTION =
  'A simple, bright tomato pasta — the test recipe that ships with the app.';

/**
 * First launch only. A user who deletes their last recipe must be able to
 * keep an empty library — `count === 0` is not the same as "never launched."
 */
export function shouldSeed(
  recipeCount: number,
  alreadySeeded: boolean,
): boolean {
  return recipeCount === 0 && !alreadySeeded;
}

/**
 * True when the only local rows are the first-launch sample, never edited.
 * A second device that opened the app unsigned-in always has this shape, and
 * treating it as `needsMigration` blocks pull behind an export sheet for a
 * recipe that must not be pushed into the account.
 */
export function isUnmodifiedSampleLibrary(input: {
  recipes: Pick<
    Recipe,
    'title' | 'description' | 'createdAt' | 'updatedAt' | 'photoId'
  >[];
  chatCount: number;
  photoCount: number;
  cookCount: number;
}): boolean {
  if (input.chatCount !== 0 || input.cookCount !== 0 || input.photoCount !== 0) {
    return false;
  }
  if (input.recipes.length !== 1) {
    return false;
  }
  const recipe = input.recipes[0];
  return (
    recipe.title === SAMPLE_RECIPE_TITLE &&
    recipe.description === SAMPLE_RECIPE_DESCRIPTION &&
    recipe.createdAt === recipe.updatedAt &&
    recipe.photoId === undefined
  );
}

function hasSeeded(): boolean {
  return localStorage.getItem(SEEDED_KEY) !== null;
}

function markSeeded(): void {
  localStorage.setItem(SEEDED_KEY, '1');
}

function hasSessionOrOwner(): boolean {
  if (localStorage.getItem(OWNER_UID_KEY)) {
    return true;
  }
  return localStorage.getItem(SESSION_CACHE_KEY) !== null;
}

/** Adds a sample recipe on first launch so the app never starts empty. */
export async function seedIfEmpty(): Promise<void> {
  if (hasSessionOrOwner()) {
    markSeeded();
    return;
  }

  const count = await db.recipes.count();
  if (count > 0) {
    markSeeded();
    return;
  }
  if (!shouldSeed(count, hasSeeded())) return;

  await recipeStore.create({
    title: SAMPLE_RECIPE_TITLE,
    description: SAMPLE_RECIPE_DESCRIPTION,
    servings: 2,
    prepMinutes: 10,
    cookMinutes: 25,
    ingredientSections: [
      {
        items: [
          { quantity: 200, unit: 'g', item: 'spaghetti' },
          { quantity: 400, unit: 'g', item: 'canned whole tomatoes', note: 'San Marzano if possible' },
          { quantity: 3, unit: 'tbsp', item: 'olive oil' },
          { quantity: 2, item: 'garlic cloves', note: 'thinly sliced' },
          { quantity: 0.25, unit: 'tsp', item: 'red pepper flakes', note: 'optional' },
          { item: 'fresh basil', note: 'a handful of leaves' },
          { item: 'salt' },
          { item: 'parmesan', note: 'for serving' },
        ],
      },
    ],
    steps: [
      { text: 'Bring a large pot of generously salted water to a boil.' },
      { text: 'Warm the olive oil in a wide pan over medium heat. Add the garlic and pepper flakes and cook until the garlic is fragrant and just golden, about 1 minute.' },
      { text: 'Crush the tomatoes into the pan with your hands, add a pinch of salt, and simmer until thickened, 15–20 minutes.' },
      { text: 'Meanwhile, cook the spaghetti until 1–2 minutes shy of al dente. Reserve a cup of pasta water before draining.' },
      { text: 'Transfer the pasta into the sauce with a splash of pasta water. Toss over medium heat until the sauce clings, 1–2 minutes, loosening with more pasta water as needed.' },
      { text: 'Off heat, tear in the basil. Serve with grated parmesan.' },
    ],
    tags: ['pasta', 'italian', 'weeknight'],
  });
  markSeeded();
}
