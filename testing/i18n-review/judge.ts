/**
 * The vision judge for the in-context translation review
 * (docs/plans/i18n-review-ci.md, Decisions; step 1 results). One Gemini call
 * per capture pair, a second when the first reports anything, and a finding
 * counts only when both judgings name the same text.
 *
 * The rubric comes from docs/i18n-review/README.md and the register and
 * glossary from docs/constitutions/i18n.md, read at run time, so a change to
 * either reaches the judge without copying.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type GoogleGenAI, Type } from '@google/genai';
import { LANG_NAMES, type Lang } from './catalog.ts';

export const JUDGE_MODEL = 'gemini-3.7-flash';

/** Most judge calls one run may make; the run stops judging at this many. */
export const MAX_JUDGE_CALLS = 500;

/** Judge calls in flight at once. */
export const JUDGE_CONCURRENCY = 4;

export const RUBRIC_ITEMS = [
  'Sense in context',
  'Consistent terms',
  'Grammar across strings',
  'Register',
  'Nothing left in English',
  'Layout',
] as const;
export type RubricItem = (typeof RUBRIC_ITEMS)[number];

export interface JudgeIssue {
  text: string;
  problem: string;
  suggestion: string;
  severity: 'blocker' | 'nit';
  rubricItem: RubricItem;
}

export interface Finding extends JudgeIssue {
  fingerprint: string;
}

export interface Judgment {
  state: string;
  lang: Lang;
  /** `pass`: no confirmed blocker. `budget`: not judged, the run hit MAX_JUDGE_CALLS. */
  status: 'pass' | 'fail' | 'error' | 'budget';
  /** Named in both judgings; a blocker when either judging called it one. */
  confirmed: Finding[];
  /** Named in one judging only. Reported, never filed. */
  unconfirmed: Finding[];
  calls: number;
  error?: string;
}

export interface Shot {
  png: Buffer;
  pageText: string;
}

export interface JudgeTask {
  state: string;
  lang: Lang;
  /** The manifest's `setup` text for the state. */
  setup: string;
  /** The English capture; for the English column itself, the same as `target`. */
  reference: Shot;
  target: Shot;
}

export interface JudgeSources {
  rubric: string;
  glossary: string;
}

/** Only `models.generateContent` is used; fakes implement exactly this. */
export type JudgeAi = { models: Pick<GoogleGenAI['models'], 'generateContent'> };

/** The text from the line matching `start` up to, not including, the next line matching `end`. */
export function sectionOf(text: string, start: RegExp, end: RegExp): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const from = normalized.search(start);
  if (from === -1) {
    throw new Error(`section ${start} not found`);
  }
  const rest = normalized.slice(from);
  const firstLineEnd = rest.indexOf('\n');
  const tail = firstLineEnd === -1 ? '' : rest.slice(firstLineEnd + 1);
  const to = tail.search(end);
  return (to === -1 ? rest : rest.slice(0, firstLineEnd + 1 + to)).trim();
}

export function readSources(repoRoot: string): JudgeSources {
  // Principle 16 also has a "Register and glossary" bullet that only points
  // here; the table is the one under Current decisions.
  const decisions = sectionOf(
    readFileSync(join(repoRoot, 'docs/constitutions/i18n.md'), 'utf8'),
    /^## Current decisions$/m,
    /^## /m,
  );
  return {
    rubric: sectionOf(readFileSync(join(repoRoot, 'docs/i18n-review/README.md'), 'utf8'), /^## Rubric$/m, /^## /m),
    glossary: sectionOf(decisions, /^- \*\*Register and glossary\.\*\*/m, /^- \*\*/m),
  };
}

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Carries a finding across runs and through docs/i18n-review/accepted.json. */
export function fingerprint(state: string, lang: Lang, text: string): string {
  return createHash('sha256').update(`${state}\n${lang}\n${normalizeText(text)}`).digest('hex').slice(0, 16);
}

export const JUDGE_SCHEMA = {
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
          rubricItem: { type: Type.STRING, enum: [...RUBRIC_ITEMS] },
        },
        required: ['text', 'problem', 'suggestion', 'severity', 'rubricItem'],
      },
    },
  },
  required: ['pass', 'issues'],
};

