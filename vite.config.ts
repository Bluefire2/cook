import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  server: {
    proxy: {
      // Local stand-in for Vercel functions; see scripts/dev-api-server.ts
      '/api': 'http://localhost:3001',
    },
  },
  plugins: [
    {
      name: 'legal-html',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/privacy' || req.url?.startsWith('/privacy?')) {
            req.url = '/privacy.html';
          } else if (req.url === '/terms' || req.url?.startsWith('/terms?')) {
            req.url = '/terms.html';
          }
          next();
        });
      },
    },
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        navigateFallbackDenylist: [/^\/api\//, /^\/privacy$/, /^\/terms$/],
      },
      manifest: {
        name: 'Sous',
        short_name: 'Sous',
        description: 'Personal recipe book with an AI cooking assistant',
        display: 'standalone',
        start_url: '/',
        theme_color: '#1c1917',
        background_color: '#1c1917',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
});
