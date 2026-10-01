/**
 * Re-checks `sw.js` while a tab stays open.
 *
 * A full page load already compares the worker. In-app route changes do not,
 * and an installed PWA can stay in the foreground across a deploy. Hashed
 * `/assets` and the `no-cache` shell are unchanged; this only asks the browser
 * to fetch `sw.js` again. `registerType: 'autoUpdate'` still activates a new
 * worker and reloads the tab. This is not a library sync poll.
 */

/** An open tab re-checks at this pace. Returning to the tab checks sooner. */
export const SERVICE_WORKER_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

export type ServiceWorkerUpdateRegistration = {
  update: () => Promise<unknown>;
};

export type ServiceWorkerUpdateDocument = {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
};

/**
 * Calls `registration.update` on the interval and whenever `target` becomes
 * visible. Does not check on attach: the load that registered the worker
 * already did. Returns a function that removes both.
 */
export function watchServiceWorkerUpdates<Timer>(
  registration: ServiceWorkerUpdateRegistration,
  options?: {
    intervalMs?: number;
    target?: ServiceWorkerUpdateDocument;
    schedule?: (check: () => void, intervalMs: number) => Timer;
    cancel?: (timer: Timer) => void;
  },
): () => void {
  const target = options?.target ?? document;
  const intervalMs = options?.intervalMs ?? SERVICE_WORKER_UPDATE_INTERVAL_MS;

  const check = () => {
    void registration.update().catch(() => {
      // Offline, or the worker script failed to parse. The next check retries.
    });
  };

  const onVisibility = () => {
    if (target.visibilityState === 'visible') check();
  };

  target.addEventListener('visibilitychange', onVisibility);
  // A custom scheduler (tests) owns its handle. The browser path stays on
  // setInterval/clearInterval so the DOM and Node timer types are not mixed.
  if (options?.schedule) {
    const timer = options.schedule(check, intervalMs);
    return () => {
      target.removeEventListener('visibilitychange', onVisibility);
      options.cancel?.(timer);
    };
  }
  const timer = setInterval(check, intervalMs);
  return () => {
    target.removeEventListener('visibilitychange', onVisibility);
    clearInterval(timer);
  };
}

/** Registered once from main, same as the sync and session triggers. */
export function setupServiceWorkerUpdateChecks(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready.then((registration) => {
    watchServiceWorkerUpdates(registration);
  });
}
