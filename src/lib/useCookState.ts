import { useCallback, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import type { Recipe } from './types';

export interface CookState {
  servings: number;
  currentStep: number;
  checkedKeys: ReadonlySet<string>;
}

export interface CookStateApi extends CookState {
  setServings: (n: number) => void;
  setCurrentStep: (i: number) => void;
  toggleChecked: (key: string) => void;
  /** Ingredient item names for the checked keys, skipping stale ones. */
  checkedItemNames: (recipe: Recipe) => string[];
}

/** One row per recipe. `Set` is not a valid IndexedDB value, hence `string[]`. */
export interface CookStateRow {
  recipeId: string;
  servings: number;
  currentStep: number;
  checkedKeys: string[];
  /** The `updatedAt` this progress was recorded against. */
  recipeUpdatedAt: number;
}

type Progress = Omit<CookStateRow, 'recipeId' | 'recipeUpdatedAt'>;

/** Shared so the memo below keeps a stable `Set` identity across renders. */
const NO_KEYS: string[] = [];

/**
 * Positional keys and a step index only mean something against the recipe they
 * were recorded against, so a shape change discards them rather than trying to
 * remap. Servings survives: it is the user's choice of how much food to make.
 */
function progressFor(
  row: CookStateRow | undefined,
  recipe: Recipe | null | undefined,
): Progress {
  const servings = row?.servings ?? recipe?.servings ?? 1;
  if (!row || !recipe || row.recipeUpdatedAt !== recipe.updatedAt) {
    return { servings, currentStep: 0, checkedKeys: NO_KEYS };
  }
  return {
    servings,
    currentStep: row.currentStep,
    checkedKeys: row.checkedKeys,
  };
}

const cookStateStore = {
  get(recipeId: string): Promise<CookStateRow | undefined> {
    return db.cookState.get(recipeId);
  },

  /**
   * Read-modify-write in one transaction so two taps in quick succession
   * cannot both build on the same pre-tap row.
   */
  async update(
    recipe: Recipe,
    change: (prev: Progress) => Progress,
  ): Promise<void> {
    await db.transaction('rw', db.cookState, async () => {
      const prev = progressFor(await db.cookState.get(recipe.id), recipe);
      await db.cookState.put({
        ...change(prev),
        recipeId: recipe.id,
        recipeUpdatedAt: recipe.updatedAt,
      });
    });
  },
};

/** Persisted per recipe. Resets when the recipe's shape changes. */
export function useCookState(recipe: Recipe | null | undefined): CookStateApi {
  const recipeId = recipe?.id;
  const row = useLiveQuery(
    () => (recipeId ? cookStateStore.get(recipeId) : undefined),
    [recipeId],
  );

  const { servings, currentStep, checkedKeys } = progressFor(row, recipe);
  const checkedSet = useMemo(() => new Set(checkedKeys), [checkedKeys]);

  const setServings = useCallback(
    (n: number) => {
      if (!recipe) return;
      void cookStateStore.update(recipe, (prev) => ({ ...prev, servings: n }));
    },
    [recipe],
  );

  const setCurrentStep = useCallback(
    (i: number) => {
      if (!recipe) return;
      void cookStateStore.update(recipe, (prev) => ({
        ...prev,
        currentStep: i,
      }));
    },
    [recipe],
  );

  const toggleChecked = useCallback(
    (key: string) => {
      if (!recipe) return;
      void cookStateStore.update(recipe, (prev) => ({
        ...prev,
        checkedKeys: prev.checkedKeys.includes(key)
          ? prev.checkedKeys.filter((k) => k !== key)
          : [...prev.checkedKeys, key],
      }));
    },
    [recipe],
  );

  const checkedItemNames = useCallback(
    (forRecipe: Recipe) =>
      [...checkedSet]
        .map((key) => {
          const [si, ii] = key.split('-').map(Number);
          return forRecipe.ingredientSections[si]?.items[ii]?.item;
        })
        .filter((item): item is string => item !== undefined),
    [checkedSet],
  );

  return {
    servings,
    currentStep,
    checkedKeys: checkedSet,
    setServings,
    setCurrentStep,
    toggleChecked,
    checkedItemNames,
  };
}
