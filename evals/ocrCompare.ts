/**
 * Compares two ways of reading the handwritten fixtures in
 * `evals/import-handwritten/`:
 *
 * - A (production): the photos go straight to Gemini (`importFromImages`).
 * - B (Cloud Vision → Gemini): DOCUMENT_TEXT_DETECTION per page, then Gemini
 *   on the joined OCR text (`importFromSource`).
 *
 * For each fixture and run it prints latency, tokens, estimated cost, and the
 * judge's verdict against `golden.json`.
 *
 *   node --env-file=.env.local evals/ocrCompare.ts [fixture…] [--runs=N]
 *   npm run eval:ocr-compare
 *
 * A needs `GEMINI_API_KEY` (the judge uses it too). B needs Application
 * Default Credentials with `vision.googleapis.com` enabled on the quota
 * project, and is skipped with a message without them. Never runs in CI. The
 * numbers inform principle 2's "When to revisit" in
 * `docs/constitutions/image-import.md`; they do not block shipping.
 *
 * Output is stdout only, with no base64, OCR text, or request bodies, and no
 * result files: transcriptions of personal notes are personal data. Exits 0
 * whatever the judge says; non-zero only for a harness error.
 */
import { GoogleAuth } from 'google-auth-library';
import {
  importFromImages,
  importFromSource,
  recipeImportDepsFromEnv,
  type ImportImage,
  type ImportOutcome,
  type ImportedRecipe,
  type RecipeImportDeps,
} from '../server/recipeImport.ts';
import { listHandwrittenFixtures, type HandwrittenFixture } from './handwrittenFixtures.ts';
import { ingredientCount, judgeRecipe } from './judge.ts';

// Estimates carried over from the owner-approved plan: gemini-3.7-flash is not
// on the public pricing page.
const GEMINI_INPUT_USD_PER_MTOK = 1.5;
/** Applies to candidates plus thoughts. */
const GEMINI_OUTPUT_USD_PER_MTOK = 9;
/** List price after the free 1,000 units a month. */
const VISION_USD_PER_UNIT = 1.5 / 1000;

const VISION_URL = 'https://eu-vision.googleapis.com/v1/images:annotate';

const MAX_RUNS = 5;

// Neither the Gemini SDK nor fetch times out by default; one stalled call would
// hang the whole run with nothing printed.
const GEMINI_TIMEOUT_MS = 90_000;
const JUDGE_TIMEOUT_MS = 2 * GEMINI_TIMEOUT_MS;
const VISION_TIMEOUT_MS = 30_000;
const ADC_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type Approach = 'A' | 'B';

type RunKind = ImportOutcome['kind'] | 'gemini_error' | 'vision_error';

interface TokenUsage {
  prompt: number;
  output: number;
  thinking: number;
  /** Gemini `finishReason` per call, joined with `+`; anything but STOP means the reply was cut short. */
  finish: string;
}

interface RunResult {
  fixture: string;
  run: number;
  approach: Approach;
  kind: RunKind;
  pages: number;
  visionMs: number;
  geminiMs: number;
  tokens: TokenUsage;
  visionUnits: number;
  geminiUsd: number;
  judge: 'pass' | 'fail' | 'error' | '—';
  judgeFailures: { field: string; reason: string }[];
  ingredientDelta: number | null;
  stepDelta: number | null;
}

interface VisionPageResponse {
  error?: unknown;
  fullTextAnnotation?: { text?: string };
}

type VisionOcr =
  | { kind: 'ok'; text: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'vision_error' };

function recordingDeps(base: RecipeImportDeps): { deps: RecipeImportDeps; usage: TokenUsage[] } {
  const usage: TokenUsage[] = [];
  const deps: RecipeImportDeps = {
    model: base.model,
    ai: {
      models: {
        generateContent: async (params) => {
          const response = await withTimeout(
            base.ai.models.generateContent(params),
            GEMINI_TIMEOUT_MS,
            'Gemini',
          );
          usage.push({
            prompt: response.usageMetadata?.promptTokenCount ?? 0,
            output: response.usageMetadata?.candidatesTokenCount ?? 0,
            thinking: response.usageMetadata?.thoughtsTokenCount ?? 0,
            finish: response.candidates?.[0]?.finishReason ?? 'none',
          });
          return response;
        },
      },
    },
  };
  return { deps, usage };
}

function sumUsage(usage: readonly TokenUsage[]): TokenUsage {
  return usage.reduce(
    (total, row) => ({
      prompt: total.prompt + row.prompt,
      output: total.output + row.output,
      thinking: total.thinking + row.thinking,
      finish: total.finish === '' ? row.finish : `${total.finish}+${row.finish}`,
    }),
    { prompt: 0, output: 0, thinking: 0, finish: '' },
  );
}

function geminiUsd(tokens: TokenUsage): number {
  return (
    (tokens.prompt * GEMINI_INPUT_USD_PER_MTOK +
      (tokens.output + tokens.thinking) * GEMINI_OUTPUT_USD_PER_MTOK) /
    1_000_000
  );
}

