import type { CookLog } from './types';

export const MAX_COOK_LOG_PHOTOS = 8;
export const MAX_COOK_LOG_TEXT = 10_000;
export const MAX_COOK_LOG_SERVINGS = 1000;
const MAX_COOK_LOG_JSON = 200_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** `YYYY-MM-DD` that names a real calendar day (`2026-02-30` is rejected). */
export function isCookedOn(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

/** The local calendar date, so a late-evening cook is not logged as tomorrow in UTC. */
export function todayCookedOn(date: Date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function compactText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function compactPhotoIds(ids: readonly string[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined;
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
    if (next.length >= MAX_COOK_LOG_PHOTOS) break;
  }
  return next.length > 0 ? next : undefined;
}

/**
 * `put` replaces the whole record. Fixed key order, unknown keys dropped, and
 * empty optionals omitted so every save leaves the same shape. Must keep the
 * same keys as the server's `compactCookLogFields`.
 */
export function compactCookLog(log: CookLog): CookLog {
  const next: CookLog = {
    id: log.id,
    recipeId: log.recipeId,
    cookedOn: log.cookedOn,
    createdAt: log.createdAt,
    updatedAt: log.updatedAt,
  };
  if (log.rating !== undefined) next.rating = log.rating;
  if (log.servings !== undefined) next.servings = log.servings;
  const notes = compactText(log.notes);
  if (notes !== undefined) next.notes = notes;
  const lessons = compactText(log.lessons);
  if (lessons !== undefined) next.lessons = lessons;
  const photoIds = compactPhotoIds(log.photoIds);
  if (photoIds !== undefined) next.photoIds = photoIds;
  return next;
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= MAX_COOK_LOG_TEXT);
}

/**
 * Exactly the server's `validateCookLogPut` rules. A row the server accepts
 * but this rejects would be dropped on pull while still owning photos.
 */
export function isUsableCookLog(raw: unknown): raw is CookLog {
  if (!isPlainObject(raw)) return false;
  if (!isUuid(raw.id) || !isUuid(raw.recipeId)) return false;
  if (!isCookedOn(raw.cookedOn)) return false;
  if (!isFiniteNumber(raw.createdAt) || !isFiniteNumber(raw.updatedAt)) return false;
  if (raw.rating !== undefined) {
    if (!isFiniteNumber(raw.rating) || !Number.isInteger(raw.rating)) return false;
    if (raw.rating < 1 || raw.rating > 5) return false;
  }
  if (raw.servings !== undefined) {
    if (!isFiniteNumber(raw.servings) || raw.servings <= 0 || raw.servings > MAX_COOK_LOG_SERVINGS) {
      return false;
    }
  }
  if (!isOptionalText(raw.notes) || !isOptionalText(raw.lessons)) return false;
  if (raw.photoIds !== undefined) {
    if (!Array.isArray(raw.photoIds) || raw.photoIds.length > MAX_COOK_LOG_PHOTOS) return false;
    const seen = new Set<string>();
    for (const id of raw.photoIds) {
      if (!isUuid(id) || seen.has(id)) return false;
      seen.add(id);
    }
  }
  return JSON.stringify(raw).length < MAX_COOK_LOG_JSON;
}

/** Newest cook first: `cookedOn` desc, then `createdAt` desc, then `id`. */
export function sortCookLogs(logs: readonly CookLog[]): CookLog[] {
  return [...logs].sort((a, b) => {
    if (a.cookedOn !== b.cookedOn) return a.cookedOn < b.cookedOn ? 1 : -1;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/** Idempotent: a lesson already contained in the notes is not appended again. */
export function appendLessonToNotes(
  notes: string | undefined,
  lesson: string | undefined,
): string | undefined {
  const trimmed = lesson?.trim() ?? '';
  if (trimmed === '') return notes;
  if (notes !== undefined && notes.includes(trimmed)) return notes;
  const base = notes?.trimEnd() ?? '';
  return base === '' ? trimmed : `${base}\n\n${trimmed}`;
}

export function lessonInNotes(notes: string | undefined, lesson: string | undefined): boolean {
  const trimmed = lesson?.trim() ?? '';
  return trimmed !== '' && notes !== undefined && notes.includes(trimmed);
}
