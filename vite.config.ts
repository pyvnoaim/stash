import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json' with { type: 'json' }

/* Which build this is — package.json's version, which every build context has. A git sha would
   read finer, but Portainer strips .git from its clone before building, so the sha only exists
   where this app is not built. Bump with `npm version patch` when a release should say so;
   __BUILT_AT__ below tells any two builds of one version apart. */

export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(pkg.version),
    __BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    tailwindcss(),
    /* The version the server is serving, as a file rather than only as a constant baked into the
       bundle. `__BUILD__` says which build is *running*; nothing on the page could say which one
       is being served, so "Check now" could only ask the service worker whether it had found a new
       worker — and answered "this is the newest build" to that, to being offline, and to a deploy
       that never rebuilt, all alike. Not precached: the worker's globPatterns list no json, so this
       is always a real request or a failed one, which are the two honest answers. */
    {
      name: 'stash-version',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: pkg.version }) })
      },
    },
    // the offline half: precache the whole bundle so the app opens with no network at all
    VitePWA({
      /* Not autoUpdate: it forces skipWaiting, so a new build replaces the running one under an
         open tab and takes the half-typed line with it. The worker waits and main.tsx offers it. */
      registerType: 'prompt',
      manifest: {
        name: 'Stash',
        short_name: 'Stash',
        description: 'Tasks, ideas and quick notes across projects',
        display: 'standalone',
        background_color: '#0a0a0a',
        theme_color: '#0a0a0a',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
        /* Stash in the phone's share sheet. The three fields arrive as a query on the app's own
           URL and main.tsx reads them with the capture parser, so sharing a page is capturing a
           line. GET, so there is nothing to post at and no service worker in the middle of it. */
        share_target: {
          action: '/',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // pdf.js is heavier than everything else together, but offline is the point here
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // never serve the app shell where the sync API, or the Mac app's download, was asked for
        navigateFallbackDenylist: [/^\/(api|state)/, /^\/Stash\.zip$/],
        runtimeCaching: [{
          /* The pictures in notes. CacheFirst, not NetworkFirst, and it is the one thing here that
             earns it: a blob id is 128 bits of randomness and the bytes behind it never change, so
             a cached copy cannot be stale — there is no newer version of that id to miss. Which
             makes a note read the same offline as on, the way the rest of the app does. */
          urlPattern: /\/api\/blob\/[0-9a-f]{32}$/,
          handler: 'CacheFirst',
          options: {
            cacheName: 'note-pictures',
            cacheableResponse: { statuses: [200] },
            expiration: { maxEntries: 200, maxAgeSeconds: 90 * 86400, purgeOnQuotaError: true },
          },
        }],
      },
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  /* dev talks to a locally running `npm run server` the same way the container serves it — one
     origin, which is what the server checks a write against. Left to itself the proxy rewrites
     Host to its target, and then every POST from the browser is a cross-site one by that test:
     Origin says localhost:5173 and Host says 127.0.0.1:8787. Keep the host the browser asked for. */
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/state': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
})
