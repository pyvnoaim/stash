import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

/* Which build this is, stamped in at build time — the update prompt tells you a new one is
   waiting, and this is the other half: what you are on now. A checkout without git, or a source
   tarball, still builds; it simply has nothing to call itself. */
const build = (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim() } catch { return 'source' }
})()

export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(build),
    __BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    tailwindcss(),
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
        // never serve the app shell where the sync API was asked for
        navigateFallbackDenylist: [/^\/(api|state)/],
        /* Candle history, kept so the Markets tool still draws with no network: the signals are
           maths over bars that already closed, and they read the same on a plane as at a desk.
           Network first, so a live reading is never the cache's to give — it answers only once the
           feed has failed. Bars only. The ticker is deliberately absent: a stale price fires the
           alerts in notification-bell against a number that isn't true any more, and the watcher
           is written so a *missing* price fires nothing. Missing is the honest answer offline. */
        runtimeCaching: [{
          urlPattern: /^https:\/\/api\.binance\.com\/api\/v3\/klines/,
          handler: 'NetworkFirst',
          options: {
            cacheName: 'candles-binance',
            networkTimeoutSeconds: 10,
            cacheableResponse: { statuses: [200] },
            expiration: { maxEntries: 60, maxAgeSeconds: 30 * 86400, purgeOnQuotaError: true },
          },
        }, {
          /* Twelve Data reports its own errors with 200 OK, so a rate-limited reply caches like a
             good one and is what you get offline until the next success replaces it. Living with
             it: generateSW takes serialisable config only, so filtering the body would mean owning
             the whole service worker. The app already renders that body as the error it is. */
          urlPattern: /^https:\/\/api\.twelvedata\.com\/time_series/,
          handler: 'NetworkFirst',
          options: {
            cacheName: 'candles-twelvedata',
            networkTimeoutSeconds: 10,
            cacheableResponse: { statuses: [200] },
            expiration: { maxEntries: 60, maxAgeSeconds: 30 * 86400, purgeOnQuotaError: true },
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
