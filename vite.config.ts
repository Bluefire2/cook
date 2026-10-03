import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  server: {
    proxy: {
      // Local stand-in for Vercel functions; see scripts/dev-api-server.ts
      '/api': 'http://localhost:3001',
      '/invite': 'http://localhost:3001',
      // Regex key: a plain '/c' prefix would also catch the SPA's /cooks.
      '^/c/': 'http://localhost:3001',
      // The MCP server: its endpoint, the OAuth pages, and discovery.
      '^/mcp$': 'http://localhost:3001',
      '^/oauth/': 'http://localhost:3001',
      '^/\\.well-known/oauth-': 'http://localhost:3001',
      // Test mode only (testing/test-server.ts); plain dev:api answers 404.
      '^/__test(/|$)': 'http://localhost:3001',
    },
  },
  plugins: [
    {
      name: 'legal-html',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // Same headers scripts/server.ts sends for public collection pages.
          if (req.url === '/p' || req.url?.startsWith('/p/')) {
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('X-Robots-Tag', 'noindex');
          }
          if (req.url === '/privacy' || req.url?.startsWith('/privacy?')) {
            req.url = '/privacy.html';
          } else if (req.url === '/terms' || req.url?.startsWith('/terms?')) {
            req.url = '/terms.html';
          } else if (req.url === '/about' || req.url?.startsWith('/about?')) {
            req.url = '/about.html';
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
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/privacy$/,
          /^\/terms$/,
          /^\/about$/,
          /^\/invite\//,
          /^\/c\//,
          /^\/mcp$/,
          /^\/oauth\//,
          /^\/\.well-known\//,
          // Public collection pages need the server's no-referrer header, so
          // the service worker never answers them from its cached shell.
          /^\/p(\/|$)/,
          // Test mode's sign-in pages (testing/test-server.ts with --static).
          /^\/__test(\/|$)/,
        ],
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
