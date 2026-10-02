/**
 * `POST /api/feature-request`: a suggestion sent from `/suggest`
 * (`docs/plans/feature-requests.md`). Gated by `withMembership` in
 * `scripts/server.ts`; `sub` comes only from the session.
 *
 * A suggestion is stored in top-level `featureRequests/{id}`, never under
 * `users/{uid}`: it is for the owner and must not sync or back up. `expireAt`
 * drives the one-year Firestore TTL policy. The id is the client's UUID and
 * the write is `create()`, so a resend after a lost response is a no-op. The
 * email address is never stored; when `contactOk` is set, the owner's reader
 * script looks it up from `sub`. The stored fields are documented in
 * `docs/plans/feature-requests.md` (Suggestion schema); keep it in step with
 * `FeatureRequestDoc`.
 *
 * One `event: 'feature_request'` log line per request holds the `sub`, where
 * the page was opened from, the text's length, `contactOk`, and the status.
 * Never the text. `/privacy` describes the stored suggestion and this line;
 * change it with them.
 */
import {
  featureRequestText,
  isFeatureRequestFrom,
  type FeatureRequestFrom,
} from './featureRequestShape.ts';
import { isAlreadyExists } from './importFeedback.ts';
import { sanitizedError } from './importLog.ts';
import { toSupportedLocale } from './lang.ts';
import {
  readBoundedText,
  storeUnavailable,
  type MembershipHandlerContext,
} from './membership.ts';
import { admitTranslateCall } from './recipeTranslation.ts';
import { getStoreFirestore, isUuid } from './store.ts';

export const FEATURE_REQUEST_COLLECTION = 'featureRequests';
export const MAX_FEATURE_REQUEST_BODY_BYTES = 16 * 1024;
export const FEATURE_REQUEST_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const FEATURE_REQUEST_RATE_LIMIT = 5;
export const FEATURE_REQUEST_RATE_WINDOW_MS = 60 * 60 * 1000;

export interface FeatureRequestFields {
  text: string;
  contactOk: boolean;
  from?: FeatureRequestFrom;
  locale?: string;
  standalone?: boolean;
}

export interface FeatureRequestDoc extends FeatureRequestFields {
  v: 1;
  sub: string;
  createdAt: number;
  /** Stored as a Timestamp; the TTL policy deletes the doc after it. */
  expireAt: Date;
}

export type ReadFeatureRequest =
  | { kind: 'ok'; id: string; fields: FeatureRequestFields }
  | { kind: 'bad' };

export interface FeatureRequestDeps {
  create(id: string, doc: FeatureRequestDoc): Promise<void>;
  now(): number;
}

interface FeatureRequestLogEntry {
  sub: string;
  from?: FeatureRequestFrom;
  chars?: number;
  contactOk?: boolean;
  status?: number;
  /** A numeric gRPC code from a failed store write. */
  errorCode?: number;
  ms?: number;
}

/** Per container instance, separate from translation's and import feedback's buckets. */
const rateBuckets = new Map<string, number[]>();

/** Test hook: clears the per-instance rate-limit buckets. */
export function resetFeatureRequestRateLimitForTest(): void {
  rateBuckets.clear();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The request body as a suggestion, or `bad` for a non-object body, a bad id,
 * or no text. Optional fields that are malformed are dropped. Never yields an
 * `undefined` value (Firestore rejects them).
 */
export function readFeatureRequest(body: unknown): ReadFeatureRequest {
  if (!isPlainObject(body) || !isUuid(body.id) || typeof body.text !== 'string') {
    return { kind: 'bad' };
  }
  const text = featureRequestText(body.text);
  if (text === '') return { kind: 'bad' };
  const fields: FeatureRequestFields = { text, contactOk: body.contactOk === true };
  if (isFeatureRequestFrom(body.from)) fields.from = body.from;
  const locale = toSupportedLocale(body.locale);
  if (locale !== undefined) fields.locale = locale;
  if (typeof body.standalone === 'boolean') fields.standalone = body.standalone;
  return { kind: 'ok', id: body.id, fields };
}

function defaultDeps(): FeatureRequestDeps {
  return {
    create: (id, doc) =>
      getStoreFirestore()
        .collection(FEATURE_REQUEST_COLLECTION)
        .doc(id)
        .create(doc)
        .then(() => {}),
    now: Date.now,
  };
}

function fail(code: string, error: string, status: number): Response {
  return Response.json({ error, code }, { status });
}

export async function featureRequestPost(
  req: Request,
  ctx: MembershipHandlerContext,
  deps?: FeatureRequestDeps,
): Promise<Response> {
  // `withMembership` has already decided access; the sub only names the
  // sender and the log line. Read once (membership.test.ts counts it).
  const sub = ctx.authorizedSub;
  const entry: FeatureRequestLogEntry = { sub };
  const started = Date.now();
  try {
    const response = await handleFeatureRequest(req, sub, entry, deps ?? defaultDeps());
    entry.status = response.status;
    return response;
  } catch (err) {
    // The dispatcher in `scripts/server.ts` logs whatever escapes as an error,
    // and a message can quote the request (the suggestion's text).
    entry.status = 500;
    throw sanitizedError('Feature request failed', err);
  } finally {
    entry.ms = Date.now() - started;
    console.log(JSON.stringify({ event: 'feature_request', ...entry }));
  }
}

/** `featureRequestPost` without the log line; it records what happened on `entry`. */
async function handleFeatureRequest(
  req: Request,
  sub: string,
  entry: FeatureRequestLogEntry,
  deps: FeatureRequestDeps,
): Promise<Response> {
  const raw = await readBoundedText(req, MAX_FEATURE_REQUEST_BODY_BYTES);
  if (raw === null) return fail('feature-request-too-large', 'Too large', 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail('feature-request-bad-request', 'Bad request', 400);
  }
  const parsed = readFeatureRequest(body);
  if (parsed.kind === 'bad') return fail('feature-request-bad-request', 'Bad request', 400);

  const { fields } = parsed;
  if (fields.from !== undefined) entry.from = fields.from;
  entry.chars = fields.text.length;
  entry.contactOk = fields.contactOk;

  const now = deps.now();
  // Generic sliding window; reused from translation with its own buckets.
  if (
    !admitTranslateCall(
      rateBuckets,
      sub,
      now,
      FEATURE_REQUEST_RATE_LIMIT,
      FEATURE_REQUEST_RATE_WINDOW_MS,
    )
  ) {
    return fail('feature-request-rate-limited', 'Too many suggestions', 429);
  }

  // `fields` first, so nothing in the body can override the session's `sub`.
  const doc: FeatureRequestDoc = {
    ...fields,
    v: 1,
    sub,
    createdAt: now,
    expireAt: new Date(now + FEATURE_REQUEST_RETENTION_MS),
  };
  try {
    await deps.create(parsed.id, doc);
  } catch (err) {
    if (isAlreadyExists(err)) return new Response(null, { status: 204 });
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    if (typeof code === 'number') entry.errorCode = code;
    return storeUnavailable();
  }
  return new Response(null, { status: 204 });
}
