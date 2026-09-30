import type { CardSpec } from '../../harness/types.ts';
import type { AgentLibrary } from '../library.ts';
import { shoppingListCard } from './shoppingList.ts';

export const CARD_SPECS: CardSpec<AgentLibrary, unknown>[] = [shoppingListCard];