function parseArgs(argv: readonly string[]): { names: string[]; runs: number } {
  const names: string[] = [];
  let runs = 1;
  for (const arg of argv) {
    if (arg.startsWith('--runs=')) {
      const n = Number.parseInt(arg.slice('--runs='.length), 10);
      runs = Number.isFinite(n) ? Math.min(MAX_RUNS, Math.max(1, n)) : 1;
    } else {
      names.push(arg);
    }
  }
  return { names, runs };
}

async function visionOcr(pages: readonly ImportImage[], auth: Headers): Promise<VisionOcr> {
  const headers = new Headers(auth);
  headers.set('Content-Type', 'application/json');
  let res: Response;
  try {
    res = await fetch(VISION_URL, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      body: JSON.stringify({
        requests: pages.map((p) => ({
          image: { content: p.base64 },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        })),
      }),
    });
  } catch {
    return { kind: 'vision_error' };
  }
  if (res.status === 401 || res.status === 403) {
    let errorStatus = 'UNKNOWN';
    try {
      const body = (await res.json()) as { error?: { status?: unknown } };
      if (typeof body.error?.status === 'string') errorStatus = body.error.status;
    } catch {
      // Keep UNKNOWN.
    }
    return {
      kind: 'denied',
      reason:
        `Cloud Vision returned ${res.status} ${errorStatus}. ` +
        'Enable vision.googleapis.com on cooking-assistant-508423 and check the ADC quota project.',
    };
  }
  if (!res.ok) return { kind: 'vision_error' };
  let responses: VisionPageResponse[];
  try {
    const body = (await res.json()) as { responses?: VisionPageResponse[] };
    if (!Array.isArray(body.responses) || body.responses.length !== pages.length) {
      return { kind: 'vision_error' };
    }
    responses = body.responses;
  } catch {
    return { kind: 'vision_error' };
  }
  if (responses.some((r) => r.error !== undefined)) return { kind: 'vision_error' };
  return {
    kind: 'ok',
    text: responses
      .map((r, i) => `Page ${i + 1}:\n${r.fullTextAnnotation?.text ?? ''}`)
      .join('\n\n'),
  };
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T | null; ms: number }> {
  const start = performance.now();
  try {
    const value = await run();
    return { value, ms: performance.now() - start };
  } catch {
    // Not logged: SDK errors can echo the request.
    return { value: null, ms: performance.now() - start };
  }
}

async function judged(
  result: Omit<RunResult, 'judge' | 'judgeFailures' | 'ingredientDelta' | 'stepDelta'>,
  outcome: ImportOutcome | null,
  golden: ImportedRecipe,
): Promise<RunResult> {
  if (outcome === null || outcome.kind !== 'ok') {
    return { ...result, judge: '—', judgeFailures: [], ingredientDelta: null, stepDelta: null };
  }
  const recipe = outcome.recipe;
  const deltas = {
    ingredientDelta: ingredientCount(recipe) - ingredientCount(golden),
    stepDelta: recipe.steps.length - golden.steps.length,
  };
  try {
    const verdict = await withTimeout(judgeRecipe(recipe, golden), JUDGE_TIMEOUT_MS, 'Judge');
    return {
      ...result,
      ...deltas,
      judge: verdict.pass ? 'pass' : 'fail',
      judgeFailures: verdict.failures,
    };
  } catch {
    return { ...result, ...deltas, judge: 'error', judgeFailures: [] };
  }
}

async function runA(
  fixture: HandwrittenFixture,
  run: number,
  base: RecipeImportDeps,
): Promise<RunResult> {
  const { deps, usage } = recordingDeps(base);
  const { value: outcome, ms } = await timed(() => importFromImages(fixture.pages, '', deps));
  const tokens = sumUsage(usage);
  return judged(
    {
      fixture: fixture.name,
      run,
      approach: 'A',
      kind: outcome?.kind ?? 'gemini_error',
      pages: fixture.pages.length,
      visionMs: 0,
      geminiMs: ms,
      tokens,
      visionUnits: 0,
      geminiUsd: geminiUsd(tokens),
    },
    outcome,
    fixture.golden,
  );
}

async function runB(
  fixture: HandwrittenFixture,
  run: number,
  base: RecipeImportDeps,
  auth: Headers,
): Promise<RunResult | { kind: 'denied'; reason: string }> {
  const visionStart = performance.now();
  const ocr = await visionOcr(fixture.pages, auth);
  const visionMs = performance.now() - visionStart;
  if (ocr.kind === 'denied') return ocr;
  const shared = {
    fixture: fixture.name,
    run,
    approach: 'B' as const,
    pages: fixture.pages.length,
    visionMs,
    visionUnits: fixture.pages.length,
  };
  if (ocr.kind === 'vision_error') {
    return judged(
      {
        ...shared,
        kind: 'vision_error',
        geminiMs: 0,
        tokens: { prompt: 0, output: 0, thinking: 0, finish: '—' },
        geminiUsd: 0,
      },
      null,
      fixture.golden,
    );
  }
  const { deps, usage } = recordingDeps(base);
  const { value: outcome, ms } = await timed(() => importFromSource(ocr.text, deps));
  const tokens = sumUsage(usage);
  return judged(
    {
      ...shared,
      kind: outcome?.kind ?? 'gemini_error',
      geminiMs: ms,
      tokens,
      geminiUsd: geminiUsd(tokens),
    },
    outcome,
    fixture.golden,
  );
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((n, v) => n + v, 0) / values.length;
}

