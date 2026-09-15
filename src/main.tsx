import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { applyCacheOwnership, OWNER_UID_KEY } from './lib/cacheOwner';
import { photoStore } from './lib/photoStore';
import { seedIfEmpty } from './lib/seed';
import { fetchSession } from './lib/session';
import { settings } from './lib/settings';
import { applyTheme } from './lib/theme';
import './index.css';

applyTheme(settings.getTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

void fetchSession()
  .then(async (result) => {
    if (result.status === 'signedIn') {
      await applyCacheOwnership(result.user.sub);
      return;
    }
    if (result.status === 'signedOut' && !localStorage.getItem(OWNER_UID_KEY)) {
      await seedIfEmpty();
    }
  })
  .then(() => photoStore.sweepUnreferenced())
  .catch((err) => console.error(err));