const USER_DATA = `Not app text, so never report it, whatever language it is in: recipe titles, descriptions, ingredients, steps, notes, and tags; collection names; people's names and email addresses; names of connected apps; links and URLs. These are the user's data and stay as the user wrote them. Language names in the language picker are written in their own language on purpose (English, Українська, Русский, 简体中文); that is correct.`;

const LAYOUT_NOTE = `Layout: judge spacing, truncation, and overflow only from the screenshot. The page text below is extracted text and loses the spacing between elements, so never report spacing from it.`;

const QUOTE_NOTE = `For each issue, copy "text" exactly from the page text below, so it can be found in the catalog. Return pass: true and no issues when the screen is fine.`;

/** The prompt for a target language, judged against the English capture. */
export function targetPrompt(task: Pick<JudgeTask, 'lang' | 'setup' | 'target'>, sources: JudgeSources): string {
  const name = LANG_NAMES[task.lang];
  return `You review the UI text of a recipe app, Sous, in ${name} (${task.lang}).

What this screen is, from the review manifest (written for the person capturing it; it names the controls on screen):
"""
${task.setup}
"""

Image 1 is the English screen, for reference. Image 2 is the same screen in ${name}. Judge only image 2, and only the app's own text: labels, buttons, headings, messages, hints.

${USER_DATA}

Apply this rubric:

${sources.rubric}

Register and glossary. Text that uses the glossary's term for a concept is correct, even if the English word looks ambiguous on its own; check the glossary before reporting a word choice:

${sources.glossary}

Severity: "blocker" for app text that is wrong in meaning, ungrammatical, left in English, inconsistent with the glossary, in the wrong register, or visibly cut off or overflowing; "nit" for wording that is correct but could read better.

${LAYOUT_NOTE}

${QUOTE_NOTE}

Page text of image 2:
"""
${task.target.pageText}
"""`;
}

/** The English column of a full run: sense in context and layout only (docs/i18n-review/README.md). */
export function englishPrompt(task: Pick<JudgeTask, 'setup' | 'target'>): string {
  return `You review the UI text of a recipe app, Sous, in English.

What this screen is, from the review manifest (written for the person capturing it; it names the controls on screen):
"""
${task.setup}
"""

The image is the screen. Judge only the app's own text: labels, buttons, headings, messages, hints. Check two things only:
- Sense in context: labels read as one coherent menu, form, or dialog, and each word is the right sense for its control (a verb on an action button, not a noun). rubricItem "Sense in context".
- Layout: no truncation, overflow, clipped buttons, or bad line breaks. rubricItem "Layout".

${USER_DATA}

Severity: "blocker" for text that is wrong in meaning or visibly cut off or overflowing; "nit" for wording that is correct but could read better.

${LAYOUT_NOTE}

${QUOTE_NOTE}

Page text:
"""
${task.target.pageText}
"""`;
}

export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown }).status;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

