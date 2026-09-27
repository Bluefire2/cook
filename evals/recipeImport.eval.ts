import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  importFromHtml,
  importFromImages,
  importFromSource,
  normalizeImportedRecipe,
  recipeImportDepsFromEnv,
  type ImportOutcome,
  type ImportedRecipe,
} from '../server/recipeImport.ts';
import {
  listHandwrittenFixtures,
  type HandwrittenFixture,
  type HandwrittenSplit,
} from './handwrittenFixtures.ts';
import { ingredientCount, judgeRecipe } from './judge.ts';

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), 'import');

const TEXT_FIXTURES = ['pomodoro', 'messy-sections'] as const;
const PAGE_FIXTURES = ['gumbo', 'beef-noodle-soup', 'beef-stew'] as const;

const HANDWRITTEN_DEV = listHandwrittenFixtures('dev');
const HANDWRITTEN_HOLDOUT = listHandwrittenFixtures('holdout');

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

async function expectCloseToGolden(
  label: string,
  golden: ImportedRecipe,
  result: ImportOutcome,
  options: { redact?: boolean } = {},
): Promise<void> {
  expect(result.kind, `${label} import outcome`).toBe('ok');
  if (result.kind !== 'ok') return;
  const extracted = result.recipe;

  if (options.redact === true) {
    expect(
      extracted.servings === golden.servings,
      `${label} servings mismatch (holdout: values hidden)`,
    ).toBe(true);

    const gotIng = ingredientCount(extracted);
    const goldIng = ingredientCount(golden);
    expect(
      Math.abs(gotIng - goldIng),
      `${label} ingredient count ${gotIng} vs golden ${goldIng}`,
    ).toBeLessThanOrEqual(2);

    const gotSteps = extracted.steps.length;
    const goldSteps = golden.steps.length;
    expect(
      Math.abs(gotSteps - goldSteps),
      `${label} step count ${gotSteps} vs golden ${goldSteps}`,
    ).toBeLessThanOrEqual(2);

    let verdict: { pass: boolean; failures: { field: string; reason: string }[] };
    try {
      verdict = await judgeRecipe(extracted, golden);
    } catch {
      throw new Error(`${label} judge errored (holdout: message hidden)`);
    }
    expect(
      verdict.pass,
      `${label} judge failed with ${verdict.failures.length} reason(s) (holdout: reasons hidden)`,
    ).toBe(true);
    return;
  }

  expect(extracted.servings, `${label} servings`).toBe(golden.servings);

  const gotIng = ingredientCount(extracted);
  const goldIng = ingredientCount(golden);
  expect(
    Math.abs(gotIng - goldIng),
    `${label} ingredient count ${gotIng} vs golden ${goldIng}\n${JSON.stringify(extracted, null, 2)}`,
  ).toBeLessThanOrEqual(2);

  const gotSteps = extracted.steps.length;
  const goldSteps = golden.steps.length;
  expect(
    Math.abs(gotSteps - goldSteps),
    `${label} step count ${gotSteps} vs golden ${goldSteps}\n${JSON.stringify(extracted, null, 2)}`,
  ).toBeLessThanOrEqual(2);

  const verdict = await judgeRecipe(extracted, golden);
  const failureText =
    verdict.failures.length === 0
      ? 'judge rejected the extraction with no failure list'
      : verdict.failures.map((row) => `${row.field}: ${row.reason}`).join('\n');
  expect(
    verdict.pass,
    `${label} judge:\n${failureText}\n\nextracted:\n${JSON.stringify(extracted, null, 2)}`,
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
      await expectCloseToGolden(name, readGolden(name), await importFixture(name));
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
      await expectCloseToGolden(name, readGolden(name), await importFixture(name));
    },
  );
});

function describeHandwritten(
  split: HandwrittenSplit,
  fixtures: HandwrittenFixture[],
  redact: boolean,
): void {
  if (fixtures.length === 0) {
    // `it.each([])` would fail the suite with "No test found in suite".
    describe(`import from handwritten photos, ${split} split (live Gemini)`, () => {
      it.skip(`no fixtures in evals/import-handwritten/${split}/ — see evals/README.md`, () => {});
    });
    return;
  }

  describe(`import from handwritten photos, ${split} split (live Gemini)`, () => {
    beforeAll(() => {
      if (!process.env.GEMINI_API_KEY?.trim()) {
        throw new Error(
          'GEMINI_API_KEY is required for npm run test:import. Put it in .env.local (same as dev:api).',
        );
      }
    });

    it.each(fixtures.map((f) => f.name))(
      'extracts %s from photos close to the golden recipe',
      async (name) => {
        const fixture = fixtures.find((f) => f.name === name);
        if (fixture === undefined) throw new Error(`no handwritten fixture ${name}`);
        if (redact) {
          let result: ImportOutcome;
          try {
            result = await importFromImages(fixture.pages, '', recipeImportDepsFromEnv());
          } catch {
            throw new Error(`${name} import threw (holdout: message hidden)`);
          }
          await expectCloseToGolden(name, fixture.golden, result, { redact: true });
          return;
        }
        const result = await importFromImages(fixture.pages, '', recipeImportDepsFromEnv());
        await expectCloseToGolden(name, fixture.golden, result);
      },
    );
  });
}

describeHandwritten('dev', HANDWRITTEN_DEV, false);
describeHandwritten('holdout', HANDWRITTEN_HOLDOUT, true);
