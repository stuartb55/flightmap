import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Response } from '@playwright/test'

async function openFlightmap(page: Page) {
  await page.goto('/')
  const appReady = page.getByRole('link', { name: 'Flightmap live dashboard' })
  await expect(appReady).toBeVisible()
}

/**
 * The list is windowed, so a given aircraft is only in the DOM when it is near
 * the viewport. Search for it first, which is what a user does anyway.
 */
async function selectLiveAircraft(page: Page, panel: string, callsign: string) {
  const list = page.locator(panel)
  await expect(list.locator('.aircraft-identity').first()).toBeVisible({ timeout: 15_000 })
  await list.getByLabel('Search aircraft').fill(callsign)
  const row = list.getByRole('button', { name: `Select ${callsign}` })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
}

async function expectSavedViewsClearOfSelectedAircraft(page: Page) {
  const layout = await page.locator('.map-stage').evaluate((element) => {
    const savedViews = element.querySelector('.map-saved-views .saved-view-button')!.getBoundingClientRect()
    const selectedAircraft = element.querySelector('.selected-map-card')!.getBoundingClientRect()
    return {
      savedViewsBottom: savedViews.bottom,
      selectedAircraftTop: selectedAircraft.top,
    }
  })
  expect(layout.selectedAircraftTop - layout.savedViewsBottom).toBeGreaterThanOrEqual(6)
}

test('loads live data and supports primary navigation', async ({ page }) => {
  await openFlightmap(page)
  await expect(page.getByRole('main')).toBeVisible()

  await page.getByRole('link', { name: 'History' }).first().click()
  await expect(page).toHaveTitle('History · Flightmap')
  await expect(page.getByRole('heading', { name: 'Flight history' })).toBeVisible()

  await page.getByRole('link', { name: 'System' }).first().click()
  await expect(page).toHaveTitle('System · Flightmap')
  await expect(page.getByRole('heading', { name: 'System' })).toBeVisible({ timeout: 15_000 })

  await page.getByRole('link', { name: 'Settings' }).first().click()
  await expect(page).toHaveTitle('Settings · Flightmap')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 15_000 })
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

/**
 * Both themes, because a light theme built by overriding token values is only
 * as good as its contrast: the automated pass is what catches a token that was
 * flipped without being re-checked.
 */
for (const theme of ['dark', 'light'] as const) {
  test(`has no serious automated accessibility violations in the ${theme} theme`, async ({
    page,
  }) => {
    await page.addInitScript((value) => {
      localStorage.setItem(
        'flightmap.appearance.v1',
        JSON.stringify({ theme: value, density: 'comfortable' }),
      )
    }, theme)
    for (const path of ['/', '/history', '/insights', '/alerts', '/system', '/settings']) {
      await page.goto(path)
      await expect(page.getByRole('main')).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      const results = await new AxeBuilder({ page }).analyze()
      const important = results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? ''),
      )
      expect(
        important,
        `${theme} ${path}: ${important.map((violation) => violation.id).join(', ')}`,
      ).toEqual([])
    }
  })
}

