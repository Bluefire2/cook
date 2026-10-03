/**
 * Step 1 spike for docs/plans/i18n-review-ci.md. Captures three states in four
 * languages against a running test server, twice each to test determinism,
 * then judges each target language with two Gemini models and records time,
 * tokens, and whether quoted text matches the page. Throwaway: the pieces
 * that hold up move into capture.ts and judge.ts in step 2.
 *
 *   node --env-file=<path to .env.local> testing/i18n-review/spike.ts http://localhost:4173
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type } from '@google/genai';
import { chromium, type Page } from 'playwright';
import { en } from '../../src/i18n/en.ts';
import { ru } from '../../src/i18n/ru.ts';
import { uk } from '../../src/i18n/uk.ts';
import { zhHans } from '../../src/i18n/zh-Hans.ts';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const baseUrl = (process.argv[2] ?? 'http://localhost:4173').replace(/\/+$/, '');
const outDir = join(repoRoot, '.i18n-review', 'spike');
mkdirSync(outDir, { recursive: true });

const LANGS = { en, uk, ru, 'zh-Hans': zhHans } as const;
type Lang = keyof typeof LANGS;
const LANG_NAMES: Record<Lang, string> = { en: 'English', uk: 'Ukrainian', ru: 'Russian', 'zh-Hans': 'Simplified Chinese' };

function text(lang: Lang, key: keyof typeof en): string {
  const value = LANGS[lang][key];
  if (typeof value !== 'string') throw new Error(`${key} is not a plain string`);
  return value;
}

const SPIKE_RECIPE = {
  title: 'Spring pea soup',
  servings: 4,
  prepMinutes: 10,
  cookMinutes: 20,
  tags: ['soup'],
  ingredientSections: [
    {
      items: [
        { quantity: 500, unit: 'g', item: 'frozen peas' },
        { quantity: 1, item: 'onion', note: 'chopped' },
        { quantity: 750, unit: 'ml', item: 'vegetable stock' },
      ],
    },
  ],
  steps: [
    { text: 'Soften the onion in a little butter.' },
    { text: 'Add the peas and stock and simmer for 5 minutes.' },
    { text: 'Blend until smooth and season.' },
  ],
};

interface State {
  id: string;
  persona: string;
  path: string;
  reach?: (page: Page, lang: Lang) => Promise<void>;
}

const STATES: State[] = [
  { id: 'settings', persona: 'member', path: '/settings' },
  { id: 'library-populated', persona: 'member', path: '/' },
  {
    id: 'import-preview',
    persona: 'member',
    path: '/import',
    reach: async (page, lang) => {
      await page.route('**/api/import', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recipe: SPIKE_RECIPE }) }),
      );
      await page.locator('textarea').fill('https://example.com/spring-pea-soup');
      await page.getByRole('button', { name: text(lang, 'import.extractRecipe') }).click();
      await page.getByRole('button', { name: text(lang, 'common.save'), exact: true }).first().waitFor();
    },
  },
];

interface Capture {
  state: string;
  lang: Lang;
  png: Buffer;
  pageText: string;
  ms: number;
}

/** Replaces one text node's exact text in the rendered page, to test the judge's recall. */
interface Defect {
  from: string;
  to: string;
}

async function capture(state: State, lang: Lang, run: number | string, defect?: Defect): Promise<Capture> {
  const started = Date.now();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await context.addInitScript((locale) => {
      localStorage.setItem('cook.locale', locale);
    }, lang);
    const page = await context.newPage();
    await page.goto(`${baseUrl}/__test/sign-in?as=${state.persona}&returnTo=${encodeURIComponent(state.path)}`);
    await page.waitForLoadState('networkidle');
    if (state.reach) await state.reach(page, lang);
    await page.waitForLoadState('networkidle');
    await page.evaluate('document.fonts.ready');
    if (defect) {
      const replaced = await page.evaluate(`(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let count = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.nodeValue.trim() === ${JSON.stringify(defect.from)}) {
            node.nodeValue = node.nodeValue.replace(${JSON.stringify(defect.from)}, ${JSON.stringify(defect.to)});
            count += 1;
          }
        }
        return count;
      })()`);
      if (replaced === 0) throw new Error(`defect: no text node "${defect.from}" in ${state.id} ${lang}`);
    }
    const png = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
    const pageText = await page.locator('body').innerText();
    writeFileSync(join(outDir, `${state.id}-${lang}-${run}.png`), png);
    return { state: state.id, lang, png, pageText, ms: Date.now() - started };
  } finally {
    await browser.close();
  }
}

