/**
 * How the review reaches each state in docs/i18n-review/screens.json, in test
 * mode (docs/plans/i18n-review-ci.md, States). The manifest's `setup` text is
 * the description for people and for the judge; this file is the script.
 * states.test.ts keeps the two in step: every manifest id has an entry here.
 */
import type { Page } from 'playwright';
import type { FIXTURE_IDS } from '../fixtures.ts';
import type { PersonaName } from '../personas.ts';
import type { Lang, MessageKey } from './catalog.ts';
import type { MockName } from './mocks.ts';

export interface CaptureContext {
  lang: Lang;
  /** The catalog label for `key` in `lang`. */
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  ids: typeof FIXTURE_IDS;
  /** The token of member's public Weeknights link. */
  publicToken: string;
}

export interface Capturable {
  persona: PersonaName | 'signedOut';
  path: string | ((ctx: CaptureContext) => string);
  /** Steps after the page loads: open a sheet, check a box. Never a write unless the state needs one. */
  reach?: (page: Page, ctx: CaptureContext) => Promise<void>;
  mocks?: MockName[];
}

export const SKIP_REASONS = ['needs stored photos', 'needs a real Google sign-in', 'not scripted yet'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type StateEntry = Capturable | { skip: SkipReason };

export function isSkipped(entry: StateEntry): entry is { skip: SkipReason } {
  return 'skip' in entry;
}

async function clickButton(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).first().click();
}

