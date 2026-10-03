import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Content, type GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { describe, expect, it } from 'vitest';
import {
  CallBudget,
  confirm,
  englishPrompt,
  fingerprint,
  type JudgeAi,
  type JudgeIssue,
  type JudgeTask,
  judgeAll,
  judgePair,
  readSources,
  sectionOf,
  targetPrompt,
} from './judge.ts';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sources = readSources(repoRoot);

const shot = (pageText: string) => ({ png: Buffer.from('png'), pageText });
const task = (lang: JudgeTask['lang'] = 'uk'): JudgeTask => ({
  state: 'settings',
  lang,
  setup: 'Settings while signed in.',
  reference: shot('Settings'),
  target: shot(lang === 'en' ? 'Settings' : 'Налаштування'),
});
const issue = (text: string, severity: JudgeIssue['severity'] = 'blocker'): JudgeIssue => ({
  text,
  problem: 'p',
  suggestion: 's',
  severity,
  rubricItem: 'Nothing left in English',
});

/** A judge client that answers each call with the next scripted reply; an Error rejects. */
function scriptedAi(replies: (JudgeIssue[] | string | Error)[]) {
  const calls: GenerateContentParameters[] = [];
  const ai: JudgeAi = {
    models: {
      generateContent: (params) => {
        calls.push(params);
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
        if (reply instanceof Error) return Promise.reject(reply);
        const response = new GenerateContentResponse();
        const text = typeof reply === 'string' ? reply : JSON.stringify({ pass: reply.length === 0, issues: reply });
        response.candidates = [{ content: { role: 'model', parts: [{ text }] } }];
        return Promise.resolve(response);
      },
    },
  };
  return { ai, calls };
}

const noSleep = () => Promise.resolve();

