import { describe, expect, it } from 'vitest';
import { buildAgentLibrary, type AgentCollection, type AgentRecipe } from '../agent/sous/library.ts';
import { ownRecipeUpdateDecision, recipeDocBody, type OwnRecipeUpdateResult } from '../store.ts';
import { SCOPE_READ, SCOPE_WRITE } from './config.ts';
import {
  callToolResult,
  MCP_TOOLS,
  mcpToolByName,
  toolListing,
  UNTRUSTED_TEXT_NOTICE,
  type McpToolContext,
  type McpToolOutcome,
} from './tools.ts';

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const PHOTO = '44444444-4444-4444-8444-444444444444';

function recipe(overrides: Partial<AgentRecipe> & { id: string; title: string }): AgentRecipe {
  return {
    servings: 4,
    ingredientSections: [{ items: [{ item: 'leeks' }] }],
    steps: [{ text: 'Cook.' }],
    tags: [],
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

/** A fake store over plain docs, so the update path runs the real decision and merge. */
function fakeContext(
  recipes: AgentRecipe[],
  collections: AgentCollection[] = [],
  opts: { loadCap?: number } = {},
): McpToolContext & { docs: Map<string, Record<string, unknown>>; created: string[]; directReads: string[][] } {
  const docs = new Map<string, Record<string, unknown>>(recipes.map((r) => [r.id, { ...r }]));
  const created: string[] = [];
  const directReads: string[][] = [];
  const loaded = opts.loadCap === undefined ? recipes : recipes.slice(0, opts.loadCap);
  return {
    docs,
    created,
    directReads,
    async loadLibrary() {
      return buildAgentLibrary(loaded, collections, {
        truncated: loaded.length < recipes.length,
        maxIndexEntries: 500,
        maxIndexChars: 40_000,
      });
    },
    async readRecipes(ids) {
      directReads.push([...ids]);
      return ids.map((id) => recipes.find((r) => r.id === id));
    },
    async createRecipe(id, payload) {
      docs.set(id, payload);
      created.push(id);
      return true;
    },
    async updateRecipe(id, expectedVersion, apply): Promise<OwnRecipeUpdateResult> {
      const decision = ownRecipeUpdateDecision(docs.get(id), expectedVersion);
      if (decision.kind !== 'ok') return decision;
      const payload = apply(decision.stored, 500);
      if (payload === null) return { kind: 'too_large' };
      const doc = recipeDocBody(payload, id, 500, 501);
      docs.set(id, doc);
      return { kind: 'ok', doc };
    },
    newId: () => NEW_ID,
    now: () => 400,
  };
}

async function run(name: string, args: unknown, ctx: McpToolContext): Promise<McpToolOutcome> {
  const tool = mcpToolByName(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args, ctx);
}

describe('tool specs', () => {
  it('are the five planned tools, with scopes, annotations and the untrusted-text notice', () => {
    expect(MCP_TOOLS.map((t) => [t.name, t.scope, t.annotations.readOnlyHint])).toEqual([
      ['search_recipes', SCOPE_READ, true],
      ['get_recipes', SCOPE_READ, true],
      ['list_collections', SCOPE_READ, true],
      ['create_recipe', SCOPE_WRITE, false],
      ['update_recipe', SCOPE_WRITE, false],
    ]);
    for (const tool of MCP_TOOLS) {
      expect(tool.description).toContain(UNTRUSTED_TEXT_NOTICE);
      expect(tool.annotations.openWorldHint).toBe(false);
      expect(tool.annotations.destructiveHint ?? false).toBe(false);
      expect(tool.inputSchema.type).toBe('object');
      expect(toolListing(tool)).not.toHaveProperty('scope');
    }
  });
});

describe('search_recipes', () => {
  const recipes = Array.from({ length: 12 }, (_, i) =>
    recipe({ id: `r${String(i).padStart(2, '0')}`, title: `Dish ${String(i).padStart(2, '0')}` }),
  );

  it('pages with total and nextOffset', async () => {
    const ctx = fakeContext(recipes);
    const first = await run('search_recipes', { limit: 5 }, ctx);
    expect(first.ok && first.data.total).toBe(12);
    expect(first.ok && first.data.nextOffset).toBe(5);
    const last = await run('search_recipes', { limit: 5, offset: 10 }, ctx);
    expect(last.ok && (last.data.hits as unknown[]).length).toBe(2);
    expect(last.ok && 'nextOffset' in last.data).toBe(false);
  });

  it('rejects bad arguments with paths', async () => {
    const out = await run('search_recipes', { limit: 50, offset: -1, tags: 'soup', mood: 'x' }, fakeContext(recipes));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('invalid');
    expect((out.data?.errors as { path: string }[]).map((e) => e.path)).toEqual(['mood', 'tags', 'limit', 'offset']);
  });
});

describe('get_recipes', () => {
  it('returns version and missingIds, and never photo ids or createdAt', async () => {
    const ctx = fakeContext(
      [recipe({ id: R1, title: 'Soup', updatedAt: 77, photoId: PHOTO, galleryPhotoIds: [PHOTO] })],
      [{ id: 'c1', name: 'Weeknight', recipeIds: [R1] }],
    );
    const out = await run('get_recipes', { ids: [R1, R2] }, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.missingIds).toEqual([R2]);
    const [got] = out.data.recipes as Record<string, unknown>[];
    expect(got).toMatchObject({ id: R1, version: 77, title: 'Soup', collectionName: 'Weeknight' });
    for (const key of ['photoId', 'galleryPhotoIds', 'createdAt', 'updatedAt', 'importCheck', 'lang']) {
      expect(got).not.toHaveProperty(key);
    }
    expect(ctx.directReads).toEqual([]);
  });

  it('reads ids a capped library left out directly, in the order asked', async () => {
    const R3 = '55555555-5555-4555-8555-555555555555';
    const ctx = fakeContext([recipe({ id: R1, title: 'Loaded' }), recipe({ id: R2, title: 'Past the cap' })], [], {
      loadCap: 1,
    });
    const out = await run('get_recipes', { ids: [R2, R1, R3] }, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.data.recipes as { title: string }[]).map((r) => r.title)).toEqual(['Past the cap', 'Loaded']);
    expect(out.data.missingIds).toEqual([R3]);
    expect(ctx.directReads).toEqual([[R2, R3]]);
  });

  it('rejects zero or more than eight ids', async () => {
    const ctx = fakeContext([]);
    expect((await run('get_recipes', { ids: [] }, ctx)).ok).toBe(false);
    expect((await run('get_recipes', { ids: Array(9).fill(R1) }, ctx)).ok).toBe(false);
    expect((await run('get_recipes', {}, ctx)).ok).toBe(false);
  });
});

describe('list_collections', () => {
  it('counts each recipe once and adds Unfiled', async () => {
    const ctx = fakeContext(
      [recipe({ id: R1, title: 'A' }), recipe({ id: R2, title: 'B' })],
      [{ id: 'c1', name: 'Soups', recipeIds: [R1] }],
    );
    const out = await run('list_collections', {}, ctx);
    expect(out.ok && out.data.collections).toEqual([
      { id: 'c1', name: 'Soups', recipeCount: 1 },
      { id: 'unfiled', name: 'Unfiled', recipeCount: 1 },
    ]);
  });
});

describe('create_recipe', () => {
  it('assigns the id and time, stores Unfiled, and returns the version', async () => {
    const ctx = fakeContext([]);
    const out = await run(
      'create_recipe',
      { title: 'MCP test', servings: 2, ingredientSections: [{ items: [{ item: 'egg' }] }], steps: [{ text: 'Boil.' }] },
      ctx,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(ctx.created).toEqual([NEW_ID]);
    expect(ctx.docs.get(NEW_ID)).toMatchObject({ id: NEW_ID, createdAt: 400, updatedAt: 400 });
    expect(out.data.recipe).toMatchObject({ id: NEW_ID, version: 400, collectionName: 'Unfiled' });
  });

  it('rejects an invalid recipe without writing', async () => {
    const ctx = fakeContext([]);
    const out = await run('create_recipe', { title: 'x', servings: 0, ingredientSections: [], steps: [] }, ctx);
    expect(out).toMatchObject({ ok: false, code: 'invalid' });
    expect(ctx.created).toEqual([]);
  });
});

describe('update_recipe', () => {
  const stored = recipe({ id: R1, title: 'Lasagne', updatedAt: 10, photoId: PHOTO, notes: 'Rest it.' });

  it('patches with the matching version and returns the new version', async () => {
    const ctx = fakeContext([stored]);
    const out = await run('update_recipe', { id: R1, version: 10, changes: { servings: 6, notes: null } }, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.recipe).toMatchObject({ id: R1, version: 500, servings: 6, title: 'Lasagne' });
    expect(out.data.recipe).not.toHaveProperty('notes');
    expect(ctx.docs.get(R1)).toMatchObject({ photoId: PHOTO, createdAt: 1 });
  });

  it('is conflict with the current version when the version is stale', async () => {
    const out = await run('update_recipe', { id: R1, version: 9, changes: { servings: 6 } }, fakeContext([stored]));
    expect(out).toMatchObject({ ok: false, code: 'conflict', data: { currentVersion: 10 } });
    if (out.ok) return;
    expect(out.message).toContain('get_recipes');
  });

  it('is not_found for a missing, tombstoned, or non-id recipe', async () => {
    const ctx = fakeContext([stored]);
    ctx.docs.set(R2, { ...stored, id: R2, deletedAt: 20 });
    for (const id of [R2, NEW_ID, 'shared-or-bogus']) {
      expect(await run('update_recipe', { id, version: 10, changes: { servings: 6 } }, ctx)).toMatchObject({
        ok: false,
        code: 'not_found',
      });
    }
  });

  it('rejects invalid changes before touching the store', async () => {
    const ctx = fakeContext([stored]);
    const out = await run('update_recipe', { id: R1, version: 10, changes: { title: null } }, ctx);
    expect(out).toMatchObject({ ok: false, code: 'invalid' });
    expect(ctx.docs.get(R1)).toMatchObject({ updatedAt: 10 });
  });
});

describe('callToolResult', () => {
  it('returns structured content and the same JSON as text', () => {
    const result = callToolResult({ ok: true, data: { hits: [], total: 0 } });
    expect(result.structuredContent).toEqual({ hits: [], total: 0 });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    expect(result).not.toHaveProperty('isError');
  });

  it('marks failures isError with a stable code', () => {
    const result = callToolResult({ ok: false, code: 'conflict', message: 'm', data: { currentVersion: 3 } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: 'conflict', message: 'm', currentVersion: 3 });
  });
});
