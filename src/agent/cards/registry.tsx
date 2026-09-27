import type { ComponentType, ReactNode } from 'react';
import type { AgentWireCard } from '../protocol';
import { parseShoppingList, type ShoppingListData } from './parse';
import ShoppingListCard from './ShoppingListCard';

type CardComponentProps<T> = {
  data: T;
  cardId: string;
  checked: Record<string, true> | undefined;
  onToggle: (itemKey: string) => void;
};

type RegistryEntry<T> = {
  parse: (v: number, data: unknown) => T | undefined;
  Component: ComponentType<CardComponentProps<T>>;
};

const fallback = (
  <p className="mt-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink-muted">
    Update the app to see this card.
  </p>
);

const registry: {
  shopping_list: RegistryEntry<ShoppingListData>;
} = {
  shopping_list: {
    parse: parseShoppingList,
    Component: ShoppingListCard,
  },
};

export function renderAgentCard(
  card: AgentWireCard,
  checked: Record<string, Record<string, true>>,
  onToggle: (cardId: string, itemKey: string) => void,
): ReactNode {
  try {
    const entry = registry[card.type as keyof typeof registry];
    if (!entry) {
      return fallback;
    }
    const parsed = entry.parse(card.v, card.data);
    if (parsed === undefined) {
      return fallback;
    }
    const Component = entry.Component;
    return (
      <Component
        data={parsed}
        cardId={card.id}
        checked={checked[card.id]}
        onToggle={(itemKey) => onToggle(card.id, itemKey)}
      />
    );
  } catch {
    return fallback;
  }
}
