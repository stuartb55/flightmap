import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.FLIGHTMAP_E2E_URL ?? 'http://127.0.0.1:8080'

export default defineConfig({
  testDir: './e2e',
  // These acceptance tests share one stateful application/database and include
  // installation-wide mutations, so tests within a project must stay ordered.
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Mutations fail closed without an Origin header, and the API request
    // context does not send one on its own.
    extraHTTPHeaders: { origin: baseURL },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
})
