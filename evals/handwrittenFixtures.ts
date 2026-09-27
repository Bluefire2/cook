/**
 * Discovery and validation of `evals/import-handwritten/` fixtures, shared by
 * `evals/recipeImport.eval.ts` and `evals/ocrCompare.ts`. A fixture that breaks
 * a rule throws instead of being skipped, and a valid one is exactly what
 * `POST /api/import` would accept. Layout and rules: `evals/README.md`.
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

export interface HandwrittenFixture {
  name: string;
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

function fixtureError(name: string, problem: string): Error {
  return new Error(`evals/import-handwritten/${name}: ${problem}`);
}

function checkSource(dir: string, name: string): void {
  const path = join(dir, 'source.txt');
  if (!existsSync(path)) throw fixtureError(name, 'missing source.txt');
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const key of ['provenance:', 'permission:']) {
    if (!lines.some((line) => line.startsWith(key) && line.slice(key.length).trim() !== '')) {
      throw fixtureError(name, `source.txt needs a "${key} …" line`);
    }
  }
}

function readPages(dir: string, name: string, files: readonly string[]): ImportImage[] {
  const byNumber = new Map<number, string>();
  for (const file of files) {
    if (!file.startsWith('page-')) continue;
    const match = PAGE_FILE.exec(file);
    if (!match) {
      throw fixtureError(name, `${file} is not page-<n>.jpg, .jpeg, .png, or .webp`);
    }
    const n = Number(match[1]);
    if (byNumber.has(n)) throw fixtureError(name, `more than one file for page ${n}`);
    byNumber.set(n, file);
  }
  if (byNumber.size === 0) throw fixtureError(name, 'no page-1 image');
  if (byNumber.size > MAX_IMPORT_IMAGES) {
    throw fixtureError(name, `more than ${MAX_IMPORT_IMAGES} pages`);
  }

  const pages: ImportImage[] = [];
  for (let n = 1; n <= byNumber.size; n++) {
    const file = byNumber.get(n);
    if (file === undefined) {
      throw fixtureError(name, `page-${n} is missing; pages must be numbered from 1 with no gaps`);
    }
    const ext = file.slice(file.lastIndexOf('.') + 1);
    const mediaType = MEDIA_TYPES[ext];
    const bytes = readFileSync(join(dir, file));
    // Phone EXIF includes GPS, and this repository is public.
    if (mediaType === 'image/jpeg' && bytes.subarray(0, EXIF_SCAN_BYTES).includes(EXIF_HEADER)) {
      throw fixtureError(name, `${file} has EXIF metadata; strip it first (see evals/README.md)`);
    }
    pages.push({ mediaType, base64: bytes.toString('base64') });
  }

  const check = checkImportImages(pages);
  if (check.kind !== 'ok') {
    throw fixtureError(name, `pages rejected by checkImportImages: ${check.kind}`);
  }
  const base64Chars = check.images.reduce((n, page) => n + page.base64.length, 0);
  if (base64Chars > MAX_IMPORT_BODY_BYTES - BODY_HEADROOM_CHARS) {
    throw fixtureError(name, 'pages exceed the request body cap');
  }
  return check.images;
}

function readGolden(dir: string, name: string): ImportedRecipe {
  const path = join(dir, 'golden.json');
  if (!existsSync(path)) throw fixtureError(name, 'missing golden.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw fixtureError(name, 'golden.json is not valid JSON');
  }
  const golden = normalizeImportedRecipe(parsed);
  if (golden === null) throw fixtureError(name, 'golden.json is not a usable recipe');
  return golden;
}

export function listHandwrittenFixtures(root: string = HANDWRITTEN_ROOT): HandwrittenFixture[] {
  if (!existsSync(root)) return [];
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  return names.map((name) => {
    const dir = join(root, name);
    checkSource(dir, name);
    const pages = readPages(dir, name, readdirSync(dir));
    return { name, pages, golden: readGolden(dir, name) };
  });
}
