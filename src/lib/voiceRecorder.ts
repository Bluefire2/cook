/** Pause after speech before the clip is considered done. Product knob. */
export const SILENCE_PAUSE_MS = 1500;
/** RMS (0..1 from byte time-domain) treated as speech. */
export const SILENCE_RMS = 0.04;
/** Hard stop, then transcribe. */
export const MAX_RECORD_MS = 30_000;

const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
] as const;

export function pickRecorderMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function canRecord(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder === 'function'
  );
}

export function silenceDecision(input: {
  now: number;
  startedAt: number;
  lastLoudAt: number | null;
  rms: number;
}): 'keep-listening' | 'stop' {
  if (input.now - input.startedAt >= MAX_RECORD_MS) {
    return 'stop';
  }
  if (input.lastLoudAt === null) {
    return 'keep-listening';
  }
  if (input.rms >= SILENCE_RMS) {
    return 'keep-listening';
  }
  if (input.now - input.lastLoudAt >= SILENCE_PAUSE_MS) {
    return 'stop';
  }
  return 'keep-listening';
}

export function stripTranscript(raw: string): string {
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

export function baseAudioMime(raw: string): string {
  return raw.split(';')[0]?.trim().toLowerCase() ?? '';
}

function rmsFromByteTimeDomain(samples: Uint8Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const value of samples) {
    const n = (value - 128) / 128;
    sum += n * n;
  }
  return Math.sqrt(sum / samples.length);
}

export interface VoiceSession {
  stop(): Promise<Blob | null>;
  abort(): void;
}

export async function startRecording(
  onAutoStop: (blob: Blob) => void,
): Promise<VoiceSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  const mime = pickRecorderMime();
  const recorder = mime
    ? new MediaRecorder(stream, { mimeType: mime })
    : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  const startedAt = Date.now();
  let lastLoudAt: number | null = null;
  let settled = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let audioContext: AudioContext | null = null;
  const chosenType =
    baseAudioMime(recorder.mimeType || mime || '') || 'application/octet-stream';

  const cleanup = () => {
    if (poll !== undefined) {
      clearInterval(poll);
      poll = undefined;
    }
    for (const track of stream.getTracks()) {
      track.stop();
    }
    if (audioContext) {
      void audioContext.close();
      audioContext = null;
    }
  };

  const blobFromChunks = (): Blob => new Blob(chunks, { type: chosenType });

  recorder.addEventListener('dataavailable', (event: BlobEvent) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  const finish = (deliver: (blob: Blob) => void) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    const emit = () => {
      deliver(blobFromChunks());
    };
    if (recorder.state !== 'inactive') {
      recorder.addEventListener('stop', emit, { once: true });
      recorder.stop();
    } else {
      emit();
    }
  };

  const autoStop = () => {
    finish((blob) => {
      onAutoStop(blob);
    });
  };

  try {
    const Ctx =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) {
      throw new Error('no-audio-context');
    }
    audioContext = new Ctx();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    poll = setInterval(() => {
      if (settled) {
        return;
      }
      analyser.getByteTimeDomainData(samples);
      const rms = rmsFromByteTimeDomain(samples);
      const now = Date.now();
      if (rms >= SILENCE_RMS) {
        lastLoudAt = now;
      }
      if (silenceDecision({ now, startedAt, lastLoudAt, rms }) === 'stop') {
        autoStop();
      }
    }, 100);
    if (audioContext.state === 'suspended') {
      void audioContext.resume();
    }
  } catch {
    poll = setInterval(() => {
      if (settled) {
        return;
      }
      if (Date.now() - startedAt >= MAX_RECORD_MS) {
        autoStop();
      }
    }, 100);
  }

  recorder.start(250);

  return {
    stop() {
      return new Promise((resolve) => {
        if (settled) {
          resolve(null);
          return;
        }
        finish((blob) => {
          resolve(blob);
        });
      });
    },
    abort() {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // Already stopped.
        }
      }
    },
  };
}
