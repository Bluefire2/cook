import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { clearLibrary, discardLegacyCookDb, markLoaded } from './lib/libraryMemory';
import { fetchSession } from './lib/session';
import { setupSyncTriggers, triggerSyncAfterSession } from './lib/syncEngine';
import { settings } from './lib/settings';
import { applyTheme } from './lib/theme';
import './index.css';

applyTheme(settings.getTheme());
discardLegacyCookDb();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

setupSyncTriggers();

void fetchSession()
  .then((result) => {
    if (result.status === 'signedIn') {
      triggerSyncAfterSession(result.user.sub);
      return;
    }
    clearLibrary();
    markLoaded();
  })
  .catch((err) => console.error(err));
