/**
 * Discovery and validation of fixtures in `evals/import-handwritten/dev/` and
 * `holdout/`; a fixture outside a split throws. Rules: `evals/AGENTS.md`.
 * Shared by `evals/recipeImport.eval.ts` and `evals/ocrCompare.ts`. A fixture
 * that breaks a rule throws instead of being skipped, and a valid one is
 * exactly what `POST /api/import` would accept.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkImportImages, MAX_IMPORT_BODY_BYTES, MAX_IMPORT_IMAGES } from '../server/importRoute.ts';
import {
  normalizeImportedRecipe,
  type ImportImage,
  type ImportedRecipe,
} from '../server/recipeImport.ts';

export const HANDWRITTEN_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'import-handwritten');

export type HandwrittenSplit = 'dev' | 'holdout';

export const HANDWRITTEN_SPLITS: readonly HandwrittenSplit[] = ['dev', 'holdout'];

export interface HandwrittenFixture {
  name: string;
  split: HandwrittenSplit;
  pages: ImportImage[];
  golden: ImportedRecipe;
}

const PAGE_FILE = /^page-([1-9]\d*)\.(jpg|jpeg|png|webp)$/;

const MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const EXIF_SCAN_BYTES = 64 * 1024;
const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');

/** Headroom for the JSON wrapper around the pages, as the client leaves. */
const BODY_HEADROOM_CHARS = 64 * 1024;

function isHandwrittenSplit(name: string): name is HandwrittenSplit {
  for (const split of HANDWRITTEN_SPLITS) {
    if (split === name) return true;
  }
  return false;
}

/** Non-dot directory names directly under `dir`. A missing directory is `[]`. */
function directoryNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

function fixtureError(split: HandwrittenSplit, name: string, problem: string): Error {
  return new Error(`evals/import-handwritten/${split}/${name}: ${problem}`);
}

function checkSource(split: HandwrittenSplit, dir: string, name: string): void {
  const path = join(dir, 'source.txt');
  if (!existsSync(path)) throw fixtureError(split, name, 'missing source.txt');
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const key of ['provenance:', 'permission:']) {
    if (!lines.some((line) => line.startsWith(key) && line.slice(key.length).trim() !== '')) {
      throw fixtureError(split, name, `source.txt needs a "${key} …" line`);
    }
  }
}

function readPages(
  split: HandwrittenSplit,
  dir: string,
  name: string,
  files: readonly string[],
): ImportImage[] {
  const byNumber = new Map<number, string>();
  for (const file of files) {
    if (!file.startsWith('page-')) continue;
    const match = PAGE_FILE.exec(file);
    if (!match) {
      throw fixtureError(split, name, `${file} is not page-<n>.jpg, .jpeg, .png, or .webp`);
    }
    const n = Number(match[1]);
    if (byNumber.has(n)) throw fixtureError(split, name, `more than one file for page ${n}`);
    byNumber.set(n, file);
  }
  if (byNumber.size === 0) throw fixtureError(split, name, 'no page-1 image');
  if (byNumber.size > MAX_IMPORT_IMAGES) {
    throw fixtureError(split, name, `more than ${MAX_IMPORT_IMAGES} pages`);
  }

  const pages: ImportImage[] = [];
  for (let n = 1; n <= byNumber.size; n++) {
    const file = byNumber.get(n);
    if (file === undefined) {
      throw fixtureError(split, name, `page-${n} is missing; pages must be numbered from 1 with no gaps`);
    }
    const ext = file.slice(file.lastIndexOf('.') + 1);
    const mediaType = MEDIA_TYPES[ext];
    const bytes = readFileSync(join(dir, file));
    // Phone EXIF includes GPS, and this repository is public.
    if (mediaType === 'image/jpeg' && bytes.subarray(0, EXIF_SCAN_BYTES).includes(EXIF_HEADER)) {
      throw fixtureError(split, name, `${file} has EXIF metadata; strip it first (see evals/README.md)`);
    }
    pages.push({ mediaType, base64: bytes.toString('base64') });
  }

  const check = checkImportImages(pages);
  if (check.kind !== 'ok') {
    throw fixtureError(split, name, `pages rejected by checkImportImages: ${check.kind}`);
  }
  const base64Chars = check.images.reduce((n, page) => n + page.base64.length, 0);
  if (base64Chars > MAX_IMPORT_BODY_BYTES - BODY_HEADROOM_CHARS) {
    throw fixtureError(split, name, 'pages exceed the request body cap');
  }
  return check.images;
}

function readGolden(split: HandwrittenSplit, dir: string, name: string): ImportedRecipe {
  const path = join(dir, 'golden.json');
  if (!existsSync(path)) throw fixtureError(split, name, 'missing golden.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw fixtureError(split, name, 'golden.json is not valid JSON');
  }
  const golden = normalizeImportedRecipe(parsed);
  if (golden === null) throw fixtureError(split, name, 'golden.json is not a usable recipe');
  return golden;
}

export function listHandwrittenFixtures(
  split: HandwrittenSplit,
  root: string = HANDWRITTEN_ROOT,
): HandwrittenFixture[] {
  if (!existsSync(root)) return [];

  for (const name of directoryNames(root).sort()) {
    if (!isHandwrittenSplit(name)) {
      throw new Error(
        `evals/import-handwritten/${name}: not in dev/ or holdout/. Move it with git mv; new fixtures go in holdout/ (see evals/AGENTS.md).`,
      );
    }
  }

  const devNames = new Set(directoryNames(join(root, 'dev')));
  for (const name of directoryNames(join(root, 'holdout')).sort()) {
    if (devNames.has(name)) {
      throw new Error(`evals/import-handwritten: ${name} is in both dev/ and holdout/`);
    }
  }

  const splitRoot = join(root, split);
  if (!existsSync(splitRoot)) return [];
  const names = directoryNames(splitRoot).sort();
  return names.map((name) => {
    const dir = join(splitRoot, name);
    checkSource(split, dir, name);
    const pages = readPages(split, dir, name, readdirSync(dir));
    return { name, split, pages, golden: readGolden(split, dir, name) };
  });
}
