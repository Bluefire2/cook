import { GoogleGenAI } from '@google/genai';
import {
  membershipUnauthorized,
  membershipUnavailable,
  requireMember,
} from './membership.ts';

export const MAX_STT_BYTES = 1_048_576;

const STT_MIME = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
]);

const TITLE_MAX_CHARS = 200;

export function normalizeSttContentType(raw: string): string | null {
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!STT_MIME.has(base)) {
    return null;
  }
  return base;
}

export function isSttByteCountTooLarge(byteCount: number): boolean {
  return byteCount > MAX_STT_BYTES;
}

export function clipRecipeTitle(raw: string): string {
  const scalars = [...raw].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  return scalars.slice(0, TITLE_MAX_CHARS).join('').trim();
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function parseContentLength(req: Request): number | null {
  const raw = req.headers.get('content-length');
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

function stripTranscript(raw: string): string {
  let text = raw.trim().replace(/\s*\n+\s*/g, ' ').replace(/[ \t]+/g, ' ').trim();
  if (text.length >= 2) {
    const start = text[0];
    const end = text[text.length - 1];
    if ((start === '"' && end === '"') || (start === '\u201C' && end === '\u201D')) {
      text = text.slice(1, -1).trim();
    }
  }
  return text;
}

function transcriptionPrompt(title: string | null): string {
  const lines = [
    'Transcribe the speech in this audio to plain text.',
    'Return only the transcript. If there is no speech, return an empty string.',
    'Do not add quotation marks, labels, or commentary.',
    'Language: English.',
  ];
  if (title) {
    lines.push(`The cook is making: ${title}.`);
  }
  return lines.join('\n');
}

async function readCappedBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<
  | { kind: 'ok'; bytes: Uint8Array }
  | { kind: 'missing' }
  | { kind: 'empty' }
  | { kind: 'too-large' }
> {
  if (body === null) {
    return { kind: 'missing' };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { kind: 'too-large' };
    }
    chunks.push(value);
  }
  if (total === 0) {
    return { kind: 'empty' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'ok', bytes };
}

export async function sttPost(req: Request): Promise<Response> {
  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '') {
    return jsonError('Assistant is unavailable.', 503);
  }

  const contentTypeRaw = req.headers.get('content-type');
  if (contentTypeRaw === null) {
    return jsonError('Bad request', 400);
  }
  const mimeType = normalizeSttContentType(contentTypeRaw);
  if (mimeType === null) {
    return jsonError('Bad request', 400);
  }

  const contentLength = parseContentLength(req);
  if (contentLength !== null && isSttByteCountTooLarge(contentLength)) {
    return jsonError('Recording too long — try a shorter question.', 413);
  }

  const body = await readCappedBytes(req.body, MAX_STT_BYTES);
  if (body.kind === 'too-large') {
    return jsonError('Recording too long — try a shorter question.', 413);
  }
  if (body.kind !== 'ok') {
    return jsonError('Bad request', 400);
  }

  const titleHeader = req.headers.get('x-recipe-title');
  const title =
    titleHeader === null || titleHeader.trim() === ''
      ? null
      : clipRecipeTitle(titleHeader) || null;

  const model = process.env.CHAT_MODEL || 'gemini-3.7-flash';
  const ai = new GoogleGenAI({ apiKey });
  try {
    const result = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType,
                data: Buffer.from(body.bytes).toString('base64'),
              },
            },
            { text: transcriptionPrompt(title) },
          ],
        },
      ],
      config: {
        maxOutputTokens: 512,
        temperature: 0,
      },
    });
    const raw = result.text;
    if (typeof raw !== 'string') {
      return jsonError('Dictation failed — try again.', 502);
    }
    console.log(`stt bytes=${body.bytes.byteLength} mime=${mimeType}`);
    return new Response(JSON.stringify({ text: stripTranscript(raw) }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return jsonError('Dictation failed — try again.', 502);
  }
}
