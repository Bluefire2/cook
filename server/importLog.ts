/**
 * One structured log line per import request, so a failed import can be found
 * by account and by site (`docs/plans/import-reliability.md`). Cloud Logging
 * parses a JSON line on stdout as `jsonPayload`; query it with
 * `jsonPayload.event="import"`.
 *
 * Logged: the account `sub`, how the import arrived, the page address without
 * its query string or fragment, the outcome, counts, and timing. Never logged:
 * the email, recipe text, page HTML, pasted text, photo bytes, or an error
 * message (SDK errors can echo the request). `/privacy` and `/terms` describe
 * this line; change them with it.
 */
import type { ImportOutcome, PageFetchOutcome } from './recipeImport.ts';

export type ImportVia = 'url' | 'paste' | 'photos' | 'extension';

/**
 * `ImportOutcome` kinds, plus the ways a request ends before or after the
 * pipeline. `threw` means the Gemini call (or something after it) threw.
 */
export type ImportLogOutcome =
  | ImportOutcome['kind']
  | 'bad_request'
  | 'too_large'
  | 'bad_language'
  | 'bad_url'
  | 'fetch_failed'
  | 'bad_photos'
  | 'save_failed'
  | 'threw';

export interface ImportLogEntry {
  sub?: string;
  via?: ImportVia;
  /** `origin + pathname` only. */
  url?: string;
  host?: string;
  fetch?: PageFetchOutcome['kind'];
  /** The site's HTTP status when it refused the fetch. */
  siteStatus?: number;
  outcome?: ImportLogOutcome;
  ingredients?: number;
  steps?: number;
  translation?: 'ok' | 'failed';
  photos?: number;
  bytes?: number;
  /** A numeric HTTP status on a thrown provider error (429, 503, …), when it has one. */
  errorStatus?: number;
  /** The status this route answered with. */
  status?: number;
  ms?: number;
}

/** The address to log: `origin + pathname`, or nothing when it is not an http(s) URL. */
export function loggableUrl(raw: unknown): { url: string; host: string } | undefined {
  if (typeof raw !== 'string') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  // `origin` already omits any `user:password@`.
  return { url: parsed.origin + parsed.pathname, host: parsed.hostname };
}

/** `status` from a provider error such as `@google/genai`'s `ApiError`. Never the message. */
export function thrownStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/** Records an `ImportOutcome` on the entry: its kind, and counts when it is a recipe. */
export function noteImportOutcome(entry: ImportLogEntry, outcome: ImportOutcome): void {
  entry.outcome = outcome.kind;
  if (outcome.kind !== 'ok') return;
  entry.ingredients = outcome.recipe.ingredientSections.reduce(
    (n, section) => n + section.items.length,
    0,
  );
  entry.steps = outcome.recipe.steps.length;
  if (outcome.translation !== undefined) entry.translation = outcome.translation.kind;
}

export function importLogLine(entry: ImportLogEntry): string {
  return JSON.stringify({ event: 'import', ...entry });
}

/**
 * Runs `handle`, then writes one line with its status and duration. A throw is
 * logged as `threw` and rethrown, so the caller's behaviour does not change.
 */
export async function withImportLog(
  entry: ImportLogEntry,
  handle: () => Promise<Response>,
): Promise<Response> {
  const started = Date.now();
  try {
    const response = await handle();
    entry.status = response.status;
    return response;
  } catch (err) {
    entry.outcome = 'threw';
    const status = thrownStatus(err);
    if (status !== undefined) entry.errorStatus = status;
    entry.status = 500;
    throw err;
  } finally {
    entry.ms = Date.now() - started;
    console.log(importLogLine(entry));
  }
}
