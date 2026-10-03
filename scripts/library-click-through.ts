/**
 * Local click-through of Library search persistence and collection switching
 * (issue #57). Not part of `npm test` or CI.
 *
 * Run:
 *   1. `npm run dev` and `npm run dev:api`.
 *   2. Once: put your account in `.env.local` as `SOUS_E2E_SUB=...` and
 *      `SOUS_E2E_EMAIL=...` (signed in at http://localhost:5173, open
 *      /api/auth/session and copy `sub` and `email`). Neither is a secret.
 *   3. `npm run click:library` (add `-- --headed` to watch).
 *
 * Each run signs a one-hour `sous_session` with the `SESSION_SECRET` from
 * `.env.local`, the same signing code the server uses, and keeps it in memory
 * and in a throwaway browser context only. It is never printed or written.
 *
 * Dev talks to real Firestore, so the script aborts every non-GET `/api`
 * request (sign-out excepted, last step) and fails if any was attempted. The
 * library needs at least one owned collection and one recipe; nothing is
 * created to satisfy that.
 *
 * Uses the installed Chrome. Where `PLAYWRIGHT_BROWSERS_PATH` is set, uses
 * the bundled Chromium instead.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { SESSION_COOKIE_NAME, signSession } from '../server/session.ts';

const BASE = 'http://localhost:5173';
const STORAGE_KEY = 'cook.librarySearch';
const SEARCH_ALL_PLACEHOLDER = 'Search all recipes…';
const SESSION_TTL_MS = 60 * 60 * 1000;

type StoredView = { query?: unknown; browseAll?: unknown } | null;

class Precondition extends Error {}

type Account = { sub: string; email: string };

function readAccount(): Account {
  const sub = process.env.SOUS_E2E_SUB?.trim() ?? '';
  const email = process.env.SOUS_E2E_EMAIL?.trim() ?? '';
  if (sub === '' || email === '') {
    throw new Precondition(
      'Set SOUS_E2E_SUB and SOUS_E2E_EMAIL in .env.local: sign in at http://localhost:5173, ' +
        'open /api/auth/session, and copy `sub` and `email`. Run with `npm run click:library`.',
    );
  }
  if (!process.env.SESSION_SECRET?.trim()) {
    throw new Precondition('SESSION_SECRET is not set. Run with `npm run click:library`.');
  }
  return { sub, email };
}

/** A short session for this run only, signed like the server signs one. */
function mintSession(account: Account): string {
  return signSession(account, Date.now(), SESSION_TTL_MS);
}

async function waitUntil(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function searchBox(page: Page) {
  return page.locator('input[type="search"]');
}

function chip(page: Page, href: string) {
  return page.locator(`section[aria-labelledby="collections-label"] a[href="${href}"]`);
}

function firstRecipeLink(page: Page) {
  return page.locator('ul li a[href^="/recipe/"]:not([href$="/edit"])').first();
}

function renameButton(page: Page) {
  return page.getByRole('button', { name: 'Rename', exact: true });
}

function allCollectionsButton(page: Page) {
  return page.getByRole('button', { name: 'All collections', exact: true });
}

async function stored(page: Page): Promise<StoredView> {
  const raw = (await page.evaluate(`sessionStorage.getItem('${STORAGE_KEY}')`)) as string | null;
  return raw === null ? null : (JSON.parse(raw) as StoredView);
}

async function clearStored(page: Page): Promise<void> {
  await page.evaluate(`sessionStorage.removeItem('${STORAGE_KEY}')`);
}

function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}

async function waitForPath(page: Page, path: string): Promise<void> {
  await waitUntil(`URL path is ${path} (now ${pathOf(page)})`, async () => pathOf(page) === path);
}

/** The search box is up, recipes have loaded, and the collection row is shown. */
async function waitForLibrary(page: Page): Promise<void> {
  await searchBox(page).waitFor({ state: 'visible' });
  await page.getByText('Loading recipes…').waitFor({ state: 'detached' });
  await page.locator('section[aria-labelledby="collections-label"]').waitFor({ state: 'visible' });
}

async function openLibrary(page: Page, path: string): Promise<void> {
  await page.goto(BASE + path);
  await waitForLibrary(page);
}

async function expectBox(page: Page, value: string, where: string): Promise<void> {
  await waitUntil(`search box holds ${JSON.stringify(value)} ${where}`, async () =>
    (await searchBox(page).inputValue()) === value,
  );
}

async function hasRecipeCard(page: Page): Promise<boolean> {
  return (await firstRecipeLink(page).count()) > 0;
}

type Fixture = { a: string; b: string; query: string; recipeList: string };

