import { invalidateSession } from './session';
import { baseAudioMime, stripTranscript } from './voiceRecorder';

export async function transcribeAudio(params: {
  blob: Blob;
  title?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': baseAudioMime(params.blob.type) || 'application/octet-stream',
  };
  if (params.title !== undefined && params.title.trim() !== '') {
    headers['x-recipe-title'] = params.title;
  }

  const response = await fetch('/api/stt', {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: params.blob,
    signal: params.signal,
  });

  if (response.status === 401) {
    invalidateSession();
    throw new Error('Please sign in again — your session expired.');
  }

  const data = (await response.json().catch(() => null)) as
    | { text?: unknown; error?: unknown }
    | null;

  if (response.status === 503) {
    const message =
      typeof data?.error === 'string' && data.error !== ''
        ? data.error
        : 'Dictation failed — try again.';
    throw new Error(message);
  }

  if (!response.ok) {
    const message =
      typeof data?.error === 'string' && data.error !== ''
        ? data.error
        : 'Dictation failed — try again.';
    throw new Error(message);
  }

  const text = typeof data?.text === 'string' ? data.text : '';
  return stripTranscript(text);
}
