/**
 * Renders whatever the service worker has recorded for this tab. The popup
 * never POSTs: it grabs the tab HTML on the Import click (the `activeTab`
 * user-gesture) and hands `{ url, html }` to the worker. See background.js.
 */
import { grabPageSource } from './extract-page.js';

/** A worker killed mid-run cannot clear its own state; don't spin forever. */
const STALE_WORKING_MS = 2 * 60 * 1000;
/** Comfortably inside the server's own 600 000 char / 1 500 000 body caps. */
const MAX_HTML_CHARS = 400_000;

const els = {
  pageTitle: document.getElementById('page-title'),
  status: document.getElementById('status'),
  action: document.getElementById('action'),
  openRecipe: document.getElementById('open-recipe'),
  openSous: document.getElementById('open-sous'),
};

let tabId = null;

function stateKey(id) {
  return `state:${id}`;
}

function setStatus(text, variant, spinning) {
  els.status.className = variant ? `status is-${variant}` : 'status';
  els.status.textContent = '';
  if (spinning) {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    els.status.append(spinner);
  }
  els.status.append(document.createTextNode(text));
}

function showAction(label, onClick) {
  els.action.textContent = label;
  els.action.hidden = false;
  els.action.onclick = onClick;
}

function hideControls() {
  els.action.hidden = true;
  els.openRecipe.hidden = true;
  els.openSous.hidden = true;
}

/**
 * Renders as well as stores, and does not lean on the `onChanged` listener:
 * `storage.session` drops the change event when the value is byte-identical,
 * so a second failure with the same message would leave the spinner up.
 */
async function writeError(message) {
  const state = { phase: 'error', message };
  await chrome.storage.session.set({ [stateKey(tabId)]: state });
  render(state);
}

async function grabFromTab(id) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: grabPageSource,
      args: [MAX_HTML_CHARS],
    });
    const result = injection && injection.result;
    if (result && typeof result.url === 'string' && typeof result.html === 'string') {
      return result;
    }
  } catch (err) {
    console.warn('Sous: page injection failed', err);
  }
  return null;
}

async function startImport() {
  setStatus('Reading the recipe…', null, true);
  hideControls();

  const page = await grabFromTab(tabId);
  const url = page && page.url;
  if (!url || !/^https?:\/\//i.test(url)) {
    await writeError('This page cannot be imported.');
    return;
  }
  if (!page.html.trim()) {
    await writeError('Could not read this page.');
    return;
  }

  // A rejection means the worker never took the page — it failed to start, or
  // the message was too big. Nothing has written `working`, so the stale-run
  // timeout cannot rescue this; say so instead of spinning forever.
  try {
    await chrome.runtime.sendMessage({ type: 'import', tabId, url, html: page.html });
  } catch (err) {
    console.warn('Sous: the importer did not accept the page', err);
    await writeError('Could not start the import.');
  }
}

// Each render* clears the controls itself, because the probe in `init` calls
// renderSignedOut directly rather than going through render().
function renderIdle() {
  hideControls();
  setStatus('');
  showAction('Import to Sous', startImport);
}

function renderSignedOut() {
  hideControls();
  setStatus('Sign in to Sous to import.');
  els.openSous.hidden = false;
}

function isStale(state) {
  return (
    state.phase === 'working' &&
    typeof state.startedAt === 'number' &&
    Date.now() - state.startedAt > STALE_WORKING_MS
  );
}

function render(state) {
  hideControls();

  if (!state) {
    renderIdle();
    return;
  }

  if (isStale(state)) {
    setStatus('That import did not finish.', 'error');
    showAction('Try again', startImport);
    return;
  }

  if (state.phase === 'signedOut') {
    renderSignedOut();
    return;
  }

  if (state.phase === 'working') {
    setStatus(state.detail || 'Reading the recipe…', null, true);
    return;
  }

  if (state.phase === 'done') {
    setStatus(state.title ? `Saved “${state.title}”.` : 'Saved to your library.', 'done');
    els.openRecipe.href = `${state.origin}/recipe/${state.recipeId}`;
    els.openRecipe.hidden = false;
    return;
  }

  setStatus(state.message || 'Import failed.', 'error');
  showAction('Try again', startImport);
}

async function readState() {
  const stored = await chrome.storage.session.get(stateKey(tabId));
  return stored[stateKey(tabId)];
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') {
    setStatus('No page to import.', 'error');
    return;
  }
  tabId = tab.id;

  if (tab.title) {
    els.pageTitle.textContent = tab.title;
    els.pageTitle.hidden = false;
  }

  chrome.storage.session.onChanged.addListener((changes) => {
    const change = changes[stateKey(tabId)];
    if (change) {
      render(change.newValue);
    }
  });

  const stored = await readState();
  render(stored);

  if (stored) {
    return;
  }
  // Only the worker reads cookies, so being signed out is something the popup
  // has to ask about rather than discover when an import fails.
  const probe = await chrome.runtime.sendMessage({ type: 'probe' }).catch(() => null);
  if (probe && probe.signedIn === false && !(await readState())) {
    renderSignedOut();
  }
}

void init();
