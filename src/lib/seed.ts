import { db } from './db';
import { recipeStore } from './recipeStore';

/** Adds a sample recipe on first launch so the app never starts empty. */
export async function seedIfEmpty(): Promise<void> {
  const count = await db.recipes.count();
  if (count > 0) return;

  await recipeStore.create({
    title: 'Spaghetti al Pomodoro',
    description:
      'A simple, bright tomato pasta — the test recipe that ships with the app.',
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
}
