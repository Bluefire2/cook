/**
 * `npm run test:i18n`: the in-context translation review
 * (docs/i18n-review/README.md, docs/plans/i18n-review-ci.md) against a running
 * test-mode server. This step captures; judging and the report come next.
 *
 *   npm run test:i18n -- [--base-url http://localhost:4173] [--states a,b]
 *                        [--langs en,uk] [--out dir] [--repeat 2]
 *
 * `--repeat 2` captures every state twice and fails on any capture that is not
 * byte-identical, the determinism check from the plan. Exits non-zero when a
 * capture fails.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import type { FIXTURE_IDS } from '../fixtures.ts';
import { captureState, type CaptureEnv } from './capture.ts';
import { isLang, LANGS, type Lang } from './catalog.ts';
import { isSkipped, STATES } from './states.ts';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:4173' },
    states: { type: 'string' },
    langs: { type: 'string' },
    out: { type: 'string' },
    repeat: { type: 'string', default: '1' },
  },
});

const baseUrl = values['base-url'].replace(/\/+$/, '');
const repeat = Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) {
  throw new Error(`--repeat must be 1, 2, or 3, not ${values.repeat}`);
}
const langs = (values.langs?.split(',') ?? [...LANGS]).map((value) => value.trim());
const badLang = langs.find((value) => !isLang(value));
if (badLang !== undefined) {
  throw new Error(`Unknown language ${badLang}; use ${LANGS.join(', ')}`);
}
const manifest = JSON.parse(readFileSync(join(repoRoot, 'docs/i18n-review/screens.json'), 'utf8')) as { id: string }[];
const wanted = values.states?.split(',').map((value) => value.trim()) ?? manifest.map((entry) => entry.id);
const unknown = wanted.filter((id) => !Object.hasOwn(STATES, id));
if (unknown.length > 0) {
  throw new Error(`Unknown state ids: ${unknown.join(', ')}`);
}
const date = new Date().toISOString().slice(0, 10);
const outDir = resolve(values.out ?? join(repoRoot, '.i18n-review', date));

async function readEnv(): Promise<CaptureEnv> {
  let personas: { seededAt: number | null; fixtures: typeof FIXTURE_IDS } | undefined;
  for (let attempt = 0; attempt < 60 && personas === undefined; attempt++) {
    const res = await fetch(`${baseUrl}/__test/personas`).catch(() => undefined);
    if (res?.status === 200) {
      personas = (await res.json()) as typeof personas;
    } else {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (personas === undefined) {
    throw new Error(`No test-mode server ready at ${baseUrl} (see testing/README.md)`);
  }
  // The public link's token, read the way the owner's Share sheet reads it.
  const signIn = await fetch(`${baseUrl}/__test/sign-in?as=member`, { redirect: 'manual' });
  const cookie = signIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .find((pair) => pair.startsWith('sous_session='));
  const link = await fetch(`${baseUrl}/api/collections/${personas.fixtures.member.weeknights}/public`, {
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });
  const url = ((await link.json()) as { url?: string }).url ?? '';
  const publicToken = /\/p\/([^/?#]+)$/.exec(url)?.[1];
  if (publicToken === undefined) {
    throw new Error("Couldn't read Weeknights' public link; is the seed intact?");
  }
  if (personas.seededAt === null) {
    console.log('Note: the test server ran with --keep, so relative times are live and captures may differ.');
  }
  return { baseUrl, seededAt: personas.seededAt, ids: personas.fixtures, publicToken };
}

interface Row {
  state: string;
  lang: Lang;
  status: 'ok' | 'failed' | 'skipped' | 'unstable';
  detail?: string;
  sha256?: string;
  ms?: number;
}

async function main(): Promise<void> {
  const env = await readEnv();
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const rows: Row[] = [];
  try {
    for (const state of wanted) {
      const entry = STATES[state];
      for (const lang of langs as Lang[]) {
        if (isSkipped(entry)) {
          rows.push({ state, lang, status: 'skipped', detail: entry.skip });
          continue;
        }
        const results = [];
        for (let run = 0; run < repeat; run++) {
          results.push(await captureState(browser, entry, lang, env));
        }
        const first = results[0];
        const dir = join(outDir, state);
        mkdirSync(dir, { recursive: true });
        if (first.status === 'failed') {
          if (first.png) writeFileSync(join(dir, `${lang}.failed.png`), first.png);
          rows.push({ state, lang, status: 'failed', detail: first.error, ms: first.ms });
          console.log(`FAIL  ${state} ${lang}: ${first.error}`);
          continue;
        }
        writeFileSync(join(dir, `${lang}.png`), first.png);
        writeFileSync(join(dir, `${lang}.txt`), first.pageText);
        const hashes = results.map((r) => (r.status === 'ok' ? r.sha256 : `failed: ${r.error}`));
        const stable = hashes.every((hash) => hash === first.sha256);
        if (!stable) {
          results.forEach((r, n) => {
            if (n > 0 && r.status === 'ok') writeFileSync(join(dir, `${lang}.run${n + 1}.png`), r.png);
          });
        }
        rows.push({
          state,
          lang,
          status: stable ? 'ok' : 'unstable',
          detail: stable ? undefined : `captures differ: ${hashes.map((h) => h.slice(0, 12)).join(' ')}`,
          sha256: first.sha256,
          ms: first.ms,
        });
        console.log(`${stable ? 'ok   ' : 'DIFF '} ${state} ${lang} (${first.ms} ms)`);
      }
    }
  } finally {
    await browser.close();
  }

  writeFileSync(join(outDir, 'captures.json'), JSON.stringify(rows, null, 2));
  const count = (status: Row['status']) => rows.filter((row) => row.status === status).length;
  console.log(
    `\n${count('ok')} captured, ${count('failed')} failed, ${count('unstable')} not deterministic, ` +
      `${count('skipped')} skipped. Output: ${outDir}`,
  );
  process.exitCode = count('failed') + count('unstable') > 0 ? 1 : 0;
}

await main();
