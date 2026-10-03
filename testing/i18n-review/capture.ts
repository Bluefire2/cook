/**
 * Captures one manifest state in one language against a running test-mode
 * server: a fresh browser context, signed in as the state's persona, at
 * phone width (docs/i18n-review/README.md: 390×844), with the UI language set
 * through `cook.locale`.
 *
 * Captures are deterministic (step 1 of docs/plans/i18n-review-ci.md): CSS
 * animations finish, the caret is hidden, fonts are loaded, and the browser
 * clock is frozen relative to the seed so "3 days ago" reads the same on
 * every run.
 */
import { createHash } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { label, type Lang } from './catalog.ts';
import { MOCKS } from './mocks.ts';
import type { FIXTURE_IDS } from '../fixtures.ts';
import type { Capturable, CaptureContext } from './states.ts';

export const VIEWPORT = { width: 390, height: 844 };

/**
 * How long to wait for the network to go quiet. Best-effort: the public page
 * leaves a 404's body unread, so Chromium keeps that request open and
 * "network idle" never comes. Each state's `reach` waits for what it needs,
 * and `--repeat 2` catches a capture taken too early.
 */
const NETWORK_IDLE_MS = 10_000;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => undefined);
}

/** Captures read as if taken this long after the seed, whenever they run. */
const CLOCK_AFTER_SEED_MS = 10 * 60 * 1000;

export interface CaptureEnv {
  baseUrl: string;
  /** From `/__test/personas`; null after `dev:test --keep`, which leaves relative times live. */
  seededAt: number | null;
  ids: CaptureContext['ids'];
  publicToken: string;
}

export interface CaptureOk {
  status: 'ok';
  png: Buffer;
  pageText: string;
  sha256: string;
  ms: number;
}

export interface CaptureFailed {
  status: 'failed';
  error: string;
  /** What the page looked like when it failed, when a screenshot was possible. */
  png?: Buffer;
  ms: number;
}

/** Waits for the test-mode seed, then reads what captures need from it. */
export async function readCaptureEnv(baseUrl: string): Promise<CaptureEnv> {
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

export function contextFor(lang: Lang, env: CaptureEnv): CaptureContext {
  return {
    lang,
    t: (key, params) => label(lang, key, params),
    ids: env.ids,
    publicToken: env.publicToken,
  };
}

export async function captureState(
  browser: Browser,
  entry: Capturable,
  lang: Lang,
  env: CaptureEnv,
): Promise<CaptureOk | CaptureFailed> {
  const started = Date.now();
  const ctx = contextFor(lang, env);
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    timezoneId: 'UTC',
    locale: 'en-US',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  try {
    if (env.seededAt !== null) {
      await context.clock.setFixedTime(new Date(env.seededAt + CLOCK_AFTER_SEED_MS));
    }
    await context.addInitScript((locale) => {
      localStorage.setItem('cook.locale', locale);
    }, lang);
    for (const mock of entry.mocks ?? []) {
      await MOCKS[mock](context);
    }

    const path = typeof entry.path === 'function' ? entry.path(ctx) : entry.path;
    const url =
      entry.persona === 'signedOut'
        ? `${env.baseUrl}${path}`
        : `${env.baseUrl}/__test/sign-in?as=${entry.persona}&returnTo=${encodeURIComponent(path)}`;
    await page.goto(url);
    await settle(page);
    if (entry.reach) {
      await entry.reach(page, ctx);
      await settle(page);
    }
    await page.evaluate('document.fonts.ready');
    const png = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
    const pageText = await page.locator('body').innerText();
    return {
      status: 'ok',
      png,
      pageText,
      sha256: createHash('sha256').update(png).digest('hex'),
      ms: Date.now() - started,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message.split('\n')[0] : String(err);
    const png = await page.screenshot({ fullPage: true }).catch(() => undefined);
    return { status: 'failed', error, png, ms: Date.now() - started };
  } finally {
    await context.close();
  }
}
