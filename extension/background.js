/**
 * The import runs here, not in the popup: popups are destroyed the moment they
 * lose focus, and an extraction takes seconds. Progress and results live in
 * `chrome.storage.session` keyed by tab, so reopening the popup rejoins a run.
 */
import { grabPageSource } from './extract-page.js';

const COOKIE_NAME = 'sous_session';

/**
 * Dev before production, deliberately: production-first would send local test
 * imports at the real library. `runImport` only moves to the next candidate
 * when the request fails at the network level, so a stale localhost cookie —
 * they last 90 days and are not port-scoped — cannot strand production.
 */
const CANDIDATE_ORIGINS = ['http://localhost:5173', 'https://sous.kyrylo.lol'];

/** Comfortably inside the server's own 600 000 char / 1 500 000 body caps. */
const MAX_HTML_CHARS = 400_000;
const REQUEST_TIMEOUT_MS = 90_000;
/** MV3 idles a worker out after 30s; any extension API call resets the timer. */
const KEEPALIVE_MS = 20_000;

export function stateKey(tabId) {
  return `state:${tabId}`;
}

async function writeState(tabId, state) {
  await chrome.storage.session.set({ [stateKey(tabId)]: state });
}

async function resolveTargets() {
  const targets = [];
  for (const origin of CANDIDATE_ORIGINS) {
    let cookie = null;
    try {
      cookie = await chrome.cookies.get({ url: `${origin}/`, name: COOKIE_NAME });
    } catch (err) {
      console.warn('Sous: cookie lookup failed for', origin, err);
    }
    if (cookie && cookie.value) {
      targets.push({ origin, token: cookie.value });
    }
  }
  return targets;
}

async function grabFromTab(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: grabPageSource,
      args: [MAX_HTML_CHARS],
    });
    const result = injection && injection.result;
    if (result && typeof result.url === 'string' && typeof result.html === 'string') {
      return result;
    }
  } catch (err) {
    // Restricted pages (chrome://, the Web Store, the PDF viewer) refuse
    // injection. The server-side fetch can still cover a page whose URL we know.
    console.warn('Sous: page injection failed', err);
  }
  return null;
}

async function tabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab && typeof tab.url === 'string' ? tab.url : null;
  } catch {
    return null;
  }
}

async function post(target, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${target.origin}/api/extension/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sous-Session': target.token,
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function runImport(tabId) {
  const targets = await resolveTargets();
  if (targets.length === 0) {
    await writeState(tabId, { phase: 'signedOut' });
    return;
  }

  await writeState(tabId, { phase: 'working', startedAt: Date.now() });

  const page = await grabFromTab(tabId);
  const url = (page && page.url) || (await tabUrl(tabId));
  if (!url || !/^https?:\/\//i.test(url)) {
    await writeState(tabId, {
      phase: 'error',
      message: 'This page cannot be imported.',
    });
    return;
  }

  const body = JSON.stringify({ url, html: (page && page.html) || '' });
  const keepAlive = setInterval(() => {
    void chrome.runtime.getPlatformInfo();
  }, KEEPALIVE_MS);

  try {
    let timedOut = false;
    for (const target of targets) {
      let response;
      try {
        response = await post(target, body);
      } catch (err) {
        // Only a network-level failure falls through to the next origin. Any
        // real HTTP answer — including 401 and 404 — is this run's answer.
        timedOut = timedOut || err.name === 'AbortError';
        console.warn('Sous: could not reach', target.origin, err);
        continue;
      }

      const data = await response.json().catch(() => null);
      if (!response.ok || !data || typeof data.id !== 'string') {
        await writeState(tabId, {
          phase: 'error',
          message: (data && data.error) || `Import failed (${response.status}).`,
        });
        return;
      }

      await writeState(tabId, {
        phase: 'done',
        recipeId: data.id,
        title: typeof data.title === 'string' ? data.title : '',
        // The origin that actually answered, so the link cannot point at a
        // server that never saw this recipe.
        origin: target.origin,
      });
      return;
    }

    await writeState(tabId, {
      phase: 'error',
      message: timedOut ? 'The import timed out.' : 'Could not reach Sous.',
    });
  } finally {
    clearInterval(keepAlive);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'import' && typeof message.tabId === 'number') {
    void runImport(message.tabId);
    sendResponse({ started: true });
    return false;
  }
  if (message && message.type === 'probe') {
    void resolveTargets().then((targets) => sendResponse({ signedIn: targets.length > 0 }));
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(stateKey(tabId));
});
