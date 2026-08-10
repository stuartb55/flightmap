import { stat } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page, type Response } from '@playwright/test'

async function openFlightmap(page: Page) {
  await page.goto('/')
  /*
   * The shell's content region rather than the header brand. The live map runs
   * without a header at narrow widths — the map takes that space — so the brand
   * is not a signal that exists on every layout this suite covers. Both render
   * in the same pass, so this waits for exactly as much as it used to.
   */
  await expect(page.getByRole('main')).toBeVisible()
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

/** A drag in steps, which is what a sheet gesture has to look like to be one. */
async function dragVertically(page: Page, target: Locator, distance: number) {
  const box = await target.boundingBox()
  if (!box) throw new Error('The drag target is not on screen')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(x, y + (distance * step) / 8)
  await page.mouse.up()
}

test('loads live data and supports primary navigation', async ({ page }) => {
  await openFlightmap(page)
  await expect(page.getByRole('main')).toBeVisible()

  /*
   * A phone tab bar holds four targets, so the three pages a receiver is not
   * watched through minute to minute are behind More. The header nav on wider
   * layouts carries all six, and this walks whichever of the two the viewport
   * has.
   */
  const openNavigation = async () => {
    const more = page.locator('.mobile-nav').getByRole('button', { name: 'More' })
    if (await more.isVisible()) await more.click()
  }

  await page.getByRole('link', { name: 'History' }).first().click()
  await expect(page).toHaveTitle('History · Flightmap')
  await expect(page.getByRole('heading', { name: 'Flight history' })).toBeVisible()

  await openNavigation()
  await page.getByRole('link', { name: 'System' }).first().click()
  await expect(page).toHaveTitle('System · Flightmap')
  await expect(page.getByRole('heading', { name: 'System' })).toBeVisible({ timeout: 15_000 })

  await openNavigation()
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
  await page.getByRole('combobox', { name: /^Theme/ }).selectOption('light')
  await page.getByRole('combobox', { name: /^Density/ }).selectOption('compact')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.reload()
  // The blocking bootstrap script stamps this before anything paints, so it is
  // already correct on the very first evaluation after navigation.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')

  await page.getByRole('combobox', { name: /^Theme/ }).selectOption('dark')
  await page.getByRole('combobox', { name: /^Density/ }).selectOption('comfortable')
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
  // Named for what they show about this aircraft, because "Live" and "History"
  // are also two of the tabs along the bottom and went somewhere else.
  await expect(details.getByRole('link', { name: 'On the map' })).toBeVisible()
  await expect(details.getByRole('link', { name: 'Past flights' })).toBeVisible()

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

/*
 * The marker is passive by design — no alert row, no sound, no nav badge — so
 * the flow worth covering end to end is the one a reader actually drives:
 * choose a window in Settings, see the marks, filter to them, turn it off.
 */
test('marks new sightings, filters to them, and turns the marker off', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The filter drawer is a desktop-panel concern')
  await openFlightmap(page)
  const panel = page.locator('.desktop-aircraft-panel')
  await expect(panel.locator('.aircraft-identity').first()).toBeVisible({ timeout: 15_000 })

  // A week covers every airframe the fake receiver has ever reported.
  await page.getByRole('link', { name: 'Settings' }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 15_000 })
  await page.getByLabel('New sightings').selectOption('week')

  await page.getByRole('link', { name: 'Live' }).first().click()
  await expect(panel.locator('.aircraft-identity').first()).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.new-sighting-badge').first()).toBeVisible({ timeout: 15_000 })
  // The badge is decorative; the row's own label is what carries the fact.
  await expect(
    panel.getByRole('button', { name: /, new to this receiver$/ }).first(),
  ).toBeVisible()

  await page.getByRole('button', { name: /^Filters/ }).click()
  const drawer = page.getByRole('dialog', { name: 'Aircraft filters' })
  const newOnly = drawer.getByRole('checkbox', { name: /New sightings only/ })
  await newOnly.check()
  await expect(panel.locator('tr[data-aircraft-row]').first()).toBeVisible()
  await expect(panel.locator('.new-sighting-badge').first()).toBeVisible()

  // Switching marking off must not strand the reader behind a filter they can
  // no longer reach: the list stays populated and the control explains itself.
  await page.getByRole('link', { name: 'Settings' }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 15_000 })
  await page.getByLabel('New sightings').selectOption('off')

  await page.getByRole('link', { name: 'Live' }).first().click()
  await expect(panel.locator('.aircraft-identity').first()).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.new-sighting-badge')).toHaveCount(0)
  await page.getByRole('button', { name: /^Filters/ }).click()
  await expect(drawer.getByRole('checkbox', { name: /New sightings only/ })).toBeDisabled()
  await expect(panel.locator('tr[data-aircraft-row]').first()).toBeVisible()
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

/*
 * The airport dataset is downloaded by an operator, so a stock deployment has none
 * and a configured one does. Both are acceptance criteria, and they are two
 * tests rather than one because the endpoint is cached on purpose: a fresh
 * context per state is the honest way to see each, and Playwright gives one
 * per test. Tests in this file run in order, so the pair leaves the
 * installation as it found it.
 */
async function setAirports(page: Page, items: unknown[]) {
  const response = await page.request.patch('/api/v1/settings', { data: { mapAirports: items } })
  expect(response.status()).toBe(200)
}

/*
 * The fake receiver always has an aircraft squawking 7700, and the banner that
 * raises sits over the map's top-left controls, so it has to go first or the
 * click waits for an element it can never reach.
 */
async function openLayerMenu(page: Page) {
  /*
   * Retried as a pair, because the two steps race: the emergency banner arrives
   * a moment after the page and sits over the map's top-left controls, and a
   * fresh one can appear between dismissing the last and reaching the button.
   * Dismiss-then-click as one retried unit is what makes this deterministic.
   */
  await expect(async () => {
    const dismiss = page.getByRole('button', { name: 'Dismiss alert banner' })
    if (await dismiss.count()) await dismiss.click({ timeout: 2_000 })
    await expect(page.locator('.alert-banner')).toHaveCount(0)
    await page.getByRole('button', { name: 'Layers', exact: true }).click({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  return page.getByRole('dialog', { name: 'Map layers' })
}

const AIRPORT_FIXTURE = [
  {
    icao: 'EGCC',
    iata: 'MAN',
    name: 'Manchester Airport',
    latitude: 53.349375,
    longitude: -2.279521,
    elevationFt: 257,
    rank: 3,
    runways: [
      {
        ident: '05L/23R',
        lengthFt: 10000,
        lowLatitude: 53.3451,
        lowLongitude: -2.29274,
        highLatitude: 53.3624,
        highLongitude: -2.25714,
      },
    ],
  },
]

/*
 * The dataset is built from the Settings page, so the flow worth covering is
 * the one a person drives. The success path needs the real OurAirports files,
 * which is not something an acceptance test should depend on — that is covered
 * by the service and component tests. What is covered here is the contract that
 * survives a bad day: a source that cannot be read is reported in words, on the
 * page, and leaves both the stored dataset and the rest of the form alone.
 */
test('reports an airport download it could not complete', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The settings form is a desktop control')
  const before = await (await page.request.get('/api/v1/airports')).json()

  /*
   * The centre is checked before anything is downloaded, and the receiver's own
   * position only arrives on the first `receiver.json` poll — so pin it here,
   * or this races that and reports the wrong failure.
   */
  await page.request.patch('/api/v1/settings', {
    data: {
      receiverLatitude: 53.61,
      receiverLongitude: -2.31,
      airportDataUrl: 'http://127.0.0.1:8080/api/v1/nothing-here.csv',
    },
  })
  await page.goto('/settings')
  const card = page.getByRole('heading', { name: 'Airports' }).locator('xpath=ancestor::section')
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card.getByRole('button', { name: /Download/ }).click()

  await expect(card.getByRole('alert')).toContainText(/nothing-here\.csv/, { timeout: 30_000 })
  // The form is still usable, and nothing was thrown away.
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeEnabled()
  expect(await (await page.request.get('/api/v1/airports')).json()).toEqual(before)

  await page.request.patch('/api/v1/settings', {
    data: {
      receiverLatitude: null,
      receiverLongitude: null,
      airportDataUrl: 'https://davidmegginson.github.io/ourairports-data/airports.csv',
    },
  })
})

test('draws airports and credits their source once configured', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The layer menu is a desktop control')
  // Set before the first navigation: the endpoint is cached, so a page that
  // has already fetched the old dataset would rightly keep showing it.
  await setAirports(page, AIRPORT_FIXTURE)

  await openFlightmap(page)
  const toggle = (await openLayerMenu(page)).getByRole('checkbox', { name: /Airports/ })
  await expect(toggle).toBeEnabled()
  await toggle.check()
  await page.keyboard.press('Escape')

  // OurAirports is credited on the GeoJSON source, so it reaches the
  // attribution control — and through it any exported snapshot, which reads
  // its text from that control rather than from a constant.
  await expect(page.locator('.maplibregl-ctrl-attrib-inner')).toContainText('OurAirports', {
    timeout: 20_000,
  })
  await expect(page.locator('.map-legend-body')).toContainText('Airport')
})

test('explains the airport layer rather than offering an empty one', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The layer menu is a desktop control')
  // Back to the stock configuration, which is what the rest of this file wants,
  // and again before the first navigation so the cache cannot mask it.
  await setAirports(page, [])

  await openFlightmap(page)
  const toggle = (await openLayerMenu(page)).getByRole('checkbox', { name: /Airports/ })
  await expect(toggle).toBeDisabled()
  await expect(toggle.locator('xpath=ancestor::label')).toContainText(
    'download it on the Settings page',
  )
  // No data, so nobody is credited for it.
  await expect(page.locator('.maplibregl-ctrl-attrib-inner')).not.toContainText('OurAirports')
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
  // Measuring, sharing and saving an image live behind the overflow now; only
  // the four camera controls kept a permanent place over the map.
  await page.getByRole('button', { name: 'More map tools' }).click()
  await page.getByRole('button', { name: 'Measure distance' }).click()
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

test('shares the live map as a link and as a captioned image', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Sharing is exercised once on desktop Chromium')
  await openFlightmap(page)
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await selectLiveAircraft(page, '.desktop-aircraft-panel', 'FLT0003')
  await expect(page.locator('.detail-panel')).toBeVisible()

  /*
   * The tests run over http://127.0.0.1, where `navigator.clipboard` does not
   * exist — the same as a LAN deployment — so this is the fallback path, and
   * the link has to be readable rather than lost.
   */
  await page.getByRole('button', { name: 'More map tools' }).click()
  await page.getByRole('button', { name: 'Copy link to this view' }).click()
  const readout = page.locator('.map-share-readout')
  await expect(readout).toContainText('Select the link below to copy it')
  const link = await page.getByRole('textbox', { name: 'Link to this view' }).inputValue()
  expect(new URL(link).searchParams.get('view')).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,\d/)
  expect(new URL(link).searchParams.get('aircraft')).toBeTruthy()

  // Opening the link restores the same view: asking the restored page for its
  // own link is the check, because it re-reads the map rather than the URL.
  const opened = await context.newPage()
  await opened.goto(link)
  await expect(opened.locator('.detail-panel')).toBeVisible({ timeout: 15_000 })
  await opened.waitForTimeout(1_500)
  await opened.getByRole('button', { name: 'More map tools' }).click()
  await opened.getByRole('button', { name: 'Copy link to this view' }).click()
  const restored = await opened.getByRole('textbox', { name: 'Link to this view' }).inputValue()
  expect(new URL(restored).search).toBe(new URL(link).search)
  await opened.close()

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'More map tools' }).click()
  await page.getByRole('button', { name: 'Save this view as an image' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^flightmap-live-.*\.png$/)
  const path = await file.path()
  // A blank capture is the failure this guards: reading a WebGL canvas after
  // the frame has been composited returns an empty image, and an empty PNG of
  // one solid colour compresses to a few hundred bytes.
  const { size } = await stat(path)
  expect(size).toBeGreaterThan(20_000)
})

test('opens aircraft profiles and synchronised flight analysis', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The analysis workflow is exercised once on desktop Chromium')
  await openFlightmap(page)
  await selectLiveAircraft(page, '.desktop-aircraft-panel', 'FLT0001')
  await page.locator('.detail-panel').getByRole('link', { name: 'Profile' }).click()
  await expect(page.getByRole('heading', { name: 'FLT0001' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Lifetime aircraft statistics' })).toBeVisible()

  // The observation bars carry their figures in a title attribute, which a
  // keyboard user never reaches; the table beneath them is the equivalent.
  await page.getByText('View observation data table').click()
  await expect(
    page.getByRole('table', { name: /Observations of this aircraft over time/ }),
  ).toBeVisible()

  await page.getByRole('link', { name: 'History' }).last().click()
  const session = page.locator('.session-card button:enabled').first()
  await expect(session).toBeVisible({ timeout: 15_000 })
  await session.click()
  await expect(page.getByRole('region', { name: 'Flight profile and event timeline' })).toBeVisible()
  await page.getByRole('button', { name: /Receiver distance/ }).click()
  await expect(page.getByRole('button', { name: /Receiver distance/ })).toHaveAttribute('aria-pressed', 'true')

  await page.getByText('View flight profile data table').click()
  const profileTable = page.getByRole('table', { name: /Flight profile values/ })
  await expect(profileTable).toBeVisible()
  // Values route through the same formatters as the chart, so the units the
  // rest of the page is showing are the units in the table.
  await expect(profileTable.locator('tbody td').first()).toContainText('ft')
})

/*
 * The panel with a photograph in it, which the default installation never
 * shows: photographs are off until an operator configures a source, and an
 * acceptance run must not reach a third party to prove the panel works. The
 * detail response and the image are both fulfilled locally, which exercises the
 * client's rendering path — the box it reserves, the credit it shows, and the
 * focus ring on the link — without a real one.
 */
test('shows a credited photograph without shifting the page', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The photograph panel is exercised once on desktop Chromium')

  // A 4x3 PNG, so the panel has real intrinsic dimensions to reserve space for.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAFElEQVR4nGP8//8/AzbAxIAD' +
    'DEUJAJgcAgaqp6HTAAAAAElFTkSuQmCC',
    'base64',
  )
  await page.route('**/api/v1/aircraft/*/photo', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: png })
  })
  await page.route('**/api/v1/aircraft/*', async (route) => {
    // Only the detail document; the photo and activity routes have their own.
    if (!/\/aircraft\/[0-9a-f]{6}$/.test(new URL(route.request().url()).pathname)) {
      return route.fallback()
    }
    const response = await route.fetch()
    const body = await response.json() as Record<string, unknown>
    await route.fulfill({
      response,
      json: {
        ...body,
        photo: {
          available: true,
          credit: 'A Photographer',
          linkUrl: 'https://photos.example.test/photo/1',
          width: 4,
          height: 3,
        },
      },
    })
  })

  await openFlightmap(page)
  await selectLiveAircraft(page, '.desktop-aircraft-panel', 'FLT0001')
  await page.locator('.detail-panel').getByRole('link', { name: 'Profile' }).click()
  await expect(page.getByRole('heading', { name: 'FLT0001' })).toBeVisible()

  /*
   * The box is reserved from the cached dimensions rather than from the bytes,
   * so the element has a height before the image has decoded and the page does
   * not shift under a reader who has already started reading it.
   */
  const image = page.locator('.aircraft-photo')
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute('width', '4')
  await expect(image).toHaveAttribute('height', '3')
  const settled = await image.evaluate((element: HTMLImageElement) => element.complete)
  expect(settled).toBe(true)

  // Every licence that permits redisplay wants the credit visible, and a
  // keyboard user has to be able to reach the link and see that they have.
  const credit = page.getByRole('link', { name: 'A Photographer' })
  await expect(credit).toBeVisible()
  await expect(credit).toHaveAttribute('rel', 'noreferrer noopener')
  /*
   * Reached with Tab rather than with `focus()`: the ring is drawn by
   * `:focus-visible`, which a programmatic focus deliberately does not satisfy,
   * so focusing it in code would assert nothing about what a keyboard user
   * sees. Walking there also proves it is reachable at all.
   */
  await page.locator('body').press('Tab')
  for (let step = 0; step < 60 && !(await credit.evaluate((element) => element === document.activeElement)); step += 1) {
    await page.keyboard.press('Tab')
  }
  await expect(credit).toBeFocused()
  const ring = await credit.evaluate((element) => {
    const style = getComputedStyle(element)
    return { outline: style.outlineStyle, width: style.outlineWidth }
  })
  expect(ring.outline).not.toBe('none')
  expect(Number.parseFloat(ring.width)).toBeGreaterThan(0)

  const results = await new AxeBuilder({ page }).analyze()
  const important = results.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  )
  expect(important, important.map((violation) => violation.id).join(', ')).toEqual([])
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

  /*
   * A second track also turns the profile into a comparison: one line per
   * series, each with its own dash so the two are told apart without relying
   * on colour, and an axis that can be aligned on each track's own start —
   * which is the only way two approaches are comparable.
   */
  const profile = page.getByRole('region', { name: 'Flight profile and event timeline' })
  const comparisonLines = profile.locator('path.profile-line.comparison')
  await expect(profile.locator('.profile-series-legend li')).toHaveCount(2)
  await expect(comparisonLines).toHaveCount(2)
  expect(
    await comparisonLines.evaluateAll(
      (paths) =>
        new Set(paths.map((path) => (path as SVGPathElement).style.strokeDasharray)).size,
    ),
  ).toBe(2)
  await expect(profile.getByRole('button', { name: 'Absolute time' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await profile.getByRole('button', { name: 'Align on start' }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('profile')).toBe('aligned')
  // Every series keeps its own keyboard-reachable table of what it plots, and
  // the tables follow the axis the chart is drawn on.
  const disclosures = profile.locator('details.chart-data-table > summary')
  await expect(disclosures).toHaveCount(2)
  for (const disclosure of await disclosures.all()) await disclosure.click()
  await expect(profile.getByRole('table', { name: /Flight profile values/ })).toHaveCount(2)
  await expect(profile.locator('table thead th').first()).toHaveText('Elapsed')
  // The themed sweep above only ever sees History with nothing selected, so
  // the comparison markup is checked where it actually appears.
  const profileAudit = await new AxeBuilder({ page }).include('.flight-profile').analyze()
  expect(
    profileAudit.violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    ),
  ).toEqual([])

  await second.click()
  await expect(timeline).toBeHidden()
  // One track has nothing to compare with, so the axis control stands down —
  // but the choice is still in the URL, and survives the reload below.
  await expect(profile.getByRole('button', { name: 'Align on start' })).toBeHidden()

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
  expect(new URL(page.url()).searchParams.get('profile')).toBe('aligned')
})

