import type { ComponentType, ReactNode } from 'react';
import { t } from '../../i18n';
import type { AgentWireCard } from '../protocol';
import type { MoveApplyStatus } from '../store';
import CollectionMoveCard from './CollectionMoveCard';
import {
  parseCollectionMove,
  parseShoppingList,
  type CollectionMoveData,
  type ShoppingListData,
} from './parse';
import ShoppingListCard from './ShoppingListCard';

type CardComponentProps<T> = {
  data: T;
  cardId: string;
  checked: Record<string, true> | undefined;
  onToggle: (itemKey: string) => void;
  apply?: MoveApplyStatus;
};

type RegistryEntry<T> = {
  parse: (v: number, data: unknown) => T | undefined;
  Component: ComponentType<CardComponentProps<T>>;
};

function cardFallback(): ReactNode {
  return (
    <p className="mt-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink-muted">
      {t('assistant.cardUnavailable')}
    </p>
  );
}

const registry: {
  shopping_list: RegistryEntry<ShoppingListData>;
  collection_move: RegistryEntry<CollectionMoveData>;
} = {
  shopping_list: {
    parse: parseShoppingList,
    Component: ShoppingListCard,
  },
  collection_move: {
    parse: parseCollectionMove,
    Component: CollectionMoveCard,
  },
};

export function renderAgentCard(
  card: AgentWireCard,
  checked: Record<string, Record<string, true>>,
  onToggle: (cardId: string, itemKey: string) => void,
  applies: Record<string, MoveApplyStatus>,
): ReactNode {
  try {
    if (card.type === 'shopping_list') {
      const parsed = registry.shopping_list.parse(card.v, card.data);
      if (parsed === undefined) {
        return cardFallback();
      }
      const Component = registry.shopping_list.Component;
      return (
        <Component
          data={parsed}
          cardId={card.id}
          checked={checked[card.id]}
          onToggle={(itemKey) => onToggle(card.id, itemKey)}
        />
      );
    }
    if (card.type === 'collection_move') {
      const parsed = registry.collection_move.parse(card.v, card.data);
      if (parsed === undefined) {
        return cardFallback();
      }
      const Component = registry.collection_move.Component;
      return (
        <Component
          data={parsed}
          cardId={card.id}
          checked={checked[card.id]}
          onToggle={(itemKey) => onToggle(card.id, itemKey)}
          apply={applies[card.id]}
        />
      );
    }
    return cardFallback();
  } catch {
    return cardFallback();
  }
}
