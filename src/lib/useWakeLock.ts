import { useEffect } from 'react';

/**
 * Keeps the screen awake while the component is mounted (iOS Safari 16.4+).
 * Re-acquires the lock when the page becomes visible again, since the
 * browser releases it on tab switch / screen off.
 */
export function useWakeLock(): void {
  useEffect(() => {
    let sentinel: WakeLockSentinel | null = null;

    const request = async () => {
      if (!('wakeLock' in navigator)) return;
      try {
        sentinel = await navigator.wakeLock.request('screen');
      } catch {
        // Denied (e.g. low battery mode) — nothing to do.
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void request();
    };

    void request();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release();
    };
  }, []);
}