/** A 64×64 PNG for the photo picker, so no file is checked in. */
async function photoFile(page: Page): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const buffer = Buffer.from(
    (await page.evaluate(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const g = canvas.getContext('2d');
      g.fillStyle = '#c47a3a';
      g.fillRect(0, 0, 64, 64);
      return canvas.toDataURL('image/png').split(',')[1];
    })()`)) as string,
    'base64',
  );
  return { name: 'note.png', mimeType: 'image/png', buffer };
}

async function extractClean(page: Page, ctx: CaptureContext): Promise<void> {
  await page.locator('textarea').fill('https://example.com/spring-pea-soup');
  await clickButton(page, ctx.t('import.extractRecipe'));
  await page.getByRole('button', { name: ctx.t('common.save'), exact: true }).first().waitFor();
}

async function selectAllInCollection(page: Page, ctx: CaptureContext): Promise<void> {
  await clickButton(page, ctx.t('library.select'));
  await page.getByRole('checkbox', { name: ctx.t('library.selectRecipe', { title: 'Lemon garlic roast chicken' }) }).check();
  await page.getByLabel(ctx.t('library.selectAll'), { exact: true }).check();
}

const weeknights = (ctx: CaptureContext) => `/collections/${ctx.ids.member.weeknights}`;
const baking = (ctx: CaptureContext) => `/collections/${ctx.ids.member.baking}`;

export const STATES: Record<string, StateEntry> = {
  'library-empty': { persona: 'empty', path: '/' },
  'library-collections-empty': { persona: 'empty', path: '/' },
  'collections-index': { persona: 'member', path: '/collections' },
  'library-populated': { persona: 'member', path: '/' },
  'library-select': { persona: 'member', path: weeknights, reach: selectAllInCollection },
  'library-move-many': {
    persona: 'member',
    path: weeknights,
    reach: async (page, ctx) => {
      await selectAllInCollection(page, ctx);
      await clickButton(page, ctx.t('library.moveSelected'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'library-invite-confirm': {
    persona: 'member',
    path: '/',
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('library.inviteLink'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'library-invite-copied': { skip: 'not scripted yet' },
  'library-invite-copy-failed': { skip: 'not scripted yet' },
  'library-invite-quota': { skip: 'not scripted yet' },
  settings: { persona: 'member', path: '/settings' },
  suggest: {
    persona: 'member',
    path: '/suggest',
    reach: async (page, ctx) => {
      await page.getByText(ctx.t('suggest.included'), { exact: true }).click();
    },
  },
  'suggest-sent': { skip: 'not scripted yet' },
  'suggest-signed-out': { persona: 'signedOut', path: '/suggest' },
  'settings-invite-link': { skip: 'not scripted yet' },
  'settings-connected-apps-empty': { persona: 'empty', path: '/settings' },
  'settings-connected-apps-list': { persona: 'member', path: '/settings' },
  'settings-connected-apps-disconnect-error': { skip: 'not scripted yet' },
  admin: { persona: 'owner', path: '/admin' },
  'library-add-sheet': {
    persona: 'member',
    path: '/',
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('library.addRecipe'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'library-language-menu': {
    persona: 'member',
    path: '/',
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('library.languageMenu'));
      await page.locator('[aria-expanded="true"]').waitFor();
    },
  },
  'import-idle': { persona: 'member', path: '/import' },
  'import-photos': {
    persona: 'member',
    path: '/import',
    reach: async (page) => {
      await page.locator('input[type="file"]').first().setInputFiles(await photoFile(page));
      await page.locator('img').first().waitFor();
    },
  },
  'import-bulk': {
    persona: 'member',
    path: '/import',
    reach: async (page, ctx) => {
      // The label holds the hint too, so the name only starts with "Bulk import".
      await page.getByRole('checkbox', { name: ctx.t('import.bulk') }).check();
    },
  },
  'import-preview': { persona: 'member', path: '/import', mocks: ['importClean'], reach: extractClean },
  'import-preview-guessed-language': { skip: 'not scripted yet' },
  'import-preview-translate-on': { skip: 'not scripted yet' },
  'import-preview-translate-failed': { skip: 'not scripted yet' },
  'import-preview-pasted-hint': { skip: 'not scripted yet' },
  'import-bulk-translate': {
    persona: 'member',
    path: '/import',
    reach: async (page, ctx) => {
      // The label holds the hint too, so the name only starts with "Bulk import".
      await page.getByRole('checkbox', { name: ctx.t('import.bulk') }).check();
    },
  },
  'import-preview-warnings': { skip: 'not scripted yet' },
  'import-error-model-failed': { skip: 'not scripted yet' },
  'import-bulk-summary': { skip: 'not scripted yet' },
  'import-failed-feedback': { skip: 'not scripted yet' },
  'import-preview-feedback': { skip: 'not scripted yet' },
  'import-preview-rating': { skip: 'not scripted yet' },
  'import-bulk-feedback': { skip: 'not scripted yet' },
  'recipe-view-translate-labelled': {
    persona: 'member',
    // A recipe whose language label differs from the UI language.
    path: (ctx) => `/recipe/${ctx.lang === 'uk' ? ctx.ids.member.eggTarts : ctx.ids.member.borscht}`,
  },
  'recipe-view-translate-unlabelled': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.overnightOats}` },
  'recipe-view-translate-loading': { skip: 'not scripted yet' },
  'recipe-view-translate-translated': { skip: 'not scripted yet' },
  'recipe-view-translate-error': { skip: 'not scripted yet' },
  'recipe-view-translate-already': { skip: 'not scripted yet' },
  'recipe-view': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.tomatoPasta}` },
  'recipe-view-import-warnings': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.bananaBread}` },
  'recipe-view-import-retry-sheet': { skip: 'not scripted yet' },
  'recipe-view-cook': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.roastChicken}` },
  'recipe-view-your-cooks': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.roastChicken}` },
  'recipe-edit': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.tomatoPasta}/edit` },
  'recipe-edit-lang-hint': { skip: 'not scripted yet' },
  'recipe-new': { persona: 'member', path: '/recipe/new' },
  'recipe-chat': { skip: 'not scripted yet' },
  'share-collection-sheet': {
    persona: 'member',
    path: baking,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('common.share'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'share-collection-sheet-links': {
    persona: 'member',
    path: baking,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('common.share'));
      await clickButton(page, ctx.t('share.byLink'));
    },
  },
  'share-collection-sheet-offline': { skip: 'not scripted yet' },
  'share-collection-sheet-links-offline': { skip: 'not scripted yet' },
  'share-collection-sheet-link-minted': { skip: 'not scripted yet' },
  'import-from-collection': { skip: 'not scripted yet' },
  'import-destination-sheet': {
    persona: 'member',
    path: '/import',
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('import.chooseDestination'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'save-to-collection-sheet': {
    persona: 'member',
    path: '/import',
    mocks: ['importClean'],
    reach: async (page, ctx) => {
      await extractClean(page, ctx);
      await clickButton(page, ctx.t('common.save'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'sync-toast': { skip: 'not scripted yet' },
  'library-shared-banner': { persona: 'viewer', path: weeknights },
  'library-leave-sheet': {
    persona: 'viewer',
    path: weeknights,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('library.leave'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'recipe-edit-shared-editor': { persona: 'viewer', path: (ctx) => `/recipe/${ctx.ids.owner.shakshuka}/edit` },
  'recipe-view-shared': { persona: 'viewer', path: (ctx) => `/recipe/${ctx.ids.member.tomatoPasta}` },
  'recipe-view-shared-editor': { persona: 'viewer', path: (ctx) => `/recipe/${ctx.ids.owner.shakshuka}` },
  'recipe-chat-shared': { skip: 'not scripted yet' },
  'recipe-chat-shared-editor': { skip: 'not scripted yet' },
  'cooks-empty': { persona: 'empty', path: '/cooks' },
  'cooks-populated': { persona: 'member', path: '/cooks' },
  'cook-log-new': { skip: 'not scripted yet' },
  'cook-log-edit-delete': {
    persona: 'member',
    path: (ctx) => `/recipe/${ctx.ids.member.roastChicken}/cooks/${ctx.ids.member.cookLogRecent}/edit`,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('cookLog.deleteCook'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'assistant-signed-out': { persona: 'signedOut', path: '/assistant' },
  'assistant-empty': { persona: 'member', path: '/assistant' },
  'assistant-stopped': { skip: 'not scripted yet' },
  'assistant-shopping-list': { skip: 'not scripted yet' },
  'assistant-collection-move': { skip: 'not scripted yet' },
  'assistant-collection-move-applied': { skip: 'not scripted yet' },
  'assistant-collection-create': { skip: 'not scripted yet' },
  'assistant-collection-create-applied': { skip: 'not scripted yet' },
  'assistant-collection-create-error': { skip: 'not scripted yet' },
  'assistant-collection-move-error': { skip: 'not scripted yet' },
  'assistant-couldnt-answer': { skip: 'not scripted yet' },
  'assistant-tool-chip': { skip: 'not scripted yet' },
  'share-collection-sheet-public': {
    persona: 'member',
    path: weeknights,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('common.share'));
      await clickButton(page, ctx.t('share.byPublic'));
      await page.getByText(ctx.t('share.publicLinkLabel'), { exact: true }).waitFor();
    },
  },
  'public-collection': { persona: 'signedOut', path: (ctx) => `/p/${ctx.publicToken}` },
  'public-collection-locked-sheet': {
    persona: 'signedOut',
    path: (ctx) => `/p/${ctx.publicToken}`,
    reach: async (page) => {
      // The locked chat bubble is aria-disabled by design but opens the sheet;
      // Playwright treats aria-disabled as not clickable, so force the click.
      await page.locator('button[aria-disabled="true"]').first().click({ force: true });
      await page.getByRole('dialog').waitFor();
    },
  },
  'public-collection-member': { persona: 'empty', path: (ctx) => `/p/${ctx.publicToken}` },
  'public-recipe': { persona: 'signedOut', path: (ctx) => `/p/${ctx.publicToken}/r/${ctx.ids.member.borscht}` },
  'public-link-missing': { persona: 'signedOut', path: `/p/${'a'.repeat(43)}` },
};
