import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RECORD_MS,
  SILENCE_PAUSE_MS,
  SILENCE_RMS,
  canRecord,
  pickRecorderMime,
  silenceDecision,
  stripTranscript,
} from './voiceRecorder';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('silenceDecision', () => {
  it('keeps listening before any speech, even after the pause window', () => {
    expect(
      silenceDecision({
        now: SILENCE_PAUSE_MS + 500,
        startedAt: 0,
        lastLoudAt: null,
        rms: 0,
      }),
    ).toBe('keep-listening');
  });

  it('stops at max duration even without speech', () => {
    expect(
      silenceDecision({
        now: MAX_RECORD_MS,
        startedAt: 0,
        lastLoudAt: null,
        rms: 0,
      }),
    ).toBe('stop');
  });

  it('keeps listening while loud after speech has started', () => {
    expect(
      silenceDecision({
        now: 200,
        startedAt: 0,
        lastLoudAt: 200,
        rms: SILENCE_RMS,
      }),
    ).toBe('keep-listening');
  });

  it('stops after the pause once speech was heard', () => {
    expect(
      silenceDecision({
        now: 100 + SILENCE_PAUSE_MS,
        startedAt: 0,
        lastLoudAt: 100,
        rms: 0,
      }),
    ).toBe('stop');
  });

  it('keeps listening during the pause window', () => {
    expect(
      silenceDecision({
        now: 100 + SILENCE_PAUSE_MS - 1,
        startedAt: 0,
        lastLoudAt: 100,
        rms: 0,
      }),
    ).toBe('keep-listening');
  });

  it('loud rms after speech resets the pause', () => {
    expect(
      silenceDecision({
        now: 100 + SILENCE_PAUSE_MS,
        startedAt: 0,
        lastLoudAt: 100,
        rms: SILENCE_RMS,
      }),
    ).toBe('keep-listening');
  });
});

describe('stripTranscript', () => {
  it('trims and collapses newlines', () => {
    expect(stripTranscript('  hello\nthere  ')).toBe('hello there');
  });

  it('unwraps matching straight quotes once', () => {
    expect(stripTranscript('"hello"')).toBe('hello');
  });

  it('unwraps matching curly quotes once', () => {
    expect(stripTranscript('\u201Chello\u201D')).toBe('hello');
  });

  it('returns empty for empty input', () => {
    expect(stripTranscript('')).toBe('');
    expect(stripTranscript('   ')).toBe('');
  });
});

describe('pickRecorderMime', () => {
  it('returns null when MediaRecorder is missing', () => {
    vi.stubGlobal('MediaRecorder', undefined);
    expect(pickRecorderMime()).toBeNull();
  });

  it('returns the first supported candidate', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (type: string) => type === 'audio/mp4',
    });
    expect(pickRecorderMime()).toBe('audio/mp4');
  });
});

describe('canRecord', () => {
  it('is false without getUserMedia or MediaRecorder', () => {
    vi.stubGlobal('navigator', { mediaDevices: {} });
    vi.stubGlobal('MediaRecorder', undefined);
    expect(canRecord()).toBe(false);
  });

  it('is true when both APIs exist', () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => Promise.resolve() },
    });
    vi.stubGlobal('MediaRecorder', function MediaRecorder() {});
    expect(canRecord()).toBe(true);
  });
});
