import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type, type Schema } from '@google/genai';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  importFromHtml,
  importFromSource,
  normalizeImportedRecipe,
  recipeImportDepsFromEnv,
  type ImportOutcome,
  type ImportedRecipe,
} from '../server/recipeImport.ts';

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), 'import');

const TEXT_FIXTURES = ['pomodoro', 'messy-sections'] as const;
const PAGE_FIXTURES = ['gumbo', 'beef-noodle-soup', 'beef-stew'] as const;

const JUDGE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    pass: { type: Type.BOOLEAN },
    failures: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          field: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ['field', 'reason'],
      },
    },
  },
  required: ['pass', 'failures'],
};

function readFixtureText(name: string, file: string): string {
  return readFileSync(join(fixturesRoot, name, file), 'utf8');
}

/** Runs a fixture through the same entry point production uses for it. */
function importFixture(name: string): Promise<ImportOutcome> {
  const deps = recipeImportDepsFromEnv();
  const htmlPath = join(fixturesRoot, name, 'page.html');
  if (existsSync(htmlPath)) {
    return importFromHtml(readFileSync(htmlPath, 'utf8'), deps);
  }
  return importFromSource(readFixtureText(name, 'source.txt'), deps);
}

function readGolden(name: string): ImportedRecipe {
  const parsed: unknown = JSON.parse(readFixtureText(name, 'golden.json'));
  const golden = normalizeImportedRecipe(parsed);
  if (golden === null) {
    throw new Error(`evals/import/${name}/golden.json is not a usable recipe`);
  }
  return golden;
}

function ingredientCount(draft: ImportedRecipe): number {
  return draft.ingredientSections.reduce((n, section) => n + section.items.length, 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJudgeVerdict(raw: string): {
  pass: boolean;
  failures: { field: string; reason: string }[];
} {
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed) || typeof parsed.pass !== 'boolean') {
    throw new Error('judge verdict is not a { pass, failures } object');
  }
  const failures: { field: string; reason: string }[] = [];
  if (Array.isArray(parsed.failures)) {
    for (const row of parsed.failures) {
      if (!isPlainObject(row)) continue;
      if (typeof row.field !== 'string' || typeof row.reason !== 'string') continue;
      failures.push({ field: row.field, reason: row.reason });
    }
  }
  return { pass: parsed.pass, failures };
}

async function judgeOnce(
  ai: GoogleGenAI,
  extracted: ImportedRecipe,
  golden: ImportedRecipe,
): Promise<string> {
  const result = await ai.models.generateContent({
    model: process.env.CHAT_MODEL || 'gemini-3.7-flash',
    contents:
      'You compare a recipe extracted from source text to a golden RecipeDraft. ' +
      'Decide if the extraction is close enough. Do not require exact JSON equality.\n\n' +
      'Pass unless a rule below fails:\n' +
      '- Title names the same dish; wording may differ.\n' +
      '- Every golden ingredient is present under a recognizable name. Extra garnish, salt, or pepper is ok. A missing main ingredient is a fail.\n' +
      '- Quantities are equivalent (½ ≡ 0.5, 3 tbsp ≡ 3 tablespoon). Unit aliases tsp, tbsp, cup, ml, l, g, kg, oz, lb, piece count as a match.\n' +
      '- Steps cover the same operations in the same order; wording may be shorter.\n' +
      '- Tags overlap in meaning; do not require an identical list.\n' +
      '- description, times, and notes are soft: fail only if they contradict the golden (wrong method, 10 min vs 2 hours).\n\n' +
      `Golden:\n${JSON.stringify(golden)}\n\n` +
      `Extracted:\n${JSON.stringify(extracted)}`,
    config: {
      temperature: 0,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      responseSchema: JUDGE_SCHEMA,
    },
  });
  return result.text ?? '';
}

async function judgeRecipe(
  extracted: ImportedRecipe,
  golden: ImportedRecipe,
): Promise<{ pass: boolean; failures: { field: string; reason: string }[] }> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  try {
    return parseJudgeVerdict(await judgeOnce(ai, extracted, golden));
  } catch {
    return parseJudgeVerdict(await judgeOnce(ai, extracted, golden));
  }
}

async function expectCloseToGolden(name: string): Promise<void> {
  const golden = readGolden(name);
  const result = await importFixture(name);
  expect(result.kind, `${name} import outcome`).toBe('ok');
  if (result.kind !== 'ok') return;
  const extracted = result.recipe;

  expect(extracted.servings, `${name} servings`).toBe(golden.servings);

  const gotIng = ingredientCount(extracted);
  const goldIng = ingredientCount(golden);
  expect(
    Math.abs(gotIng - goldIng),
    `${name} ingredient count ${gotIng} vs golden ${goldIng}\n${JSON.stringify(extracted, null, 2)}`,
  ).toBeLessThanOrEqual(2);

  const gotSteps = extracted.steps.length;
  const goldSteps = golden.steps.length;
  expect(
    Math.abs(gotSteps - goldSteps),
    `${name} step count ${gotSteps} vs golden ${goldSteps}\n${JSON.stringify(extracted, null, 2)}`,
  ).toBeLessThanOrEqual(2);

  const verdict = await judgeRecipe(extracted, golden);
  const failureText =
    verdict.failures.length === 0
      ? 'judge rejected the extraction with no failure list'
      : verdict.failures.map((row) => `${row.field}: ${row.reason}`).join('\n');
  expect(
    verdict.pass,
    `${name} judge:\n${failureText}\n\nextracted:\n${JSON.stringify(extracted, null, 2)}`,
  ).toBe(true);
}

describe('import from text (live Gemini)', () => {
  beforeAll(() => {
    if (!process.env.GEMINI_API_KEY?.trim()) {
      throw new Error(
        'GEMINI_API_KEY is required for npm run test:import. Put it in .env.local (same as dev:api).',
      );
    }
  });

  it('rejects text that is not a recipe', async () => {
    const result = await importFixture('not-a-recipe');
    expect(result.kind).toBe('not_a_recipe');
  });

  it.each(TEXT_FIXTURES)(
    'extracts %s close to the golden recipe',
    async (name) => {
      await expectCloseToGolden(name);
    },
  );
});

describe('import from cached page (live Gemini)', () => {
  beforeAll(() => {
    if (!process.env.GEMINI_API_KEY?.trim()) {
      throw new Error(
        'GEMINI_API_KEY is required for npm run test:import. Put it in .env.local (same as dev:api).',
      );
    }
  });

  it.each(PAGE_FIXTURES)(
    'extracts %s from cached HTML close to the golden recipe',
    async (name) => {
      expect(existsSync(join(fixturesRoot, name, 'page.html'))).toBe(true);
      await expectCloseToGolden(name);
    },
  );
});
