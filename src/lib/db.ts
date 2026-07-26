import Dexie, { type Table } from 'dexie';
import type { ChatMessage, Photo, Recipe } from './types';

class CookDB extends Dexie {
  recipes!: Table<Recipe, string>;
  chatMessages!: Table<ChatMessage, string>;
  photos!: Table<Photo, string>;

  constructor() {
    super('cook');
    this.version(1).stores({
      // Only indexed fields are listed; the rest of each object is stored as-is.
      recipes: 'id, title, updatedAt, *tags',
      chatMessages: 'id, recipeId, createdAt',
      photos: 'id',
    });
  }
}

/**
 * Internal to the data-access layer. UI code must go through the stores
 * (recipeStore/chatStore/photoStore), never touch the db directly — this keeps
 * a future migration to server storage contained to the stores.
 */
export const db = new CookDB();
