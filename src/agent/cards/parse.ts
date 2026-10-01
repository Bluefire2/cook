export type CollectionMoveData = {
  destination:
    | { kind: 'collection'; id: string; name: string }
    | { kind: 'unfiled' };
  recipeIds: string[];
  preview: {
    id: string;
    title: string;
    from: { kind: 'collection'; name: string } | { kind: 'unfiled' };
  }[];
  total: number;
};

export type ShoppingListData = {
  title: string;
  recipes: { id: string; title: string; servings: number }[];
  sections: {
    name: string;
    items: {
      key: string;
      item: string;
      quantity?: number;
      unit?: string;
      note?: string;
      recipeIds: string[];
    }[];
  }[];
};

const KEY_PATTERN = /^[a-z0-9_-]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function parseShoppingList(v: number, data: unknown): ShoppingListData | undefined {
  if (v !== 1 || !isPlainObject(data)) {
    return undefined;
  }
  const titleRaw = data.title;
  if (typeof titleRaw !== 'string' || titleRaw.trim() === '') {
    return undefined;
  }
  const title = titleRaw.trim();
  if (title.length > 120) {
    return undefined;
  }

  const recipesRaw = data.recipes;
  if (!Array.isArray(recipesRaw) || recipesRaw.length < 1 || recipesRaw.length > 12) {
    return undefined;
  }
  const recipes: ShoppingListData['recipes'] = [];
  const recipeIds = new Set<string>();
  for (const entry of recipesRaw) {
    if (!isPlainObject(entry)) {
      return undefined;
    }
    const id = entry.id;
    if (typeof id !== 'string' || id === '') {
      return undefined;
    }
    const recipeTitle = entry.title;
    if (typeof recipeTitle !== 'string' || recipeTitle.trim() === '') {
      return undefined;
    }
    const servings = entry.servings;
    if (typeof servings !== 'number' || !Number.isFinite(servings) || servings <= 0) {
      return undefined;
    }
    recipes.push({ id, title: recipeTitle.trim(), servings });
    recipeIds.add(id);
  }

  const sectionsRaw = data.sections;
  if (!Array.isArray(sectionsRaw) || sectionsRaw.length < 1 || sectionsRaw.length > 12) {
    return undefined;
  }
  const sections: ShoppingListData['sections'] = [];
  const seenKeys = new Set<string>();
  let itemCount = 0;
  for (const sectionEntry of sectionsRaw) {
    if (!isPlainObject(sectionEntry)) {
      return undefined;
    }
    const name =
      typeof sectionEntry.name === 'string' && sectionEntry.name.trim() !== ''
        ? sectionEntry.name.trim()
        : '';
    if (name === '') {
      return undefined;
    }
    const itemsRaw = sectionEntry.items;
    if (!Array.isArray(itemsRaw)) {
      return undefined;
    }
    const items: ShoppingListData['sections'][number]['items'] = [];
    for (const itemEntry of itemsRaw) {
      if (!isPlainObject(itemEntry)) {
        return undefined;
      }
      itemCount += 1;
      if (itemCount > 150) {
        return undefined;
      }
      const key = itemEntry.key;
      if (typeof key !== 'string' || key === '' || key.length > 80 || !KEY_PATTERN.test(key)) {
        return undefined;
      }
      if (seenKeys.has(key)) {
        return undefined;
      }
      seenKeys.add(key);
      const itemText = itemEntry.item;
      if (typeof itemText !== 'string' || itemText.trim() === '') {
        return undefined;
      }
      const item = itemText.trim();
      if (item.length > 200) {
        return undefined;
      }
      const normalized: ShoppingListData['sections'][number]['items'][number] = {
        key,
        item,
        recipeIds: [],
      };
      if (itemEntry.quantity !== undefined) {
        if (
          typeof itemEntry.quantity !== 'number' ||
          !Number.isFinite(itemEntry.quantity) ||
          itemEntry.quantity < 0
        ) {
          return undefined;
        }
        normalized.quantity = itemEntry.quantity;
      }
      if (itemEntry.unit !== undefined) {
        if (typeof itemEntry.unit !== 'string' || itemEntry.unit.length > 40) {
          return undefined;
        }
        normalized.unit = itemEntry.unit;
      }
      if (itemEntry.note !== undefined) {
        if (typeof itemEntry.note !== 'string' || itemEntry.note.length > 200) {
          return undefined;
        }
        normalized.note = itemEntry.note;
      }
      const recipeIdsRaw = itemEntry.recipeIds;
      if (!Array.isArray(recipeIdsRaw)) {
        return undefined;
      }
      for (const rid of recipeIdsRaw) {
        if (typeof rid !== 'string' || !recipeIds.has(rid)) {
          return undefined;
        }
        normalized.recipeIds.push(rid);
      }
      items.push(normalized);
    }
    sections.push({ name, items });
  }

  return { title, recipes, sections };
}

function parseMoveFrom(
  value: unknown,
): CollectionMoveData['preview'][number]['from'] | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const kind = value.kind;
  if (kind === 'unfiled') {
    return { kind: 'unfiled' };
  }
  if (kind === 'collection') {
    const name = value.name;
    if (typeof name !== 'string' || name.trim() === '') {
      return undefined;
    }
    return { kind: 'collection', name: name.trim() };
  }
  return undefined;
}

function parseMoveDestination(
  value: unknown,
): CollectionMoveData['destination'] | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const kind = value.kind;
  if (kind === 'unfiled') {
    return { kind: 'unfiled' };
  }
  if (kind === 'collection') {
    const id = value.id;
    const name = value.name;
    if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name.trim() === '') {
      return undefined;
    }
    return { kind: 'collection', id, name: name.trim() };
  }
  return undefined;
}

export function parseCollectionMove(v: number, data: unknown): CollectionMoveData | undefined {
  if (v !== 1 || !isPlainObject(data)) {
    return undefined;
  }

  const destination = parseMoveDestination(data.destination);
  if (destination === undefined) {
    return undefined;
  }

  const recipeIdsRaw = data.recipeIds;
  if (!Array.isArray(recipeIdsRaw) || recipeIdsRaw.length < 1 || recipeIdsRaw.length > 500) {
    return undefined;
  }
  const recipeIds: string[] = [];
  for (const id of recipeIdsRaw) {
    if (typeof id !== 'string' || id === '') {
      return undefined;
    }
    recipeIds.push(id);
  }

  const total = data.total;
  if (typeof total !== 'number' || !Number.isFinite(total) || total !== recipeIds.length) {
    return undefined;
  }

  const previewRaw = data.preview;
  if (!Array.isArray(previewRaw) || previewRaw.length > 8) {
    return undefined;
  }
  const preview: CollectionMoveData['preview'] = [];
  for (const row of previewRaw) {
    if (!isPlainObject(row)) {
      return undefined;
    }
    const id = row.id;
    if (typeof id !== 'string' || id === '') {
      return undefined;
    }
    const title = row.title;
    if (typeof title !== 'string' || title.trim() === '') {
      return undefined;
    }
    const trimmedTitle = title.trim();
    if (trimmedTitle.length > 120) {
      return undefined;
    }
    const from = parseMoveFrom(row.from);
    if (from === undefined) {
      return undefined;
    }
    preview.push({ id, title: trimmedTitle, from });
  }

  return { destination, recipeIds, preview, total };
}