describe('judge sources', () => {
  it('reads the rubric from the review README and the glossary from the constitution', () => {
    expect(sources.rubric).toMatch(/^## Rubric/);
    expect(sources.rubric).toContain('**Sense in context.**');
    expect(sources.rubric).toContain('**Layout.**');
    expect(sources.rubric).not.toContain('## When it runs');
    expect(sources.glossary).toMatch(/^- \*\*Register and glossary\.\*\*/);
    expect(sources.glossary).toContain('| English | `uk` | `ru` | `zh-Hans` |');
    expect(sources.glossary).not.toContain('**In-context review delivery.**');
  });

  it('stops a section at the next match after its first line', () => {
    const text = '# A\nintro\n## Rubric\none\n## Next\ntwo';
    expect(sectionOf(text, /^## Rubric$/m, /^## /m)).toBe('## Rubric\none');
    expect(sectionOf(text, /^## Next$/m, /^## /m)).toBe('## Next\ntwo');
    expect(() => sectionOf(text, /^## Missing$/m, /^## /m)).toThrow();
  });
});

describe('prompts', () => {
  it('gives a target-language judging the manifest setup, the sources, and the page text', () => {
    const prompt = targetPrompt(task('ru'), sources);
    expect(prompt).toContain('in Russian (ru)');
    expect(prompt).toContain('Settings while signed in.');
    expect(prompt).toContain(sources.rubric);
    expect(prompt).toContain(sources.glossary);
    expect(prompt).toContain('collection names');
    expect(prompt).toContain('only from the screenshot');
    expect(prompt).toContain('Налаштування');
  });

  it('limits the English column to sense in context and layout', () => {
    const prompt = englishPrompt(task('en'));
    expect(prompt).toContain('Check two things only');
    expect(prompt).not.toContain('Register and glossary');
  });

  it('sends two images for a target language and one for English', async () => {
    for (const [lang, images] of [['uk', 2], ['en', 1]] as const) {
      const { ai, calls } = scriptedAi([[]]);
      await judgePair(task(lang), { ai, sources, sleep: noSleep }, new CallBudget());
      const parts = (calls[0].contents as Content[])[0].parts ?? [];
      expect(parts.filter((p) => p.inlineData !== undefined)).toHaveLength(images);
      expect(calls[0].config?.temperature).toBe(0);
    }
  });
});

describe('confirm', () => {
  it('confirms a text both judgings name, as a blocker if either called it one', () => {
    const { confirmed, unconfirmed } = confirm('s', 'uk', [issue('Save', 'nit')], [issue(' save ', 'blocker')]);
    expect(confirmed.map((f) => [f.text, f.severity])).toEqual([['Save', 'blocker']]);
    expect(unconfirmed).toEqual([]);
  });

  it('keeps a text both call a nit as a nit', () => {
    const { confirmed } = confirm('s', 'uk', [issue('A', 'nit')], [issue('a', 'nit')]);
    expect(confirmed.map((f) => f.severity)).toEqual(['nit']);
  });

  it('leaves a text only one judging names unconfirmed', () => {
    const { confirmed, unconfirmed } = confirm('s', 'uk', [issue('A')], [issue('B')]);
    expect(confirmed).toEqual([]);
    expect(unconfirmed.map((f) => f.text).sort()).toEqual(['A', 'B']);
  });

  it('fingerprints by state, language, and normalized text', () => {
    expect(fingerprint('s', 'uk', ' Save  now ')).toBe(fingerprint('s', 'uk', 'save now'));
    expect(fingerprint('s', 'uk', 'Save')).not.toBe(fingerprint('s', 'ru', 'Save'));
    expect(fingerprint('s', 'uk', 'Save')).not.toBe(fingerprint('t', 'uk', 'Save'));
  });
});

describe('judgePair', () => {
  it('passes a clean screen with one call', async () => {
    const { ai, calls } = scriptedAi([[]]);
    const judgment = await judgePair(task(), { ai, sources, sleep: noSleep }, new CallBudget());
    expect(judgment).toMatchObject({ status: 'pass', calls: 1, confirmed: [], unconfirmed: [] });
    expect(calls).toHaveLength(1);
  });

  it('fails on a blocker both judgings name', async () => {
    const { ai } = scriptedAi([[issue('Save')], [issue('Save', 'nit')]]);
    const judgment = await judgePair(task(), { ai, sources, sleep: noSleep }, new CallBudget());
    expect(judgment.status).toBe('fail');
    expect(judgment.calls).toBe(2);
    expect(judgment.confirmed[0]).toMatchObject({ text: 'Save', severity: 'blocker' });
  });

  it('passes when the second judging does not repeat the first', async () => {
    const { ai } = scriptedAi([[issue('Приготування')], []]);
    const judgment = await judgePair(task(), { ai, sources, sleep: noSleep }, new CallBudget());
    expect(judgment.status).toBe('pass');
    expect(judgment.unconfirmed.map((f) => f.text)).toEqual(['Приготування']);
  });

  it('drops malformed issues and reports an unparseable answer as an error', async () => {
    const half = scriptedAi([JSON.stringify({ pass: false, issues: [{ text: '', severity: 'blocker' }, issue('X')] }), [issue('X')]]);
    const judged = await judgePair(task(), { ai: half.ai, sources, sleep: noSleep }, new CallBudget());
    expect(judged.confirmed.map((f) => f.text)).toEqual(['X']);
    const broken = scriptedAi(['not json']);
    expect(await judgePair(task(), { ai: broken.ai, sources, sleep: noSleep }, new CallBudget())).toMatchObject({
      status: 'error',
      calls: 1,
    });
  });

  it('retries 429 and 5xx, but not other errors', async () => {
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const flaky = scriptedAi([Object.assign(new Error('busy'), { status: 503 }), []]);
    expect((await judgePair(task(), { ai: flaky.ai, sources, sleep }, new CallBudget())).status).toBe('pass');
    expect(waits).toEqual([2000]);
    const bad = scriptedAi([Object.assign(new Error('bad request'), { status: 400 })]);
    expect((await judgePair(task(), { ai: bad.ai, sources, sleep }, new CallBudget())).status).toBe('error');
    expect(bad.calls).toHaveLength(1);
  });

  it('stops at the call budget, keeping an unconfirmed first judging', async () => {
    const budget = new CallBudget(1);
    const { ai } = scriptedAi([[issue('Save')]]);
    const first = await judgePair(task(), { ai, sources, sleep: noSleep }, budget);
    expect(first).toMatchObject({ status: 'budget', calls: 1 });
    expect(first.unconfirmed.map((f) => f.text)).toEqual(['Save']);
    expect(await judgePair(task(), { ai, sources, sleep: noSleep }, budget)).toMatchObject({ status: 'budget', calls: 0 });
  });
});

describe('judgeAll', () => {
  it('returns judgments in task order and never exceeds the budget', async () => {
    const { ai, calls } = scriptedAi([[]]);
    const tasks = Array.from({ length: 10 }, (_, i) => ({ ...task(), state: `s${i}` }));
    const judgments = await judgeAll(tasks, { ai, sources, sleep: noSleep }, new CallBudget(7));
    expect(judgments.map((j) => j.state)).toEqual(tasks.map((t) => t.state));
    expect(calls).toHaveLength(7);
    expect(judgments.filter((j) => j.status === 'budget')).toHaveLength(3);
  });
});

it('reads its sources from paths that exist', () => {
  expect(() => readSources(join(repoRoot))).not.toThrow();
});
