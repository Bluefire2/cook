import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SERVICE_WORKER_UPDATE_INTERVAL_MS,
  setupServiceWorkerUpdateChecks,
  watchServiceWorkerUpdates,
  type ServiceWorkerUpdateDocument,
} from './serviceWorkerUpdates';

function fakeDocument(initial: DocumentVisibilityState): ServiceWorkerUpdateDocument & {
  setVisibility: (state: DocumentVisibilityState) => void;
  fire: () => void;
  listenerCount: () => number;
} {
  let visibilityState = initial;
  const listeners: Array<() => void> = [];
  return {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener(_type, listener) {
      listeners.push(listener);
    },
    removeEventListener(_type, listener) {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    },
    setVisibility(state) {
      visibilityState = state;
    },
    fire() {
      for (const listener of [...listeners]) listener();
    },
    listenerCount() {
      return listeners.length;
    },
  };
}

describe('watchServiceWorkerUpdates', () => {
  it('checks when the tab becomes visible and skips a hide', () => {
    const update = vi.fn(() => Promise.resolve());
    const target = fakeDocument('visible');
    let scheduled: (() => void) | null = null;
    watchServiceWorkerUpdates(
      { update },
      {
        target,
        schedule(check) {
          scheduled = check;
          return 1;
        },
        cancel() {},
      },
    );

    expect(update).not.toHaveBeenCalled();
    expect(scheduled).toEqual(expect.any(Function));

    target.setVisibility('hidden');
    target.fire();
    expect(update).not.toHaveBeenCalled();

    target.setVisibility('visible');
    target.fire();
    expect(update).toHaveBeenCalledOnce();
  });

  it('passes the hour interval to the scheduler and runs that check', () => {
    const update = vi.fn(() => Promise.resolve());
    let scheduled: { check: () => void; intervalMs: number } | null = null;
    watchServiceWorkerUpdates(
      { update },
      {
        target: fakeDocument('hidden'),
        schedule(check, intervalMs) {
          scheduled = { check, intervalMs };
          return 7;
        },
        cancel() {},
      },
    );

    expect(scheduled).toEqual({
      check: expect.any(Function),
      intervalMs: SERVICE_WORKER_UPDATE_INTERVAL_MS,
    });
    scheduled!.check();
    expect(update).toHaveBeenCalledOnce();
  });

  it('swallows a failed check so the next one still runs', async () => {
    const update = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const target = fakeDocument('hidden');
    watchServiceWorkerUpdates(
      { update },
      {
        target,
        schedule() {
          return 1;
        },
        cancel() {},
      },
    );

    target.setVisibility('visible');
    target.fire();
    await Promise.resolve();
    target.fire();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('stops both the visibility listener and the timer', () => {
    const update = vi.fn(() => Promise.resolve());
    const target = fakeDocument('hidden');
    const cancel = vi.fn();
    const stop = watchServiceWorkerUpdates(
      { update },
      {
        target,
        schedule() {
          return 4;
        },
        cancel,
      },
    );

    expect(target.listenerCount()).toBe(1);
    stop();
    expect(target.listenerCount()).toBe(0);
    expect(cancel).toHaveBeenCalledWith(4);

    target.setVisibility('visible');
    target.fire();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('setupServiceWorkerUpdateChecks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing when the browser has no service worker', () => {
    const addEventListener = vi.fn();
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', { addEventListener });
    setupServiceWorkerUpdateChecks();
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it('watches the worker once it is active', async () => {
    const update = vi.fn(() => Promise.resolve());
    const target = fakeDocument('hidden');
    vi.stubGlobal('document', target);
    vi.stubGlobal('setInterval', () => 1);
    vi.stubGlobal('clearInterval', () => {});
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: Promise.resolve({ update }) },
    });

    setupServiceWorkerUpdateChecks();
    await vi.waitFor(() => expect(target.listenerCount()).toBe(1));

    target.setVisibility('visible');
    target.fire();
    expect(update).toHaveBeenCalledOnce();
  });
});