function section(path: string, start: RegExp, end: RegExp): string {
  const textOf = readFileSync(join(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
  const from = textOf.search(start);
  if (from === -1) throw new Error(`${path}: section ${start} not found`);
  const rest = textOf.slice(from);
  const to = rest.slice(1).search(end);
  return to === -1 ? rest : rest.slice(0, to + 1);
}

const MANIFEST = JSON.parse(readFileSync(join(repoRoot, 'docs/i18n-review/screens.json'), 'utf8')) as {
  id: string;
  setup: string;
}[];
const setupOf = (id: string) => MANIFEST.find((entry) => entry.id === id)?.setup ?? '';

const RUBRIC = section('docs/i18n-review/README.md', /^## Rubric$/m, /^## /m);
const GLOSSARY = section('docs/constitutions/i18n.md', /^- \*\*Register and glossary\.\*\*/m, /^- \*\*/m);

const JUDGE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    pass: { type: Type.BOOLEAN },
    issues: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING, description: 'The exact app text with the problem, copied from the page text.' },
          problem: { type: Type.STRING },
          suggestion: { type: Type.STRING },
          severity: { type: Type.STRING, enum: ['blocker', 'nit'] },
          rubricItem: {
            type: Type.STRING,
            enum: ['Sense in context', 'Consistent terms', 'Grammar across strings', 'Register', 'Nothing left in English', 'Layout'],
          },
        },
        required: ['text', 'problem', 'suggestion', 'severity', 'rubricItem'],
      },
    },
  },
  required: ['pass', 'issues'],
};

function prompt(lang: Lang, pageText: string, setup: string): string {
  return `You review the UI text of a recipe app, Sous, in ${LANG_NAMES[lang]} (${lang}).

What this screen is, from the review manifest (written for the person capturing it; it names the controls on screen):
"""
${setup}
"""

Image 1 is the English screen, for reference. Image 2 is the same screen in ${LANG_NAMES[lang]}. Judge only image 2, and only the app's own text: labels, buttons, headings, messages, hints.

Not app text, so never report it, whatever language it is in: recipe titles, descriptions, ingredients, steps, notes, and tags; collection names; people's names and email addresses; names of connected apps. These are the user's data and stay as the user wrote them. Language names in the language picker are written in their own language on purpose (English, Українська, Русский, 简体中文); that is correct.

Apply this rubric:

${RUBRIC}

Register and glossary. Text that uses the glossary's term for a concept is correct, even if the English word looks ambiguous on its own; check the glossary before reporting a word choice:

${GLOSSARY}

Severity: "blocker" for app text that is wrong in meaning, ungrammatical, left in English, inconsistent with the glossary, in the wrong register, or visibly cut off or overflowing; "nit" for wording that is correct but could read better.

Layout: judge spacing, truncation, and overflow only from image 2. The page text below is extracted text and loses spacing between elements, so never report spacing from it.

For each issue, copy "text" exactly from the page text below, so it can be found in the catalog. Return pass: true and no issues when the screen is fine.

Page text of image 2:
"""
${pageText}
"""`;
}

interface JudgeIssue {
  text: string;
  problem: string;
  suggestion: string;
  severity: string;
  rubricItem: string;
}

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

const DEFECTS: { state: string; lang: Lang; defect: Defect; expect: string }[] = [
  { state: 'import-preview', lang: 'uk', defect: { from: 'Зберегти', to: 'Save' }, expect: 'Save' },
  { state: 'library-populated', lang: 'ru', defect: { from: 'Выбрать', to: 'Выбор' }, expect: 'Выбор' },
];
const JUDGE_MODEL = 'gemini-3.7-flash';
const RUNS = 3;

let retries = 0;