test('remembers the appearance across a reload without a flash of the wrong theme', async ({
  page,
}) => {
  await page.goto('/settings')
  await page.getByLabel('Theme', { exact: false }).selectOption('light')
  await page.getByLabel('Density', { exact: false }).selectOption('compact')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.reload()
  // The blocking bootstrap script stamps this before anything paints, so it is
  // already correct on the very first evaluation after navigation.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')

  await page.getByLabel('Theme', { exact: false }).selectOption('dark')
  await page.getByLabel('Density', { exact: false }).selectOption('comfortable')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('supports live selection and optimistic watchlist editing', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The mobile selection flow is covered by the viewport test')
  await request.delete('/api/v1/watchlist/400001')
  await openFlightmap(page)
  await selectLiveAircraft(page, '.desktop-aircraft-panel', 'FLT0001')
  const details = page.locator('.detail-panel')
  await expect(details).toBeVisible()
  await expect(page.locator('.selected-map-card')).toBeVisible()
  await expectSavedViewsClearOfSelectedAircraft(page)
  await expect(details.getByRole('link', { name: 'Live' })).toBeVisible()
  await expect(details.getByRole('link', { name: 'History' })).toBeVisible()

  const addResponse = page.waitForResponse((response) =>
    response.request().method() === 'PUT' && response.url().includes('/api/v1/watchlist/'),
  )
  await details.getByRole('button', { name: 'Add to watchlist' }).click()
  expect((await addResponse).status()).toBe(200)
  await expect(details.getByRole('button', { name: 'On watchlist' })).toBeVisible()
  await details.getByLabel('Watchlist label').fill('E2E aircraft')
  await details.getByLabel('Notes').fill('Edited by the browser acceptance test')
  await details.getByRole('button', { name: 'Save watchlist details' }).click()
  await expect(details.getByRole('button', { name: 'Save watchlist details' })).toBeDisabled()

  const removeResponse = page.waitForResponse((response) =>
    response.request().method() === 'DELETE' && response.url().includes('/api/v1/watchlist/'),
  )
  await details.getByRole('button', { name: 'On watchlist' }).click()
  expect((await removeResponse).status()).toBe(204)
  await expect(details.getByRole('button', { name: 'Add to watchlist' })).toBeVisible()
})

test('windows the live list instead of rendering every aircraft', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Row windowing is a desktop-panel concern')
  await openFlightmap(page)
  const table = page.locator('.desktop-aircraft-panel .aircraft-table')
  const rows = table.locator('tr[data-aircraft-row]')
  await expect(rows.first()).toBeVisible({ timeout: 15_000 })

  // The receiver reports hundreds of aircraft; the table reports all of them to
  // assistive technology while keeping a small fraction in the tree.
  const total = Number(await table.getAttribute('aria-rowcount'))
  expect(total).toBeGreaterThan(100)
  expect(await rows.count()).toBeLessThan(40)
  await expect(rows.first()).toHaveAttribute('aria-rowindex', '2')

  await page.locator('.desktop-aircraft-panel .aircraft-table-wrap').evaluate((element) => {
    element.scrollTo({ top: 4_000 })
  })
  await expect
    .poll(async () => Number(await rows.first().getAttribute('aria-rowindex')))
    .toBeGreaterThan(20)
  expect(await rows.count()).toBeLessThan(40)
})

test('isolates an altitude band from the map legend', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The legend is expanded by default on desktop only')
  await openFlightmap(page)
  const table = page.locator('.desktop-aircraft-panel .aircraft-table')
  // Wait for a whole snapshot: a partial first render would make any later
  // count look like a filtered one.
  await expect
    .poll(async () => Number(await table.getAttribute('aria-rowcount')), { timeout: 15_000 })
    .toBeGreaterThan(100)
  const everything = Number(await table.getAttribute('aria-rowcount'))

  const band = page.locator('.map-altitude-scale button[data-band="middle"]')
  await expect(band).toHaveAccessibleName('Show only aircraft from 10,000 ft to 20,000 ft')
  await band.click()
  await expect(band).toHaveAttribute('aria-pressed', 'true')
  await expect(band).toHaveAccessibleName(
    'Show every altitude again instead of only aircraft from 10,000 ft to 20,000 ft',
  )
  await expect
    .poll(async () => Number(await table.getAttribute('aria-rowcount')))
    .toBeLessThan(everything)

  // The legend and the drawer are two views of the same filter.
  await page.getByRole('button', { name: /Filters/ }).first().click()
  const drawer = page.getByRole('dialog', { name: 'Aircraft filters' })
  await expect(drawer.getByLabel('Minimum altitude')).toHaveValue('10000')
  await expect(drawer.getByLabel('Maximum altitude')).toHaveValue('20000')
  await drawer.getByLabel('Maximum altitude').fill('30000')
  await expect(band).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Escape')

  // Pressing the isolated band again puts every altitude back.
  await band.click()
  await expect(band).toHaveAttribute('aria-pressed', 'true')
  await band.click()
  await expect
    .poll(async () => Number(await table.getAttribute('aria-rowcount')))
    .toBe(everything)
})

test('pins a popup to the selected aircraft and dismisses it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The pinned popup is a wide-screen affordance')
  await openFlightmap(page)
  await selectLiveAircraft(page, '.desktop-aircraft-panel', 'FLT0001')
  const popup = page.locator('.map-popup-card')
  await expect(popup).toBeVisible()
  await expect(popup.getByRole('link', { name: 'Profile' })).toHaveAttribute(
    'href',
    '/aircraft/400001',
  )
  const violations = await new AxeBuilder({ page }).include('.maplibregl-popup').analyze()
  expect(violations.violations.filter((item) => ['serious', 'critical'].includes(item.impact ?? ''))).toEqual([])

  // The popup must not hold focus hostage: Escape reaches the page.
  await page.keyboard.press('Escape')
  await expect(popup).toBeHidden()
  await expect(page).toHaveURL(/\/(\?.*)?$/)

  await selectLiveAircraft(page, '.desktop-aircraft-panel', 'FLT0001')
  await popup.getByRole('button', { name: 'Close aircraft popup' }).click()
  await expect(popup).toBeHidden()

  // Clicking the map itself, away from any aircraft, also clears the selection.
  await selectLiveAircraft(page, '.desktop-aircraft-panel', 'FLT0001')
  const canvas = (await page.locator('.map-stage .radar-map-canvas').boundingBox())!
  await page.mouse.click(canvas.x + 30, canvas.y + canvas.height * 0.75)
  await expect(popup).toBeHidden()
  await expect(page.locator('.detail-panel')).toBeHidden()
})