export interface JudgeDeps {
  ai: JudgeAi;
  sources: JudgeSources;
  /** Waits between retries; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseIssues(text: string | undefined): JudgeIssue[] {
  const parsed = JSON.parse(text ?? '') as { issues?: unknown };
  if (!Array.isArray(parsed.issues)) {
    throw new Error('judge answer has no issues array');
  }
  return parsed.issues.filter(
    (i): i is JudgeIssue =>
      typeof i === 'object' &&
      i !== null &&
      typeof (i as JudgeIssue).text === 'string' &&
      (i as JudgeIssue).text.trim() !== '' &&
      ((i as JudgeIssue).severity === 'blocker' || (i as JudgeIssue).severity === 'nit') &&
      (RUBRIC_ITEMS as readonly string[]).includes((i as JudgeIssue).rubricItem),
  );
}

/** One judging, with three retries on 429 and 5xx (2 s, 4 s, 8 s). */
export async function judgeOnce(task: JudgeTask, deps: JudgeDeps): Promise<JudgeIssue[]> {
  const english = task.lang === 'en';
  const parts = english
    ? [
        { inlineData: { mimeType: 'image/png', data: task.target.png.toString('base64') } },
        { text: englishPrompt(task) },
      ]
    : [
        { inlineData: { mimeType: 'image/png', data: task.reference.png.toString('base64') } },
        { inlineData: { mimeType: 'image/png', data: task.target.png.toString('base64') } },
        { text: targetPrompt(task, deps.sources) },
      ];
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await deps.ai.models.generateContent({
        model: JUDGE_MODEL,
        contents: [{ role: 'user', parts }],
        config: { responseMimeType: 'application/json', responseSchema: JUDGE_SCHEMA, temperature: 0 },
      });
      return parseIssues(result.text);
    } catch (err) {
      if (!isRetryable(err) || attempt >= 3) throw err;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

/**
 * Combines two judgings. A text named in both is confirmed, as a blocker if
 * either called it one; a text named in only one is unconfirmed. The first
 * report of each text supplies its wording.
 */
export function confirm(state: string, lang: Lang, first: JudgeIssue[], second: JudgeIssue[]) {
  const byText = (issues: JudgeIssue[]) => {
    const map = new Map<string, JudgeIssue>();
    for (const issue of issues) {
      const key = normalizeText(issue.text);
      const seen = map.get(key);
      if (seen === undefined || (seen.severity === 'nit' && issue.severity === 'blocker')) {
        map.set(key, issue);
      }
    }
    return map;
  };
  const a = byText(first);
  const b = byText(second);
  const finding = (issue: JudgeIssue, severity = issue.severity): Finding => ({
    ...issue,
    severity,
    fingerprint: fingerprint(state, lang, issue.text),
  });
  const confirmed: Finding[] = [];
  const unconfirmed: Finding[] = [];
  for (const [key, issue] of a) {
    const other = b.get(key);
    if (other === undefined) {
      unconfirmed.push(finding(issue));
    } else {
      confirmed.push(finding(issue, issue.severity === 'blocker' || other.severity === 'blocker' ? 'blocker' : 'nit'));
    }
  }
  for (const [key, issue] of b) {
    if (!a.has(key)) unconfirmed.push(finding(issue));
  }
  return { confirmed, unconfirmed };
}

/** Counts judge calls against MAX_JUDGE_CALLS across concurrent tasks. */
export class CallBudget {
  used = 0;
  readonly limit: number;

  constructor(limit = MAX_JUDGE_CALLS) {
    this.limit = limit;
  }

  take(): boolean {
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }
}

export async function judgePair(task: JudgeTask, deps: JudgeDeps, budget: CallBudget): Promise<Judgment> {
  const base = { state: task.state, lang: task.lang, confirmed: [], unconfirmed: [] };
  if (!budget.take()) {
    return { ...base, status: 'budget', calls: 0 };
  }
  let first: JudgeIssue[];
  try {
    first = await judgeOnce(task, deps);
  } catch (err) {
    return { ...base, status: 'error', calls: 1, error: errorText(err) };
  }
  if (first.length === 0) {
    return { ...base, status: 'pass', calls: 1 };
  }
  if (!budget.take()) {
    // No second judging, so nothing is confirmed; keep what the first one said.
    const { unconfirmed } = confirm(task.state, task.lang, first, []);
    return { ...base, status: 'budget', calls: 1, unconfirmed };
  }
  let second: JudgeIssue[];
  try {
    second = await judgeOnce(task, deps);
  } catch (err) {
    return { ...base, status: 'error', calls: 2, error: errorText(err) };
  }
  const { confirmed, unconfirmed } = confirm(task.state, task.lang, first, second);
  return {
    ...base,
    status: confirmed.some((f) => f.severity === 'blocker') ? 'fail' : 'pass',
    confirmed,
    unconfirmed,
    calls: 2,
  };
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}

/** Judges every task, JUDGE_CONCURRENCY at a time, in task order in the result. */
export async function judgeAll(
  tasks: JudgeTask[],
  deps: JudgeDeps,
  budget = new CallBudget(),
  onDone?: (judgment: Judgment) => void,
): Promise<Judgment[]> {
  const results: Judgment[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await judgePair(tasks[index], deps, budget);
      onDone?.(results[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(JUDGE_CONCURRENCY, tasks.length) }, worker));
  return results;
}
