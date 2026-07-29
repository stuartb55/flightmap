import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

async function openFlightmap(page: Page) {
  await page.goto('/')
  const tokenInput = page.getByLabel('Access token')
  const appReady = page.getByRole('link', { name: 'Flightmap live dashboard' })
  await expect(tokenInput.or(appReady)).toBeVisible()
  if (await tokenInput.isVisible()) {
    await tokenInput.fill(
      process.env.FLIGHTMAP_E2E_TOKEN ?? 'flightmap-ci-access-token',
    )
    await page.getByRole('button', { name: 'Open flightmap' }).click()
  }
  await expect(appReady).toBeVisible()
}

test('loads live data and supports primary navigation', async ({ page }) => {
  await openFlightmap(page)
  await expect(page.getByRole('main')).toBeVisible()

  await page.getByRole('link', { name: 'History' }).first().click()
  await expect(page).toHaveTitle('History · Flightmap')
  await expect(page.getByRole('heading', { name: 'Flight history' })).toBeVisible()

  await page.getByRole('link', { name: 'System' }).first().click()
  await expect(page).toHaveTitle('System · Flightmap')
  await expect(page.getByRole('heading', { name: 'System' })).toBeVisible()
})

test('has no serious automated accessibility violations', async ({ page }) => {
  await openFlightmap(page)
  const results = await new AxeBuilder({ page })
    .disableRules(['color-contrast'])
    .analyze()
  const important = results.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  )
  expect(important).toEqual([])
})
