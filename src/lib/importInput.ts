/** Same URL check as the pre-bulk Import screen (`^https?:\/\/\\S+$`). */
export const RECIPE_URL_RE = /^https?:\/\/\S+$/;

export const MAX_BULK_IMPORT_URLS = 20;

export const BULK_REQUIRES_CHECKBOX =
  'This looks like several recipe links. Turn on bulk import to extract them all, or paste a single link.';

export const BULK_LINKS_ONLY =
  'Bulk import only accepts recipe links, one per line.';

export const BULK_CAP_ERROR = `Bulk import is limited to ${MAX_BULK_IMPORT_URLS} links.`;

export type ParsedImportInput =
  | { kind: 'empty' }
  | { kind: 'singleUrl'; url: string }
  | { kind: 'urlList'; urls: string[] }
  | { kind: 'text'; text: string };

export type ValidatedImportInput =
  | { ok: true; mode: 'url'; url: string }
  | { ok: true; mode: 'text'; text: string }
  | { ok: true; mode: 'bulk'; urls: string[] }
  | { ok: false; error: string };

function dedupePreserveOrder(tokens: string[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    urls.push(token);
  }
  return urls;
}

export function parseImportInput(raw: string): ParsedImportInput {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { kind: 'empty' };
  }
  const tokens = trimmed.split(/\s+/);
  if (!tokens.every((token) => RECIPE_URL_RE.test(token))) {
    return { kind: 'text', text: trimmed };
  }
  const urls = dedupePreserveOrder(tokens);
  const first = urls[0];
  if (urls.length === 1 && first !== undefined) {
    return { kind: 'singleUrl', url: first };
  }
  return { kind: 'urlList', urls };
}

export function validateImportInput(
  parsed: ParsedImportInput,
  bulkChecked: boolean,
): ValidatedImportInput {
  if (parsed.kind === 'empty') {
    return { ok: false, error: '' };
  }
  if (parsed.kind === 'urlList') {
    if (!bulkChecked) {
      return { ok: false, error: BULK_REQUIRES_CHECKBOX };
    }
    if (parsed.urls.length > MAX_BULK_IMPORT_URLS) {
      return { ok: false, error: BULK_CAP_ERROR };
    }
    return { ok: true, mode: 'bulk', urls: parsed.urls };
  }
  if (bulkChecked && parsed.kind === 'text') {
    return { ok: false, error: BULK_LINKS_ONLY };
  }
  if (parsed.kind === 'singleUrl') {
    return { ok: true, mode: 'url', url: parsed.url };
  }
  return { ok: true, mode: 'text', text: parsed.text };
}