/*
 * Ahead of the saved-view test deliberately: a default insights view carries
 * series visibility of its own and applies it on load, which is the point of
 * capturing it there — but it would then be answering this test's question
 * instead of the stored preference.
 */
test('hides an activity series and keeps it hidden across a reload', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Series visibility is exercised once on desktop Chromium')
  await page.goto('/insights')
  const toggles = page.getByRole('group', { name: 'Activity chart series' })
  const positioned = toggles.getByRole('button', { name: 'Positioned reports' })
  await expect(positioned).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.chart-bar.positioned').first()).toBeVisible({ timeout: 15_000 })

  await positioned.click()
  await expect(positioned).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.chart-bar.positioned')).toHaveCount(0)

  // A preference nobody asked to be reset has to survive a cold start.
  await page.goto('/insights')
  await expect(
    page.getByRole('group', { name: 'Activity chart series' })
      .getByRole('button', { name: 'Positioned reports' }),
  ).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.chart-bar.positioned')).toHaveCount(0)
})

test('filters, compares, saves, restores, and exports Insights views', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The mobile Insights layout is covered separately')
  await page.goto('/insights')
  await expect(page.getByRole('heading', { name: 'Activity & coverage' })).toBeVisible()

  /*
   * Records sit above the date controls and are all-time, so the one thing
   * worth asserting about them is that the date controls do not touch them —
   * that is exactly what reads as a bug when it is not said, and what a
   * refactor would quietly break by folding them into the range fetch.
   */
  const records = page.getByRole('region', { name: 'All-time receiver records' })
  await expect(records).toBeVisible()
  await expect(records).toContainText('do not change with the date range below')
  // Only records the receiver has actually set are listed, and a stack that
  // has been up for two minutes has not set all six — so the count is bounded,
  // not fixed.
  const listed = records.locator('li')
  expect(await listed.count()).toBeGreaterThan(0)
  expect(await listed.count()).toBeLessThanOrEqual(6)
  const before = await records.locator('li strong').allTextContents()
  let recordRequests = 0
  page.on('request', (request) => {
    if (request.url().includes('/insights/records')) recordRequests += 1
  })

  await page.getByRole('button', { name: '24 hours' }).click()
  await page.getByLabel('Compare preceding period').check()
  await expect(page.getByRole('region', { name: 'Period comparison' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Receiver range profile' })).toBeVisible()
  expect(await records.locator('li strong').allTextContents()).toEqual(before)
  expect(recordRequests).toBe(0)

  await page.getByRole('button', { name: /Saved views/ }).click()
  await page.getByPlaceholder('View name').fill('E2E Insights')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Apply E2E Insights saved view' })).toBeVisible()
  await page.getByRole('button', { name: 'Close saved views' }).click()
  await page.getByRole('button', { name: '7 days' }).click()
  await page.getByRole('button', { name: /Saved views/ }).click()
  await page.getByRole('button', { name: 'Apply E2E Insights saved view' }).click()
  await expect(page.getByRole('button', { name: '24 hours' })).toHaveAttribute('aria-pressed', 'true')

  // Pinning promotes the view to a chip beside the button; making it the
  // default is what the next arrival opens on.
  await page.getByRole('button', { name: /Saved views/ }).click()
  await page.getByRole('button', { name: 'Pin E2E Insights beside the saved views button' }).click()
  await page.getByRole('button', { name: 'Open insights with E2E Insights by default' }).click()
  await page.getByRole('button', { name: 'Close saved views' }).click()
  const chip = page.getByRole('button', { name: 'Apply pinned view E2E Insights' })
  await expect(chip).toBeVisible()

  await page.getByRole('button', { name: '7 days' }).click()
  await chip.click()
  await expect(page.getByRole('button', { name: '24 hours' })).toHaveAttribute('aria-pressed', 'true')

  // A full document load, so this exercises the default from a cold start
  // rather than from state the page already held.
  await page.goto('/insights')
  await expect(page.getByRole('button', { name: '24 hours' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Apply pinned view E2E Insights' })).toBeVisible()

  const csvDownload = page.waitForEvent('download')
  await page.getByRole('link', { name: 'CSV' }).click()
  await expect((await csvDownload).suggestedFilename()).toMatch(/^flightmap-insights-.*\.csv$/)
  const geoJsonDownload = page.waitForEvent('download')
  await page.getByRole('link', { name: 'GeoJSON' }).click()
  await expect((await geoJsonDownload).suggestedFilename()).toMatch(/^flightmap-coverage-.*\.geojson$/)

  // The chart export leaves the app, so the file itself is the only evidence
  // it worked; the button also has to say so, because nothing else will.
  const pngDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save the activity chart as an image' }).click()
  await expect((await pngDownload).suggestedFilename()).toMatch(
    /^flightmap-insights-activity-.*\.png$/,
  )
  await expect(page.getByText('Image saved.')).toBeVisible()

  await page.getByRole('button', { name: /Saved views/ }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete E2E Insights' }).click()
  await expect(page.getByText('No insights views saved yet.')).toBeVisible()
})

test('drills a pattern cell into History and a range sector into coverage', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The drill-downs are exercised once on desktop Chromium')
  test.slow()
  await page.goto('/insights')
  await expect(page.getByRole('heading', { name: 'Activity & coverage' })).toBeVisible()

  /*
   * A sector lands on the coverage in that direction rather than on a History
   * search: the daily range histogram cannot name the sessions it counted, so
   * the panel says what it is showing instead of implying the two tally.
   */
  const coverage = page.locator('.coverage-panel').last()
  await expect(coverage.getByText(/cells returned/)).toBeVisible({ timeout: 20_000 })
  const allCells = await coverage.getByText(/cells returned/).textContent()
  const sector = page.locator('.range-sector').first()
  if (await sector.count()) {
    // The first sector with data, found by walking rather than by guessing
    // which bearing this receiver happens to hear.
    const sectors = page.locator('.range-sector')
    for (let index = 0; index < 72; index += 1) {
      await sectors.nth(index).click({ force: true })
      const chip = page.locator('.sector-filter-chip')
      await expect(chip).toBeVisible()
      await expect(chip).toContainText('not the reports the sector counted')
      const narrowed = await coverage.getByText(/cells returned/).textContent().catch(() => null)
      if (narrowed && narrowed !== allCells) break
      if (await page.getByText('No coverage cells on this bearing').isVisible()) break
    }
    await page.getByRole('button', { name: 'Show all bearings' }).click()
    await expect(page.locator('.sector-filter-chip')).toHaveCount(0)
  }

  // The pattern grid needs a day of aggregates, so it is only asserted when
  // the receiver has produced one.
  const cell = page.locator('.pattern-grid button.pattern-cell').first()
  if (await cell.count()) {
    // One tab stop for 168 cells, walked by arrow key.
    await expect(page.locator('.pattern-grid button.pattern-cell[tabindex="0"]')).toHaveCount(1)
    await cell.click()
    await expect(page).toHaveURL(/\/history\?.*weekday=\d.*hour=\d/)
    const chip = page.getByRole('status').filter({ hasText: 'started in this hour' })
    await expect(chip).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Clear' }).click()
    await expect(page).not.toHaveURL(/weekday=/)
  }
})

test('drills through Insights without reloading the document or dropping the live feed', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'In-app navigation is exercised once on desktop Chromium')
  // Four surfaces in one test, so it deserves more than the default budget on a
  // loaded runner.
  test.slow()
  // Sockets are tagged with a per-document identifier: a reload would run this
  // script again and open its socket under a new identifier, so comparing the
  // identifiers either side of the drill-through is what proves the feed
  // survived rather than being torn down and re-established.
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    const documentId = `${Date.now()}.${Math.random()}`
    const sockets: { tag: string; socket: WebSocket }[] = []
    Object.defineProperty(window, '__liveSockets', { value: sockets })
    const TrackedWebSocket = function (
      this: WebSocket,
      url: string | URL,
      protocols?: string | string[],
    ) {
      const socket = protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols)
      sockets.push({ tag: `${documentId}#${sockets.length}`, socket })
      return socket
    } as unknown as typeof WebSocket
    Object.setPrototypeOf(TrackedWebSocket, NativeWebSocket)
    TrackedWebSocket.prototype = NativeWebSocket.prototype
    window.WebSocket = TrackedWebSocket
  })
  // Which document each open socket belongs to. A reconnect within the life of
  // one document is the live feed doing its job; a second document id is the
  // SPA having been torn down and rebuilt.
  const openSocketDocuments = async () => {
    const tags = await page.evaluate(() =>
      (window as unknown as { __liveSockets: { tag: string; socket: WebSocket }[] }).__liveSockets
        .filter((entry) => entry.socket.readyState === WebSocket.OPEN)
        .map((entry) => entry.tag),
    )
    return [...new Set(tags.map((tag) => tag.split('#')[0]))]
  }

  await page.goto('/insights')
  await expect(page.getByRole('heading', { name: 'Activity & coverage' })).toBeVisible()
  // The live socket is opened by the app shell, so it is already connected here.
  await expect.poll(openSocketDocuments, { timeout: 15_000 }).not.toEqual([])
  const connectedDocument = await openSocketDocuments()

  // A document load would run the init script again and wipe this marker.
  await page.evaluate(() => { (window as unknown as { __documentMarker?: string }).__documentMarker = 'insights' })
  let documentLoads = 0
  page.on('load', () => { documentLoads += 1 })

  const bar = page.locator('.activity-chart .chart-bar').first()
  await expect(bar).toBeVisible({ timeout: 15_000 })
  await bar.click()
  await expect(page).toHaveURL(/\/history\?from=.+&to=/)
  await expect(page.getByRole('heading', { name: 'Flight history' })).toBeVisible({ timeout: 15_000 })

  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Activity & coverage' })).toBeVisible({ timeout: 15_000 })
  const leader = page.locator('.leader-card').first().locator('a.leader-copy').first()
  await expect(leader).toBeVisible({ timeout: 15_000 })
  await expect(leader).toHaveAttribute('href', /^\/aircraft\//)

  // Modifier and middle clicks are asserted in InsightsPage.test.tsx against the
  // shared Link handler: whether the browser then commits the background tab's
  // navigation is the browser's business, and racing it here only buys flakes.
  await leader.click()
  await expect(page).toHaveURL(/\/aircraft\/[0-9a-f]{6}$/)
  await expect(page.getByRole('region', { name: 'Lifetime aircraft statistics' })).toBeVisible({ timeout: 15_000 })

  expect(documentLoads).toBe(0)
  expect(await page.evaluate(() => (window as unknown as { __documentMarker?: string }).__documentMarker)).toBe('insights')
  // The feed is still being carried by the document that opened it.
  expect(await openSocketDocuments()).toEqual(connectedDocument)
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
  /*
   * By some way the longest test here: the sheet at all three of its stops with
   * and without a selection, two drag gestures, the filters it opens, and two
   * further pages. It runs in about twenty seconds on its own, which leaves
   * nothing spare against the thirty-second default once the other project is
   * competing for the same machine.
   */
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 320, height: 568 })
  await openFlightmap(page)

  /*
   * The sheet is the page rather than something summoned over it, so it is
   * already there, at the stop that names what is overhead and leaves the map
   * the rest of the screen.
   */
  const sheet = page.locator('.live-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('Overhead now')).toBeVisible()
  await expect(sheet.locator('.sheet-nearest-card').first()).toBeVisible({ timeout: 15_000 })
  await expect(sheet.locator('.sheet-rows')).toBeHidden()

  const peek = await page.evaluate(() => {
    const box = document.querySelector('.live-sheet')!.getBoundingClientRect()
    const navigation = document.querySelector('.mobile-nav')!.getBoundingClientRect()
    const legend = document.querySelector('.map-legend')!.getBoundingClientRect()
    const search = document.querySelector('.map-search')!.getBoundingClientRect()
    const stage = document.querySelector('.map-stage')!.getBoundingClientRect()
    const live = document.querySelector('.live-page')!.getBoundingClientRect()
    return {
      sheetTop: box.top,
      sheetBottom: box.bottom,
      sheetHeight: box.height,
      navigationTop: navigation.top,
      legendLeft: legend.left,
      legendRight: legend.right,
      legendBottom: legend.bottom,
      searchLeft: search.left,
      searchRight: search.right,
      // Against the map rather than the viewport: a banner takes its own row
      // above the map and moves everything in it down the page.
      searchInset: search.top - stage.top,
      pageHeight: live.height,
    }
  })
  /*
   * Search leads the row of floating controls at the top of the map, the sheet
   * runs to the bottom of the page above the tab bar, and the map key rides on
   * top of the sheet rather than under it.
   */
  expect(peek.searchInset).toBeLessThan(60)
  expect(peek.searchLeft).toBeGreaterThanOrEqual(0)
  expect(peek.searchRight).toBeLessThanOrEqual(320)
  expect(peek.sheetHeight).toBeLessThan(peek.pageHeight * 0.5)
  expect(peek.sheetBottom).toBeGreaterThanOrEqual(peek.navigationTop - 0.5)
  expect(peek.legendLeft).toBeGreaterThanOrEqual(0)
  expect(peek.legendRight).toBeLessThanOrEqual(320)
  expect(peek.legendBottom).toBeLessThanOrEqual(peek.sheetTop + 0.5)

  // The next stop up is what the list is behind, and it is reached by dragging
  // the sheet as well as by tapping the handle.
  await dragVertically(page, sheet.locator('.live-sheet-heading'), -170)
  await expect(sheet.locator('.sheet-rows')).toBeVisible()
  const half = await page.evaluate(
    () => document.querySelector('.live-sheet')!.getBoundingClientRect().top,
  )
  expect(half).toBeLessThan(peek.sheetTop)

  // Filters are reached from the sheet's own header, which names the ordering
  // the rows below it are in.
  await sheet.getByRole('button', { name: /Nearest first/ }).click()
  await expect(page.getByRole('dialog', { name: 'Aircraft filters' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Aircraft filters' })).toBeHidden()

  /*
   * Picking an aircraft turns the same sheet into that aircraft, back at the
   * peek: the point of the sheet is that working through traffic never buries
   * the map. The corner card the wide layout draws would only repeat what the
   * sheet's own header says, so this width does without it.
   */
  /*
   * Search answers with its matches directly under the field rather than only
   * narrowing the sheet below: at the peek stop that list is a strip at the
   * bottom of the screen, and once an aircraft is selected it is not on screen
   * at all, so typing a callsign used to produce no visible change whatsoever.
   */
  await page.locator('.map-search').getByLabel('Search aircraft').fill('FLT0001')
  const result = page.locator('.map-search-result').filter({ hasText: 'FLT0001' }).first()
  await expect(result).toBeVisible({ timeout: 15_000 })
  await result.click()
  // Picking one is an answer, so the results give the map back.
  await expect(page.locator('.map-search-results')).toBeHidden()

  const detailSheet = page.locator('.detail-panel')
  await expect(detailSheet).toBeVisible()
  await expect(detailSheet.getByRole('heading', { name: 'FLT0001' })).toBeVisible()
  await expect(page.locator('.selected-map-card')).toBeHidden()
  await expect(detailSheet.getByRole('heading', { name: 'Live telemetry' })).toBeHidden()

  const collapsed = await page.evaluate(() => {
    const box = document.querySelector('.detail-panel')!.getBoundingClientRect()
    const stage = document.querySelector('.map-stage')!.getBoundingClientRect()
    const live = document.querySelector('.live-page')!.getBoundingClientRect()
    return {
      sheetTop: box.top,
      sheetHeight: box.height,
      pageHeight: live.height,
      // A banner takes its own row above the map, so measure the band the
      // sheet leaves rather than a share of a stage whose height varies.
      mapVisible: box.top - stage.top,
      sheetBottom: box.bottom,
      pageBottom: live.bottom,
    }
  })
  expect(collapsed.sheetHeight).toBeLessThan(collapsed.pageHeight * 0.5)
  expect(collapsed.mapVisible).toBeGreaterThan(140)
  expect(collapsed.sheetBottom).toBeGreaterThanOrEqual(collapsed.pageBottom - 0.5)

  // At the peek the sheet answers what the map cannot, without an expand.
  for (const reading of ['Altitude', 'Speed', 'Track', 'Range']) {
    await expect(detailSheet.getByRole('term').filter({ hasText: reading })).toBeVisible()
  }
  await expect(detailSheet.getByRole('button', { name: 'Add to watchlist' })).toBeVisible()

  /*
   * The stops above it: the full record, at the cost of the map. A swipe that
   * begins on the star is a swipe rather than a watchlist toggle.
   */
  const star = detailSheet.getByRole('button', { name: 'Add to watchlist' })
  await dragVertically(page, star, -170)
  await expect(detailSheet.getByRole('heading', { name: 'Live telemetry' })).toBeVisible()
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  const swipedTop = await page.evaluate(
    () => document.querySelector('.detail-panel')!.getBoundingClientRect().top,
  )
  expect(swipedTop).toBeLessThan(collapsed.sheetTop)
  await dragVertically(page, detailSheet.locator('.detail-hero-stats'), 170)
  await expect(detailSheet.getByRole('heading', { name: 'Live telemetry' })).toBeHidden()

  // The handle walks the same three stops and wraps at the top, so it never
  // stops answering.
  await page.getByRole('button', { name: 'Show more of the list' }).click()
  await expect(detailSheet.getByRole('heading', { name: 'Live telemetry' })).toBeVisible()
  await page.getByRole('button', { name: 'Show the full list' }).click()
  const full = await page.evaluate(
    () => document.querySelector('.detail-panel')!.getBoundingClientRect().top,
  )
  expect(full).toBeLessThan(swipedTop)
  await page.getByRole('button', { name: 'Collapse the sheet' }).click()
  await expect(detailSheet.getByRole('heading', { name: 'Live telemetry' })).toBeHidden()

  /*
   * Searching for a second aircraft while the first is still open: the case
   * that used to have nowhere to show an answer, since the sheet is the open
   * aircraft rather than the list. Enter takes the best match.
   */
  const search = page.locator('.map-search').getByLabel('Search aircraft')
  await search.fill('FLT0002')
  await expect(page.locator('.map-search-result').first()).toBeVisible({ timeout: 15_000 })
  await search.press('Enter')
  await expect(detailSheet.getByRole('heading', { name: 'FLT0002' })).toBeVisible()

  // A query that names nothing says so rather than leaving the reader to guess
  // whether the field is working.
  await search.fill('ZZZZZZ')
  await expect(page.locator('.map-search-empty')).toHaveText('No aircraft match ZZZZZZ.')
  await search.press('Escape')
  await expect(page.locator('.map-search-results')).toBeHidden()
  // Escape closed the results without also closing the aircraft under them.
  await expect(detailSheet).toBeVisible()
  await page.locator('.map-search').getByRole('button', { name: 'Clear search' }).click()

  /*
   * Four tabs, not six. The three pages a receiver is not watched through
   * minute to minute are behind More, which is where History has to be reached
   * from — the tab bar itself is the only nav at this width.
   */
  await expect(page.locator('.mobile-nav > *')).toHaveCount(4)
  await page.locator('.mobile-nav').getByRole('button', { name: 'More' }).click()
  const more = page.locator('.mobile-more-sheet')
  await expect(more.getByRole('link', { name: 'Settings' })).toBeVisible()
  await more.getByRole('link', { name: 'Insights' }).click()
  await expect(page).toHaveTitle('Insights · Flightmap')
  await expect(more).not.toHaveClass(/open/)

  await page.locator('.mobile-nav').getByRole('link', { name: 'History' }).click()
  await expect(page).toHaveTitle('History · Flightmap')
  const historyLayout = await page.locator('.history-page').evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(historyLayout.scrollHeight).toBe(historyLayout.clientHeight)

  await page.locator('.mobile-nav').getByRole('link', { name: 'Alerts' }).click()
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

  /*
   * Alerts read as a stream at this width: one bordered run per day, each entry
   * carrying a severity rail down its edge in place of the icon tile that cost
   * a card's worth of width to say the same thing.
   */
  const entry = page.locator('.alert-card').first()
  await expect(entry).toBeVisible({ timeout: 15_000 })
  const rail = await entry.locator('.alert-card-icon').evaluate((element) => {
    const box = element.getBoundingClientRect()
    const card = element.parentElement!.getBoundingClientRect()
    return { width: box.width, height: box.height, cardHeight: card.height }
  })
  expect(rail.width).toBeLessThan(6)
  // Short by the hairline between entries, which the rail sits inside of.
  expect(rail.height).toBeGreaterThan(rail.cardHeight - 2)
})
