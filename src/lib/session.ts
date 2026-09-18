import { useCallback, useEffect, useState } from 'react';
import { clearLibrary } from './libraryMemory';

const SESSION_CACHE_KEY = 'cook.session';

export type SessionUser = { sub: string; email: string; name?: string };

export type SessionStatus = 'loading' | 'signedIn' | 'signedOut' | 'offline';

export type FetchSessionResult =
  | { status: 'signedIn'; user: SessionUser }
  | { status: 'signedOut' }
  | { status: 'offline'; user: SessionUser | null };

type SessionSnapshot = {
  user: SessionUser | null;
  status: SessionStatus;
};

let snapshot: SessionSnapshot = { user: null, status: 'loading' };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function readCachedUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(SESSION_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as SessionUser;
    if (typeof parsed.sub === 'string' && typeof parsed.email === 'string') {
      return parsed;
    }
  } catch {
    // ignore corrupt cache
  }
  return null;
}

export function invalidateSession(): void {
  localStorage.removeItem(SESSION_CACHE_KEY);
  snapshot = { user: null, status: 'signedOut' };
  emit();
  clearLibrary();
}

export async function fetchSession(): Promise<FetchSessionResult> {
  try {
    const response = await fetch('/api/auth/session', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (response.status === 401 || response.status === 403) {
      invalidateSession();
      return { status: 'signedOut' };
    }
    if (!response.ok) {
      const cached = readCachedUser();
      snapshot = { user: cached, status: 'offline' };
      emit();
      return { status: 'offline', user: cached };
    }
    const data = (await response.json()) as { user: SessionUser | null };
    if (data.user) {
      localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(data.user));
      snapshot = { user: data.user, status: 'signedIn' };
      emit();
      return { status: 'signedIn', user: data.user };
    }
    invalidateSession();
    return { status: 'signedOut' };
  } catch {
    const cached = readCachedUser();
    snapshot = { user: cached, status: 'offline' };
    emit();
    return { status: 'offline', user: cached };
  }
}

export function signInHref(returnTo: string): string {
  return `/api/auth/start?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function signOut(): Promise<void> {
  try {
    await fetch('/api/auth/signout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // best-effort server sign-out
  }
  invalidateSession();
}

export function useSession(): {
  user: SessionUser | null;
  status: SessionStatus;
  refresh: () => Promise<void>;
} {
  const [, tick] = useState(0);
  useEffect(() => {
    const listener = () => {
      tick((n) => n + 1);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const refresh = useCallback(async () => {
    await fetchSession();
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void fetchSession();
      }
    };
    const onOnline = () => {
      void fetchSession();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  return { user: snapshot.user, status: snapshot.status, refresh };
}
