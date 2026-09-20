export type PushOp =
  | { kind: 'recipe.put'; payload: import('./types').Recipe }
  | { kind: 'recipe.delete'; payload: { id: string; updatedAt: number } }
  | { kind: 'chat.put'; payload: import('./types').ChatMessage }
  | { kind: 'chat.clearForRecipe'; payload: { recipeId: string; at: number } }
  | {
      kind: 'cookState.put';
      payload: import('./useCookState').CookStateRow & { updatedAt: number };
    }
  | { kind: 'photo.delete'; payload: { id: string; updatedAt: number } }
  | { kind: 'collection.put'; payload: import('./types').Collection }
  | { kind: 'collection.delete'; payload: { id: string; updatedAt: number } };

export const MAX_PUSH_OPS = 50;
