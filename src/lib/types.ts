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

export interface ChatMessage {
  id: string;
  recipeId: string;
  role: 'user' | 'assistant';
  content: string;
  /** FKs into the photos table for attached images. */
  photoIds?: string[];
  createdAt: number;
}

export interface Photo {
  id: string;
  blob: Blob;
  createdAt: number;
}
