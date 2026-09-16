import type { Transaction } from 'dexie';
import type { Recipe, ChatMessage } from './types';
import type { CookStateRow } from './useCookState';
import { db } from './db';

export type OutboxOp =
  | { kind: 'recipe.put'; payload: Recipe }
  | { kind: 'recipe.delete'; payload: { id: string; updatedAt: number } }
  | { kind: 'chat.put'; payload: ChatMessage }
  | {
      kind: 'chat.clearForRecipe';
      payload: { recipeId: string; at: number };
    }
  | {
      kind: 'cookState.put';
      payload: CookStateRow & { updatedAt: number };
    }
  | {
      kind: 'photo.put';
      payload: { id: string; recipeId: string; updatedAt: number };
    }
  | { kind: 'photo.delete'; payload: { id: string; updatedAt: number } };

export interface OutboxRow {
  seq?: number;
  kind: OutboxOp['kind'];
  payload: OutboxOp['payload'];
  enqueuedAt: number;
  attempts: number;
}

export async function enqueue(tx: Transaction, op: OutboxOp): Promise<void> {
  await tx.table('outbox').add({
    kind: op.kind,
    payload: op.payload,
    enqueuedAt: Date.now(),
    attempts: 0,
  });
}

export async function pendingOutboxCount(): Promise<number> {
  return db.outbox.count();
}
