import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // the offline half: precache the whole bundle so the app opens with no network at all
    VitePWA({
      registerType: 'autoUpdate',
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
  // dev talks to a locally running `node server/index.ts` the same way the container serves it
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/state': 'http://127.0.0.1:8787',
    },
  },
})
