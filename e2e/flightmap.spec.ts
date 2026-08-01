import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Response } from '@playwright/test'

async function openFlightmap(page: Page) {
  await page.goto('/')
  const appReady = page.getByRole('link', { name: 'Flightmap live dashboard' })
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

  await page.getByRole('link', { name: 'Settings' }).first().click()
  await expect(page).toHaveTitle('Settings · Flightmap')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  const saveBar = page.locator('.settings-save-bar')
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeVisible()
  await expect(saveBar).toHaveCSS('position', 'static')
})

test('loads the MapLibre worker and style assets without warnings', async ({ page }) => {
  let workerResponse: Response | null = null
  let styleResponse: Response | null = null
  const glyphResponses: Response[] = []
  const failedMapAssets: string[] = []
  const mapWarnings: string[] = []

  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname.includes('maplibre-gl-worker')) {
      workerResponse = response
    }
    if (url.hostname === 'tiles.openfreemap.org' && url.pathname === '/styles/dark') {
      styleResponse = response
    }
    if (url.hostname === 'tiles.openfreemap.org' && url.pathname.startsWith('/fonts/')) {
      glyphResponses.push(response)
    }
    if (
      url.hostname === 'tiles.openfreemap.org' &&
      response.status() >= 400 &&
      ['/fonts/', '/sprites/', '/styles/'].some((path) => url.pathname.startsWith(path))
    ) {
      failedMapAssets.push(`${response.status()} ${url.pathname}`)
    }
  })
  page.on('console', (message) => {
    const text = message.text()
    if (
      text.includes('could not be loaded') ||
      text.includes('Unable to load glyph range')
    ) {
      mapWarnings.push(text)
    }
  })

  await openFlightmap(page)
  await expect.poll(() => workerResponse?.status() ?? 0).toBe(200)
  expect(await workerResponse!.headerValue('content-type')).toMatch(/javascript/)
  await expect.poll(() => styleResponse?.status() ?? 0).toBe(200)
  await expect.poll(() => glyphResponses.length).toBeGreaterThan(0)
  expect(
    glyphResponses.some((response) =>
      decodeURIComponent(response.url()).includes('/fonts/Noto Sans Regular/'),
    ),
  ).toBe(true)
  expect(glyphResponses.every((response) => response.status() === 200)).toBe(true)
  expect(failedMapAssets).toEqual([])
  expect(mapWarnings).toEqual([])
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

test('keeps mobile panels and controls inside the usable viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await openFlightmap(page)

  await page.locator('.mobile-map-actions').getByRole('button', { name: /Aircraft/ }).click()
  const listSheet = page.locator('.mobile-list-sheet')
  await expect(listSheet).toHaveClass(/open/)
  await expect(page.getByRole('dialog', { name: 'Live aircraft list' })).toBeVisible()
  await expect.poll(() => page.locator('.live-page').evaluate((element) => element.scrollTop)).toBe(0)
  await expect.poll(async () => {
    const box = await listSheet.boundingBox()
    return box ? box.y + box.height : Number.POSITIVE_INFINITY
  }).toBeLessThanOrEqual(500.5)

  const liveLayout = await page.evaluate(() => {
    const sheet = document.querySelector('.mobile-list-sheet')!.getBoundingClientRect()
    const list = document.querySelector('.mobile-list-sheet .aircraft-table-wrap')!.getBoundingClientRect()
    const navigation = document.querySelector('.mobile-nav')!.getBoundingClientRect()
    const legend = document.querySelector('.map-legend')!.getBoundingClientRect()
    return {
      sheetTop: sheet.top,
      sheetBottom: sheet.bottom,
      sheetHeight: sheet.height,
      listHeight: list.height,
      navigationTop: navigation.top,
      legendLeft: legend.left,
      legendRight: legend.right,
    }
  })
  expect(liveLayout.sheetTop).toBeGreaterThanOrEqual(63)
  expect(liveLayout.sheetBottom).toBeLessThanOrEqual(liveLayout.navigationTop)
  expect(liveLayout.sheetHeight).toBeGreaterThan(350)
  expect(liveLayout.listHeight).toBeGreaterThan(220)
  expect(liveLayout.legendLeft).toBeGreaterThanOrEqual(0)
  expect(liveLayout.legendRight).toBeLessThanOrEqual(320)

  await page.getByRole('link', { name: 'History' }).last().click()
  await expect(page).toHaveTitle('History · Flightmap')
  const historyLayout = await page.locator('.history-page').evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(historyLayout.scrollHeight).toBe(historyLayout.clientHeight)

  await page.getByRole('link', { name: 'Alerts' }).last().click()
  await expect(page).toHaveTitle('Alerts · Flightmap')
  const toolbarLayout = await page.locator('.alerts-toolbar').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
  }))
  expect(toolbarLayout.scrollWidth).toBe(toolbarLayout.clientWidth)
  expect(toolbarLayout.left).toBeGreaterThanOrEqual(0)
  expect(toolbarLayout.right).toBeLessThanOrEqual(320)
})