test('measures distance and bearing with the ruler', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'One pass over the ruler is enough')
  await openFlightmap(page)
  await page.getByRole('button', { name: 'Measure distance and bearing' }).click()
  const readout = page.locator('.map-ruler-readout')
  await expect(readout).toContainText('Click two points to measure')

  const canvas = (await page.locator('.map-stage .radar-map-canvas').boundingBox())!
  await page.mouse.click(canvas.x + canvas.width * 0.3, canvas.y + canvas.height * 0.35)
  await expect(readout).toContainText('Click the second point')
  await page.mouse.click(canvas.x + canvas.width * 0.6, canvas.y + canvas.height * 0.7)
  await expect(readout).toContainText(/\d+(\.\d+)? nm/)
  await expect(readout).toContainText(/\d{3}°/)
  // Measuring must not select whatever happened to be under the pointer.
  await expect(page).toHaveURL(/\/(\?.*)?$/)
  await expect(page.locator('.detail-panel')).toBeHidden()

  await page.keyboard.press('Escape')
  await expect(readout).toContainText('Click two points to measure')
  await page.keyboard.press('Escape')
  await expect(readout).toBeHidden()
})

test('opens aircraft profiles and synchronised flight analysis', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The analysis workflow is exercised once on desktop Chromium')
  await openFlightmap(page)
  await selectLiveAircraft(page, '.desktop-aircraft-panel', 'FLT0001')
  await page.locator('.detail-panel').getByRole('link', { name: 'Profile' }).click()
  await expect(page.getByRole('heading', { name: 'FLT0001' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Lifetime aircraft statistics' })).toBeVisible()

  await page.getByRole('link', { name: 'History' }).last().click()
  const session = page.locator('.session-card button:enabled').first()
  await expect(session).toBeVisible({ timeout: 15_000 })
  await session.click()
  await expect(page.getByRole('region', { name: 'Flight profile and event timeline' })).toBeVisible()
  await page.getByRole('button', { name: /Receiver distance/ }).click()
  await expect(page.getByRole('button', { name: /Receiver distance/ })).toHaveAttribute('aria-pressed', 'true')
})

test('previews, creates, toggles, and removes a custom alert rule', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Installation-wide alert rule mutation is exercised once')
  // Rules are installation-wide, so a retry must not inherit the rule a failed attempt left behind.
  const existing = await (await request.get('/api/v1/alerts/rules')).json() as { items: { id: string, name: string }[] }
  for (const rule of existing.items.filter((item) => item.name === 'E2E nearby aircraft')) {
    await request.delete(`/api/v1/alerts/rules/${rule.id}`)
  }

  await page.goto('/alerts')
  await page.getByLabel('Rule name').fill('E2E nearby aircraft')
  await page.getByLabel('Maximum distance (nm)').fill('100')
  await page.getByRole('button', { name: 'Preview matches' }).click()
  await expect(page.getByText(/current aircraft match|No current aircraft match/)).toBeVisible()
  await page.getByRole('button', { name: 'Create rule' }).click()
  const rule = page.locator('.custom-rule-list article').filter({ hasText: 'E2E nearby aircraft' })
  await expect(rule).toHaveCount(1)
  await rule.getByRole('checkbox').uncheck()
  await expect(rule).toContainText('Disabled')
  await rule.getByRole('button', { name: 'Delete E2E nearby aircraft' }).click()
  await expect(rule).toHaveCount(0)
})

test('restores selected history tracks, replay position, and exports after refresh', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The mobile history layout is covered separately')
  await page.goto('/history')
  const search = page.getByPlaceholder('ICAO, callsign, registration, type…')
  // A callsign prefix rather than one callsign: this exercises comparing two
  // tracks, which needs a second session to select.
  await search.fill('FLT000')
  await page.getByRole('button', { name: 'Search history' }).click()
  const session = page.locator('.session-card button:enabled').first()
  await expect(session).toBeVisible({ timeout: 15_000 })
  await session.click()
  const tray = page.getByRole('region', { name: 'Selected tracks' })
  await expect(tray).toBeVisible()

  // The colour control re-keys the map legend to whatever the tracks now mean.
  await tray.getByLabel('Colour tracks by').selectOption('speed')
  await expect(page.locator('.map-altitude-scale')).toHaveAttribute(
    'aria-label',
    'Track ground speed colour scale',
  )

  // A second track brings up the timeline, which is what makes the overlap
  // between them visible; removing it again leaves one track selected.
  const second = page.locator('.session-card button:enabled').nth(1)
  await second.click()
  const timeline = page.getByRole('region', { name: 'Session timeline' })
  await expect(timeline.locator('.timeline-lane')).toHaveCount(2)
  await second.click()
  await expect(timeline).toBeHidden()

  const downloadPromise = page.waitForEvent('download')
  await tray.getByRole('link', { name: /telemetry as CSV/ }).first().click()
  await expect((await downloadPromise).suggestedFilename()).toMatch(/^flightmap-session-.*\.csv$/)
  // Re-ordering is part of the search, so it travels in the URL — and it does
  // not cost the selection already on the map.
  await page.getByLabel('Sort sessions').selectOption('closest_asc')
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('closest_asc')
  await expect(tray).toBeVisible()

  await page.getByRole('button', { name: 'Play replay' }).click()
  await expect.poll(() => new URL(page.url()).searchParams.getAll('session').length).toBe(1)
  await expect.poll(() => new URL(page.url()).searchParams.has('replay')).toBe(true)

  await page.reload()
  await expect(page.getByRole('region', { name: 'Selected tracks' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: /Pause replay|Play replay/ })).toBeVisible()
  await expect(page.getByLabel('Sort sessions')).toHaveValue('closest_asc')
})