/** Read-only: pick an owned collection A, another list B, a query, and a list with a recipe. */
async function discover(page: Page): Promise<Fixture> {
  // A fresh context has nothing stored, and about:blank has no sessionStorage.
  await openLibrary(page, '/');
  const chipLinks = await page
    .locator('section[aria-labelledby="collections-label"] a[href^="/collections/"]')
    .all();
  const chips: string[] = [];
  for (const link of chipLinks) {
    const href = await link.getAttribute('href');
    if (href !== null) chips.push(href);
  }
  if (chips.length === 0) {
    throw new Precondition('precondition not met: needs at least one collection');
  }

  let a: string | undefined;
  let recipeList: string | undefined = (await hasRecipeCard(page)) ? '/' : undefined;
  for (const href of chips) {
    await openLibrary(page, href);
    if (a === undefined && (await renameButton(page).count()) > 0) a = href;
    if (recipeList === undefined && (await hasRecipeCard(page))) recipeList = href;
    if (a !== undefined && recipeList !== undefined) break;
  }
  if (a === undefined) {
    throw new Precondition('precondition not met: needs a collection you own (shows Rename)');
  }
  if (recipeList === undefined) {
    throw new Precondition('precondition not met: needs a recipe in some list');
  }
  const b = chips.find((href) => href !== a) ?? '/';

  await openLibrary(page, '/');
  await allCollectionsButton(page).click();
  await firstRecipeLink(page).waitFor({ state: 'visible' });
  const title = await firstRecipeLink(page).locator('h2').innerText();
  const word = /\p{L}{3,}/u.exec(title)?.[0];
  if (word === undefined) {
    throw new Precondition('precondition not met: the first recipe title has no 3-letter word');
  }
  await allCollectionsButton(page).click();
  await clearStored(page);
  return { a, b, query: word.toLowerCase(), recipeList };
}

async function flowChipChanges(page: Page, f: Fixture): Promise<void> {
  await clearStored(page);
  await openLibrary(page, '/');
  await searchBox(page).fill(f.query);
  const route = f.b === '/' ? [f.a, '/'] : [f.b, f.a, '/'];
  for (const href of route) {
    await chip(page, href).click();
    await waitForPath(page, href);
    await expectBox(page, f.query, `after switching to ${href}`);
    const view = await stored(page);
    if (view?.query !== f.query) throw new Error(`stored query lost after switching to ${href}`);
  }
}

async function flowLeaveLibrary(page: Page, f: Fixture): Promise<void> {
  await clearStored(page);
  await openLibrary(page, '/');
  await searchBox(page).fill(f.query);
  await allCollectionsButton(page).click();
  await waitUntil('placeholder says all recipes', async () =>
    (await searchBox(page).getAttribute('placeholder')) === SEARCH_ALL_PLACEHOLDER,
  );
  await waitUntil('query and All collections stored before opening a recipe', async () => {
    const view = await stored(page);
    return view?.query === f.query && view.browseAll === true;
  });
  await firstRecipeLink(page).click();
  await waitUntil('recipe opened', async () => pathOf(page).startsWith('/recipe/'));
  await page.goBack();
  await waitForPath(page, '/');
  await waitForLibrary(page);
  await expectBox(page, f.query, 'after Back from the recipe');
  await waitUntil('All collections scope restored', async () =>
    (await searchBox(page).getAttribute('placeholder')) === SEARCH_ALL_PLACEHOLDER,
  );
  const after = await stored(page);
  if (after?.query !== f.query || after.browseAll !== true) {
    throw new Error('stored view changed after Back from the recipe');
  }
}

async function flowClearingSticks(page: Page, f: Fixture): Promise<void> {
  await clearStored(page);
  await openLibrary(page, f.recipeList);
  await searchBox(page).fill(f.query);
  await waitUntil('query stored', async () => (await stored(page))?.query === f.query);
  await searchBox(page).fill('');
  await waitUntil('key removed after clearing', async () => (await stored(page)) === null);
  await firstRecipeLink(page).click();
  await waitUntil('recipe opened', async () => pathOf(page).startsWith('/recipe/'));
  await page.goBack();
  await waitForPath(page, f.recipeList);
  await waitForLibrary(page);
  await expectBox(page, '', 'after Back from the recipe');
  if ((await stored(page)) !== null) throw new Error('key came back after Back from the recipe');
}

async function expectNoDialog(page: Page, where: string): Promise<void> {
  // The reset runs in a layout effect; give a late paint time to show up.
  await page.waitForTimeout(500);
  const open = await page.getByRole('dialog').count();
  if (open !== 0) throw new Error(`a sheet is open ${where}`);
}