function usd(value: number): number {
  return Number(value.toFixed(5));
}

function tableRow(r: RunResult): Record<string, string | number> {
  return {
    fixture: r.fixture,
    run: r.run,
    approach: r.approach,
    outcome: r.kind,
    'vision ms': Math.round(r.visionMs),
    'gemini ms': Math.round(r.geminiMs),
    'total ms': Math.round(r.visionMs + r.geminiMs),
    'prompt tok': r.tokens.prompt,
    'output tok': r.tokens.output,
    'thinking tok': r.tokens.thinking,
    finish: r.tokens.finish,
    'vision units': r.visionUnits,
    'est USD': usd(r.geminiUsd + r.visionUnits * VISION_USD_PER_UNIT),
    judge: r.judge,
    'Δ ingredients': r.ingredientDelta ?? '—',
    'Δ steps': r.stepDelta ?? '—',
  };
}

function summaryRow(approach: Approach, rows: readonly RunResult[]): Record<string, string | number> {
  const passes = rows.filter((r) => r.judge === 'pass').length;
  const row: Record<string, string | number> = {
    approach,
    passes: `${passes}/${rows.length}`,
    'median total ms': Math.round(median(rows.map((r) => r.visionMs + r.geminiMs))),
    'mean USD': usd(mean(rows.map((r) => r.geminiUsd + r.visionUnits * VISION_USD_PER_UNIT))),
  };
  if (approach === 'B') row['mean USD (free tier)'] = usd(mean(rows.map((r) => r.geminiUsd)));
  row['mean prompt tok/page'] = Math.round(mean(rows.map((r) => r.tokens.prompt / r.pages)));
  return row;
}

async function main(): Promise<number> {
  if (!process.env.GEMINI_API_KEY?.trim()) {
    console.error('GEMINI_API_KEY is required. Put it in .env.local (same as dev:api).');
    return 1;
  }

  const { names, runs } = parseArgs(process.argv.slice(2));
  let fixtures: HandwrittenFixture[];
  try {
    fixtures = listHandwrittenFixtures();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (names.length > 0) {
    for (const name of names) {
      if (!fixtures.some((f) => f.name === name)) console.log(`No fixture named ${name}; ignoring it.`);
    }
    fixtures = fixtures.filter((f) => names.includes(f.name));
  }
  if (fixtures.length === 0) {
    console.log('No handwritten fixtures in evals/import-handwritten/. See evals/README.md to add some.');
    return 0;
  }

  const b: { auth: Headers | null; skipped: string | null } = { auth: null, skipped: null };
  const skipB = (reason: string): void => {
    if (b.skipped !== null) return;
    b.skipped = reason;
    b.auth = null;
    console.log(`Skipping B (Cloud Vision → Gemini): ${reason}`);
  };

  try {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    b.auth = await withTimeout(auth.getRequestHeaders(VISION_URL), ADC_TIMEOUT_MS, 'ADC lookup');
  } catch {
    skipB(
      'no Application Default Credentials (or the lookup timed out). Run gcloud auth application-default login, then gcloud auth application-default set-quota-project cooking-assistant-508423.',
    );
  }

  const base = recipeImportDepsFromEnv();
  const results: RunResult[] = [];
  const record = (r: RunResult): void => {
    results.push(r);
    console.log(
      `${r.fixture} run ${r.run} ${r.approach}: ${r.kind}, ${Math.round(r.visionMs + r.geminiMs)} ms, finish ${r.tokens.finish}, judge ${r.judge}`,
    );
  };
  console.log(
    `Running ${fixtures.length} fixture(s) x ${runs} run(s): A${b.auth !== null ? ' and B' : ''}. Each line prints as a run finishes.`,
  );
  for (const fixture of fixtures) {
    for (let run = 1; run <= runs; run++) {
      record(await runA(fixture, run, base));
      if (b.auth !== null) {
        const result = await runB(fixture, run, base, b.auth);
        if (result.kind === 'denied') skipB(result.reason);
        else record(result);
      }
    }
  }

  console.table(results.map(tableRow));

  const failures = results.filter((r) => r.judgeFailures.length > 0);
  if (failures.length > 0) {
    console.log('Judge failures:');
    for (const r of failures) {
      for (const f of r.judgeFailures) {
        console.log(`  ${r.fixture} run ${r.run} ${r.approach} — ${f.field}: ${f.reason}`);
      }
    }
  }

  const summary = (['A', 'B'] as const)
    .map((approach) => ({ approach, rows: results.filter((r) => r.approach === approach) }))
    .filter(({ rows }) => rows.length > 0)
    .map(({ approach, rows }) => summaryRow(approach, rows));
  console.log('Summary:');
  console.table(summary);
  if (b.skipped !== null) console.log(`B was skipped: ${b.skipped}`);
  return 0;
}

// exit() rather than exitCode: a timed-out request can keep a socket open.
process.exit(await main());
