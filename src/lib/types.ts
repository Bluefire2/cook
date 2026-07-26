export interface Ingredient {
  quantity?: number;
  unit?: string;
  item: string;
  note?: string;
}

export interface IngredientSection {
  /** Optional section name like "Sauce" or "Dough"; omitted for single-section recipes. */
  name?: string;
  items: Ingredient[];
}

export interface RecipeStep {
  text: string;
}

export interface Recipe {
  id: string;
  title: string;
  description?: string;
  sourceUrl?: string;
  servings: number;
  prepMinutes?: number;
  cookMinutes?: number;
  ingredientSections: IngredientSection[];
  steps: RecipeStep[];
  tags: string[];
  notes?: string;
  /** FK into the photos table. */
  photoId?: string;
  createdAt: number;
  updatedAt: number;
}

/** A recipe as produced by extraction/modification, before it gets identity. */
export type RecipeDraft = Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>;

export interface ChatMessage {
  id: string;
  recipeId: string;
  role: 'user' | 'assistant';
  content: string;
  /** FKs into the photos table for attached images. */
  photoIds?: string[];
  /** Set when the assistant proposed a recipe modification via update_recipe. */
  proposedRecipe?: RecipeDraft;
  createdAt: number;
}

export interface Photo {
  id: string;
  blob: Blob;
  createdAt: number;
}
