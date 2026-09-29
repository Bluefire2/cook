import { t } from '../i18n';
import { serverErrorText } from './errorText';
import { invalidateSession } from './session';
import { settings } from './settings';
import { baseAudioMime, stripTranscript } from './voiceRecorder';

export async function transcribeAudio(params: {
  blob: Blob;
  title?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': baseAudioMime(params.blob.type) || 'application/octet-stream',
    'x-sous-language': settings.getLocale(),
  };
  if (params.title !== undefined && params.title.trim() !== '') {
    headers['x-recipe-title'] = encodeURIComponent(params.title);
    headers['x-recipe-title-encoding'] = 'uri';
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
    throw new Error(t('error.sessionExpired'));
  }

  const data = (await response.json().catch(() => null)) as
    | { text?: unknown; error?: unknown }
    | null;

  if (!response.ok) {
    throw new Error(serverErrorText(data, 'error.dictationFailed'));
  }

  const text = typeof data?.text === 'string' ? data.text : '';
  return stripTranscript(text);
}
