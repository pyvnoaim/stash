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
        /* The push half, kept out of the generated worker: generateSW writes the caching and
           nothing else, so the two handlers a notification needs — one to show it, one to open
           the app where it points — ride in as a plain script rather than by owning the whole
           worker (injectManifest) for thirty lines. */
        importScripts: ['/push-sw.js'],
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
          urlPattern: /\/api\/mexc\/candles/,
          handler: 'NetworkFirst',
          options: {
            cacheName: 'candles-mexc',
            networkTimeoutSeconds: 10,
            cacheableResponse: { statuses: [200] },
            expiration: { maxEntries: 60, maxAgeSeconds: 30 * 86400, purgeOnQuotaError: true },
          },
        }, {
          /* Gold's feed, on the same footing as Binance's bars: the candles endpoint only, never
             the ticker beside it. Matched on the path, so the signed calls to the same host — which
             go through the server and never appear here anyway — could not join by accident. */
          urlPattern: /^https:\/\/api\.bitget\.com\/api\/v2\/mix\/market\/candles/,
          handler: 'NetworkFirst',
          options: {
            cacheName: 'candles-bitget',
            networkTimeoutSeconds: 10,
            cacheableResponse: { statuses: [200] },
            expiration: { maxEntries: 60, maxAgeSeconds: 30 * 86400, purgeOnQuotaError: true },
          },
        }, {
          /* Twelve Data reports its own errors with 200 OK, so a rate-limited reply caches like a
             good one and is what you get offline until the next success replaces it. Living with
             it: generateSW takes serialisable config only, so filtering the body would mean owning
             the whole service worker. The app already renders that body as the error it is. */
          /* The history call and nothing else: outputsize=5000 is what fetchCandles asks for, and
             the mover sweep asks the same endpoint for the last eight hourly bars. That one is a
             live reading in the same way the ticker is — served from cache it announces an hour
             that is over, to someone offline who cannot check. Matched on the size so the two
             cannot be confused, and sw-routes.test.ts holds both halves of that against the
             worker that actually shipped. */
          urlPattern: /^https:\/\/api\.twelvedata\.com\/time_series\?.*outputsize=5000/,
          handler: 'NetworkFirst',
          options: {
            cacheName: 'candles-twelvedata',
            networkTimeoutSeconds: 10,
            cacheableResponse: { statuses: [200] },
            expiration: { maxEntries: 60, maxAgeSeconds: 30 * 86400, purgeOnQuotaError: true },
          },
        }, {
          /* The pictures in notes. CacheFirst, not NetworkFirst, and it is the one thing here that
             earns it: a blob id is 128 bits of randomness and the bytes behind it never change, so
             a cached copy cannot be stale — there is no newer version of that id to miss. Which
             makes a note read the same offline as on, the way the rest of the app does.
             The market feeds above are the opposite case and stay NetworkFirst: a candle has a
             newer version, and serving yesterday's as today's is the failure worth avoiding. */
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
