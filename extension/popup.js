/**
 * Renders whatever the service worker has recorded for this tab. The popup
 * never fetches and never holds the import itself — see background.js.
 */
const SIGN_IN_URL = 'https://sous.kyrylo.lol';
/** A worker killed mid-run cannot clear its own state; don't spin forever. */
const STALE_WORKING_MS = 2 * 60 * 1000;

const els = {
  pageTitle: document.getElementById('page-title'),
  status: document.getElementById('status'),
  action: document.getElementById('action'),
  openRecipe: document.getElementById('open-recipe'),
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

function startImport() {
  setStatus('Reading the recipe…', null, true);
  els.action.hidden = true;
  els.openRecipe.hidden = true;
  void chrome.runtime.sendMessage({ type: 'import', tabId });
}

function renderIdle() {
  setStatus('');
  showAction('Import to Sous', startImport);
}

function renderSignedOut() {
  setStatus('Sign in to Sous to import.');
  showAction('Open Sous', () => {
    void chrome.tabs.create({ url: SIGN_IN_URL });
  });
}

function isStale(state) {
  return (
    state.phase === 'working' &&
    typeof state.startedAt === 'number' &&
    Date.now() - state.startedAt > STALE_WORKING_MS
  );
}

function render(state) {
  els.action.hidden = true;
  els.openRecipe.hidden = true;

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
    setStatus('Reading the recipe…', null, true);
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