test('filters, compares, saves, restores, and exports Insights views', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The mobile Insights layout is covered separately')
  await page.goto('/insights')
  await expect(page.getByRole('heading', { name: 'Activity & coverage' })).toBeVisible()
  await page.getByRole('button', { name: '24 hours' }).click()
  await page.getByLabel('Compare preceding period').check()
  await expect(page.getByRole('region', { name: 'Period comparison' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Receiver range profile' })).toBeVisible()

  await page.getByRole('button', { name: /Saved views/ }).click()
  await page.getByPlaceholder('View name').fill('E2E Insights')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Apply E2E Insights saved view' })).toBeVisible()
  await page.getByRole('button', { name: 'Close saved views' }).click()
  await page.getByRole('button', { name: '7 days' }).click()
  await page.getByRole('button', { name: /Saved views/ }).click()
  await page.getByRole('button', { name: 'Apply E2E Insights saved view' }).click()
  await expect(page.getByRole('button', { name: '24 hours' })).toHaveAttribute('aria-pressed', 'true')

  const csvDownload = page.waitForEvent('download')
  await page.getByRole('link', { name: 'CSV' }).click()
  await expect((await csvDownload).suggestedFilename()).toMatch(/^flightmap-insights-.*\.csv$/)
  const geoJsonDownload = page.waitForEvent('download')
  await page.getByRole('link', { name: 'GeoJSON' }).click()
  await expect((await geoJsonDownload).suggestedFilename()).toMatch(/^flightmap-coverage-.*\.geojson$/)

  await page.getByRole('button', { name: /Saved views/ }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete E2E Insights' }).click()
  await expect(page.getByText('No insights views saved yet.')).toBeVisible()
})

test('shows retained data through a WebSocket interruption and reconnects', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'WebSocket recovery is exercised once on desktop Chromium')
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    let connectionCount = 0
    const InterceptedWebSocket = function (
      this: WebSocket,
      url: string | URL,
      protocols?: string | string[],
    ) {
      const socket = protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols)
      connectionCount += 1
      if (connectionCount === 1) {
        socket.addEventListener('open', () => {
          window.setTimeout(() => socket.close(4001, 'Acceptance test interruption'), 1_000)
        }, { once: true })
      }
      return socket
    } as unknown as typeof WebSocket
    Object.setPrototypeOf(InterceptedWebSocket, NativeWebSocket)
    InterceptedWebSocket.prototype = NativeWebSocket.prototype
    window.WebSocket = InterceptedWebSocket
  })
  await openFlightmap(page)
  await expect(page.locator('.desktop-aircraft-panel .aircraft-identity').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Live feed interrupted')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Last snapshot remains on screen')).toBeVisible()
  await expect(page.getByText('Live feed interrupted')).not.toBeVisible({ timeout: 20_000 })
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

  await selectLiveAircraft(page, '.mobile-list-sheet', 'FLT0001')
  await expect(page.locator('.selected-map-card')).toBeVisible()
  await expectSavedViewsClearOfSelectedAircraft(page)

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