async function flowNoSheetCarryOver(page: Page, f: Fixture): Promise<void> {
  await clearStored(page);
  await openLibrary(page, f.b);
  await chip(page, f.a).click();
  await waitForPath(page, f.a);
  await renameButton(page).click();
  await page.getByRole('dialog').waitFor({ state: 'visible' });
  await page.goBack();
  await waitForPath(page, f.b);
  await waitForLibrary(page);
  await expectNoDialog(page, `after Back to ${f.b}`);
  await page.goForward();
  await waitForPath(page, f.a);
  await waitForLibrary(page);
  await expectNoDialog(page, `after Forward to ${f.a}`);
}

async function flowSignOut(page: Page, f: Fixture, allowSignOut: () => void): Promise<void> {
  await clearStored(page);
  await openLibrary(page, '/');
  await searchBox(page).fill(f.query);
  await waitUntil('query stored', async () => (await stored(page))?.query === f.query);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await waitForPath(page, '/settings');
  if ((await stored(page))?.query !== f.query) throw new Error('key gone before sign-out');
  allowSignOut();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await waitUntil('key removed after sign-out', async () => (await stored(page)) === null);
}

/** Abort every write so a broken flow cannot change the real library. */
async function guardWrites(context: BrowserContext): Promise<{
  blocked: string[];
  allowSignOut: () => void;
}> {
  const blocked: string[] = [];
  let signOutAllowed = false;
  await context.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const method = request.method();
      const path = new URL(request.url()).pathname;
      if (method === 'GET' || method === 'HEAD') return route.continue();
      if (signOutAllowed && method === 'POST' && path === '/api/auth/signout') {
        return route.continue();
      }
      blocked.push(`${method} ${path}`);
      return route.abort('blockedbyclient');
    },
  );
  context.on('request', (request) => {
    const method = request.method();
    const path = new URL(request.url()).pathname;
    if (method !== 'GET' && method !== 'HEAD' && !path.startsWith('/api/')) {
      blocked.push(`${method} ${path} (not aborted)`);
    }
  });
  return { blocked, allowSignOut: () => (signOutAllowed = true) };
}

async function preflight(context: BrowserContext): Promise<void> {
  let response;
  try {
    response = await context.request.get(`${BASE}/api/auth/session`);
  } catch {
    throw new Precondition(`${BASE} is not answering. Start \`npm run dev\`.`);
  }
  let user: unknown = null;
  try {
    user = ((await response.json()) as { user?: unknown }).user ?? null;
  } catch {
    throw new Precondition(
      `/api/auth/session answered ${response.status()} without JSON. Start \`npm run dev:api\`.`,
    );
  }
  if (user === null) {
    throw new Precondition(
      'The session was not accepted. Check that `npm run dev:api` runs with the same ' +
        '.env.local and that SOUS_E2E_SUB and SOUS_E2E_EMAIL are an admitted account.',
    );
  }
}

async function main(): Promise<number> {
  const account = readAccount();
  const headed = process.argv.includes('--headed') || process.env.SOUS_E2E_HEADED === '1';
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }),
    headless: !headed,
    slowMo: headed ? 150 : 0,
  });
  let current = 'setup';
  let page: Page | undefined;
  try {
    const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: mintSession(account),
        url: BASE,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const guard = await guardWrites(context);
    await preflight(context);
    const p = await context.newPage();
    page = p;
    p.setDefaultTimeout(15_000);

    current = 'discovery';
    const fixture = await discover(p);
    console.log(`fixture: A=${fixture.a} B=${fixture.b} recipes in ${fixture.recipeList}`);

    const flows: [string, () => Promise<void>][] = [
      ['1. Search survives chip changes', () => flowChipChanges(p, fixture)],
      ['2. Search survives leaving the library', () => flowLeaveLibrary(p, fixture)],
      ['3. Clearing sticks', () => flowClearingSticks(p, fixture)],
      ['4. No sheet carry-over', () => flowNoSheetCarryOver(p, fixture)],
      ['5. Sign-out clears it', () => flowSignOut(p, fixture, guard.allowSignOut)],
    ];
    for (const [name, run] of flows) {
      current = name;
      await run();
      if (guard.blocked.length > 0) {
        throw new Error(`blocked writes: ${guard.blocked.join(', ')}`);
      }
      console.log(`✓ ${name}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof Precondition) {
      console.error(error.message);
      return 2;
    }
    console.error(`✗ ${current}: ${error instanceof Error ? error.message : String(error)}`);
    if (page !== undefined) {
      const shot = join(tmpdir(), 'sous-library-click-through.png');
      try {
        await page.screenshot({ path: shot, fullPage: true });
        console.error(`screenshot: ${shot}`);
      } catch {
        // the page may already be gone
      }
    }
    return 1;
  } finally {
    await browser.close();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  if (error instanceof Precondition) {
    console.error(error.message);
    return 2;
  }
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
});
