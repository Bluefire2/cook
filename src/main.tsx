import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { seedIfEmpty } from './lib/seed';
import { settings } from './lib/settings';
import { applyTheme } from './lib/theme';
import './index.css';

applyTheme(settings.getTheme());

void seedIfEmpty();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