/** Retries 429 and 5xx answers: 2 s, 4 s, 8 s. */
async function withRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      const retryable = status === 429 || (typeof status === 'number' && status >= 500);
      if (!retryable || attempt >= 3) throw err;
      retries += 1;
      console.log(`    retrying after ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
    }
  }
}

async function judge(ai: GoogleGenAI, reference: Capture, target: Capture) {
  const started = Date.now();
  const result = await withRetry(() => ai.models.generateContent({
    model: JUDGE_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: reference.png.toString('base64') } },
          { inlineData: { mimeType: 'image/png', data: target.png.toString('base64') } },
          { text: prompt(target.lang, target.pageText, setupOf(target.state)) },
        ],
      },
    ],
    config: { responseMimeType: 'application/json', responseSchema: JUDGE_SCHEMA, temperature: 0 },
  }));
  const parsed = JSON.parse(result.text ?? '{}') as { pass?: boolean; issues?: JudgeIssue[] };
  return { ms: Date.now() - started, pass: parsed.pass, issues: parsed.issues ?? [], usage: result.usageMetadata };
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const ai = new GoogleGenAI({ apiKey });

  const pairs: { label: string; reference: Capture; target: Capture; expect?: string }[] = [];
  for (const state of STATES) {
    const reference = await capture(state, 'en', 'ref');
    for (const lang of ['uk', 'ru', 'zh-Hans'] as Lang[]) {
      pairs.push({ label: `${state.id} ${lang}`, reference, target: await capture(state, lang, 'v2') });
    }
    for (const d of DEFECTS.filter((x) => x.state === state.id)) {
      pairs.push({
        label: `${state.id} ${d.lang} DEFECT "${d.defect.from}" -> "${d.defect.to}"`,
        reference,
        target: await capture(state, d.lang, 'defect', d.defect),
        expect: d.expect,
      });
    }
  }

  const rows: unknown[] = [];
  for (const pair of pairs) {
    const runs = [];
    for (let run = 0; run < RUNS; run++) runs.push(await judge(ai, pair.reference, pair.target));
    // Per run: normalized text -> whether any report of it was a blocker.
    const perRun = runs.map((r) => {
      const seen = new Map<string, boolean>();
      for (const i of r.issues) seen.set(normalize(i.text), (seen.get(normalize(i.text)) ?? false) || i.severity === 'blocker');
      return seen;
    });
    const texts = [...new Set(perRun.flatMap((m) => [...m.keys()]))];
    // Rule A (two judgings): reported in runs 1 and 2, a blocker in at least one.
    const ruleA = texts.filter((t) => perRun[0].has(t) && perRun[1].has(t) && (perRun[0].get(t) || perRun[1].get(t)));
    // Rule B (best of three): reported in at least two runs, a blocker in at least one of them.
    const ruleB = texts.filter((t) => {
      const hits = perRun.filter((m) => m.has(t));
      return hits.length >= 2 && hits.some((m) => m.get(t));
    });
    const caught = (rule: string[]) =>
      pair.expect === undefined ? '' : rule.some((t) => t.includes(normalize(pair.expect!))) ? ' CAUGHT' : ' MISSED';
    rows.push({ label: pair.label, ruleA, ruleB, runs });
    console.log(
      `${pair.label}: blockers per run ${runs.map((r) => r.issues.filter((i) => i.severity === 'blocker').length).join('/')}; ` +
        `rule A ${JSON.stringify(ruleA)}${caught(ruleA)}; rule B ${JSON.stringify(ruleB)}${caught(ruleB)}; ` +
        `ms ${runs.map((r) => r.ms).join('/')}, tokens in=${runs[0].usage?.promptTokenCount} ` +
        `thoughts=${runs.map((r) => r.usage?.thoughtsTokenCount ?? 0).join('/')} out=${runs.map((r) => r.usage?.candidatesTokenCount ?? 0).join('/')}`,
    );
    for (const [n, r] of runs.entries()) {
      for (const i of r.issues) console.log(`    run ${n + 1} [${i.severity}/${i.rubricItem}] "${i.text}" :: ${i.problem}`);
    }
  }
  console.log(`retries: ${retries}`);
  writeFileSync(join(outDir, 'results-v3.json'), JSON.stringify(rows, null, 2));
  console.log(`Wrote ${join(outDir, 'results-v3.json')}`);
}

await main();
