import Dexie, { type Table } from 'dexie';
import type { ChatMessage, Photo, Recipe } from './types';
import type { CookStateRow } from './useCookState';

class CookDB extends Dexie {
  recipes!: Table<Recipe, string>;
  chatMessages!: Table<ChatMessage, string>;
  photos!: Table<Photo, string>;
  cookState!: Table<CookStateRow, string>;

  constructor() {
    super('cook');
    this.version(1).stores({
      // Only indexed fields are listed; the rest of each object is stored as-is.
      recipes: 'id, title, updatedAt, *tags',
      chatMessages: 'id, recipeId, createdAt',
      photos: 'id',
    });
    // Dexie carries the v1 tables forward, so only the addition is declared.
    this.version(2).stores({
      cookState: 'recipeId',
    });
  }
}

/**
 * Internal to the data-access layer. UI code must go through the stores
 * (recipeStore/chatStore/photoStore), never touch the db directly — this keeps
 * a future migration to server storage contained to the stores.
 */
export const db = new CookDB();
