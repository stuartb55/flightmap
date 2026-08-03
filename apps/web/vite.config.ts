import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        id: '/',
        name: 'Flightmap · ADS-B Receiver',
        short_name: 'Flightmap',
        description: 'Live receiver traffic and 30-day ADS-B flight history',
        theme_color: '#070b10',
        background_color: '#070a0e',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        orientation: 'any',
        categories: ['travel', 'utilities'],
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          {
            name: 'Live traffic',
            short_name: 'Live',
            description: 'Open the live aircraft map',
            url: '/',
            icons: [{ src: '/pwa-192x192.png', sizes: '192x192' }],
          },
          {
            name: 'Flight history',
            short_name: 'History',
            description: 'Browse recent flight history',
            url: '/history',
            icons: [{ src: '/pwa-192x192.png', sizes: '192x192' }],
          },
          {
            name: 'Alerts',
            short_name: 'Alerts',
            description: 'Review receiver alerts',
            url: '/alerts',
            icons: [{ src: '/pwa-192x192.png', sizes: '192x192' }],
          },
        ],
      },
      workbox: {
        // Server-rendered index.html includes deployment-specific receiver and
        // map settings, so navigation uses a network-first runtime cache rather
        // than Workbox's build-time navigation fallback.
        globPatterns: ['**/*.{html,js,css,png,svg,ico,webmanifest}'],
        // The PWA plugin adds manifest icons and the manifest itself separately.
        globIgnores: [
          '**/pwa-*.png',
          '**/maskable-*.png',
          '**/manifest.webmanifest',
        ],
        // Keep / on the network-first route instead of rewriting it to the
        // precached /index.html response while the server is reachable.
        directoryIndex: null,
        navigateFallback: null,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) =>
              request.mode === 'navigate' &&
              !url.pathname.startsWith('/api/') &&
              !url.pathname.startsWith('/health/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'flightmap-pages',
              networkTimeoutSeconds: 4,
              cacheableResponse: { statuses: [0, 200] },
              // This build-time shell covers the first offline launch, before
              // a server-rendered page has had a chance to enter the page cache.
              precacheFallback: { fallbackURL: '/index.html' },
              expiration: {
                maxEntries: 8,
                maxAgeSeconds: 7 * 24 * 60 * 60,
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.FLIGHTMAP_API_URL ?? 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: process.env.BUILD_SOURCEMAP === 'true',
    // MapLibre is isolated as a long-lived vendor chunk; the application
    // chunks remain below 100 kB and load independently.
    chunkSizeWarningLimit: 1_100,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('maplibre-gl')) return 'maplibre'
          if (id.includes('node_modules/react')) return 'react'
          return undefined
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    coverage: {
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/vite-env.d.ts'],
      thresholds: {
        lines: 50,
        functions: 42,
        branches: 43,
        statements: 48,
      },
    },
  },
})
