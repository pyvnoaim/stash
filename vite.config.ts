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
