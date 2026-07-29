import http from 'node:http'

const port = integerFromEnv('PORT', 8081, 1, 65_535)
const receiverLat = numberFromEnv('RECEIVER_LAT', 53.61, -90, 90)
const receiverLon = numberFromEnv('RECEIVER_LON', -2.31, -180, 180)
const initialAircraftCount = integerFromEnv('AIRCRAFT_COUNT', 3, 0, 1_000)

const scenarios = new Set([
  'normal',
  'timeout',
  'invalid-json',
  'partial',
  'duplicate',
  'out-of-order',
  'restart',
  'outage',
  'stale',
  'empty',
])

const state = {
  scenario: 'normal',
  delayMs: 3_000,
  aircraftCount: initialAircraftCount,
  generation: 1,
  messages: 100_000,
  lastNow: Math.floor(Date.now() / 1_000) - 1,
  frozenNow: null,
  customSnapshot: null,
  requests: {
    aircraft: 0,
    receiver: 0,
    stats: 0,
  },
}

function integerFromEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback
}

function numberFromEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback
}

function json(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  response.end(body)
}

function text(response, status, value, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(value),
    'cache-control': 'no-store',
  })
  response.end(value)
}

function nextTimestamp() {
  if (state.frozenNow !== null) {
    return state.frozenNow
  }
  const wallClock = Math.floor(Date.now() / 1_000)
  state.lastNow = Math.max(wallClock, state.lastNow + 1)
  return state.lastNow
}

function hexFor(index) {
  return (0x400001 + index).toString(16).padStart(6, '0').slice(-6)
}

function positionedAircraft(index, now) {
  const row = Math.floor(index / 25)
  const column = index % 25
  const altitude = 2_000 + ((index * 1_175) % 38_000)
  const track = (index * 29 + now) % 360
  const messages = 50 + state.generation * 100 + index * 7

  return {
    hex: hexFor(index),
    type: index % 11 === 0 ? 'mlat' : 'adsb_icao',
    flight: `FLT${String(index + 1).padStart(4, '0')}`,
    r: `G-F${String(index).padStart(3, '0')}`,
    t: index % 3 === 0 ? 'A320' : index % 3 === 1 ? 'B738' : 'E190',
    desc: index % 3 === 0 ? 'AIRBUS A-320' : 'JET AIRCRAFT',
    ownOp: index % 2 === 0 ? 'Fake Air' : 'Example Airways',
    alt_baro: altitude,
    alt_geom: altitude + 125,
    gs: 145 + (index % 320),
    ias: 135 + (index % 240),
    tas: 155 + (index % 310),
    mach: Number((0.35 + (index % 45) / 100).toFixed(3)),
    track,
    track_rate: Number((((index % 7) - 3) / 10).toFixed(2)),
    roll: Number((((index % 17) - 8) / 2).toFixed(1)),
    mag_heading: (track + 3.2) % 360,
    true_heading: track,
    baro_rate: index % 3 === 0 ? 960 : index % 3 === 1 ? -640 : 0,
    geom_rate: index % 3 === 0 ? 928 : index % 3 === 1 ? -608 : 0,
    squawk: index === 7 ? '7700' : '7000',
    emergency: index === 7 ? 'general' : 'none',
    category: index % 4 === 0 ? 'A3' : 'A1',
    nav_qnh: 1013.2,
    nav_altitude_mcp: Math.ceil(altitude / 1_000) * 1_000,
    nav_altitude_fms: Math.ceil(altitude / 1_000) * 1_000,
    nav_heading: Math.round(track),
    nav_modes: ['autopilot', 'althold'],
    lat: receiverLat + 0.08 + row * 0.018 + Math.sin(index + now / 60) * 0.002,
    lon: receiverLon + (column - 12) * 0.025 + Math.cos(index + now / 60) * 0.002,
    nic: 8,
    rc: 186,
    seen_pos: 0.2,
    version: 2,
    nic_baro: 1,
    nac_p: 9,
    nac_v: 2,
    sil: 3,
    sil_type: 'perhour',
    gva: 2,
    sda: 2,
    mlat: index % 11 === 0 ? ['lat', 'lon', 'track'] : [],
    tisb: [],
    messages,
    seen: 0.1,
    rssi: -8 - (index % 35),
    alert: index === 7 ? 1 : 0,
    spi: 0,
    unknown_future_field: { accepted: true },
  }
}

function aircraftFor(now) {
  if (state.scenario === 'empty') {
    return []
  }

  const aircraft = Array.from(
    { length: state.aircraftCount },
    (_, index) => positionedAircraft(index, now),
  )

  // The default three-record fixture deliberately covers full, ground/MLAT,
  // and sparse/no-position inputs. Larger fixtures keep every row positioned
  // so they are useful for 250-aircraft ingestion load tests.
  if (aircraft.length > 1 && state.aircraftCount <= 3) {
    aircraft[1] = {
      ...aircraft[1],
      type: 'mlat',
      flight: 'GROUND1 ',
      alt_baro: 'ground',
      alt_geom: null,
      gs: 14.2,
      track: 91.5,
      baro_rate: null,
      geom_rate: null,
      mlat: ['lat', 'lon', 'track', 'gs'],
      seen: 0.4,
      seen_pos: 0.5,
    }
  }
  if (aircraft.length > 2 && state.aircraftCount <= 3) {
    aircraft[2] = {
      hex: aircraft[2].hex,
      type: 'mode_s',
      flight: 'SPARSE  ',
      alt_baro: 12_000,
      squawk: '7000',
      messages: aircraft[2].messages,
      seen: 2.4,
      rssi: -31.5,
    }
  }

  if (state.scenario === 'stale') {
    return aircraft.map((item) => ({
      ...item,
      seen: 25,
      ...(item.lat === undefined ? {} : { seen_pos: 25 }),
    }))
  }

  if (state.scenario === 'partial') {
    return [
      ...aircraft,
      { hex: 'NOT-ICAO', lat: 'north', lon: {}, messages: -4 },
      null,
      { type: 'adsb_icao', lat: receiverLat, lon: receiverLon },
    ]
  }

  return aircraft
}

function aircraftSnapshot() {
  if (state.customSnapshot !== null) {
    return structuredClone(state.customSnapshot)
  }

  let now
  if (state.scenario === 'duplicate') {
    now = state.lastNow
  } else if (state.scenario === 'out-of-order') {
    now = state.lastNow - 10
  } else {
    now = nextTimestamp()
  }

  if (state.scenario === 'restart') {
    state.generation += 1
    state.messages = 0
    state.scenario = 'normal'
  }

  state.messages += Math.max(1, state.aircraftCount) * 8
  return {
    now,
    messages: state.messages,
    aircraft: aircraftFor(now),
  }
}

function receiverSnapshot() {
  return {
    version: `readsb fake 1.0 (generation ${state.generation})`,
    refresh: 1_000,
    lat: receiverLat,
    lon: receiverLon,
  }
}

function statsSnapshot() {
  const end = Math.floor(Date.now() / 1_000)
  const accepted = Math.max(0, state.messages)
  const period = {
    start: end - 60,
    end,
    local: {
      blocks_processed: 9_000,
      blocks_dropped: state.scenario === 'stale' ? 12 : 0,
      modeac: 5,
      modes: accepted + 100,
      bad: state.scenario === 'partial' ? 17 : 2,
      unknown_icao: 3,
      accepted: [accepted, 4, 0],
      signal: -19.4,
      peak_signal: -2.1,
      noise: -36.7,
    },
    messages: accepted,
    cpu: {
      demod: 41,
      reader: 9,
      background: 4,
    },
  }
  return {
    latest: period,
    last1min: period,
    last5min: { ...period, start: end - 300 },
    last15min: { ...period, start: end - 900 },
    total: { ...period, start: end - 3_600 },
  }
}

async function readBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 1_048_576) {
      throw new Error('request body exceeds 1 MiB')
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : JSON.parse(raw)
}

function publicState() {
  return {
    scenario: state.scenario,
    delayMs: state.delayMs,
    aircraftCount: state.aircraftCount,
    generation: state.generation,
    messages: state.messages,
    lastNow: state.lastNow,
    frozenNow: state.frozenNow,
    hasCustomSnapshot: state.customSnapshot !== null,
    requests: state.requests,
  }
}

async function updateControl(request, response) {
  let update
  try {
    update = await readBody(request)
  } catch (error) {
    json(response, 400, { error: 'invalid_body', message: error.message })
    return
  }

  const requestedScenario = update.scenario ?? update.mode
  if (requestedScenario !== undefined) {
    if (!scenarios.has(requestedScenario)) {
      json(response, 422, {
        error: 'unknown_scenario',
        allowed: [...scenarios],
      })
      return
    }
    state.scenario = requestedScenario
  }

  if (update.delayMs !== undefined) {
    if (!Number.isInteger(update.delayMs) || update.delayMs < 0 || update.delayMs > 60_000) {
      json(response, 422, { error: 'invalid_delay' })
      return
    }
    state.delayMs = update.delayMs
  }

  if (update.aircraftCount !== undefined) {
    if (
      !Number.isInteger(update.aircraftCount) ||
      update.aircraftCount < 0 ||
      update.aircraftCount > 1_000
    ) {
      json(response, 422, { error: 'invalid_aircraft_count' })
      return
    }
    state.aircraftCount = update.aircraftCount
  }

  if (update.frozenNow === null) {
    state.frozenNow = null
  } else if (update.frozenNow !== undefined) {
    if (!Number.isFinite(update.frozenNow) || update.frozenNow < 0) {
      json(response, 422, { error: 'invalid_frozen_time' })
      return
    }
    state.frozenNow = update.frozenNow
    state.lastNow = update.frozenNow
  }

  if (update.clearCustomSnapshot === true) {
    state.customSnapshot = null
  }

  json(response, 200, publicState())
}

async function setCustomSnapshot(request, response) {
  let snapshot
  try {
    snapshot = await readBody(request)
  } catch (error) {
    json(response, 400, { error: 'invalid_body', message: error.message })
    return
  }

  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    !Array.isArray(snapshot.aircraft)
  ) {
    json(response, 422, {
      error: 'invalid_snapshot',
      message: 'Expected an object containing an aircraft array.',
    })
    return
  }

  state.customSnapshot = snapshot
  json(response, 200, {
    accepted: true,
    aircraftCount: snapshot.aircraft.length,
  })
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  if (request.method === 'GET' && url.pathname === '/health') {
    json(response, 200, { status: 'ok' })
    return
  }

  if (request.method === 'GET' && url.pathname === '/__control') {
    json(response, 200, publicState())
    return
  }

  if (request.method === 'POST' && url.pathname === '/__control') {
    await updateControl(request, response)
    return
  }

  if (request.method === 'POST' && url.pathname === '/__control/snapshot') {
    await setCustomSnapshot(request, response)
    return
  }

  if (request.method === 'POST' && url.pathname === '/__control/reset') {
    Object.assign(state, {
      scenario: 'normal',
      delayMs: 3_000,
      aircraftCount: initialAircraftCount,
      generation: 1,
      messages: 100_000,
      lastNow: Math.floor(Date.now() / 1_000) - 1,
      frozenNow: null,
      customSnapshot: null,
      requests: { aircraft: 0, receiver: 0, stats: 0 },
    })
    json(response, 200, publicState())
    return
  }

  if (url.pathname.startsWith('/data/') && state.scenario === 'outage') {
    json(response, 503, { error: 'receiver_offline' })
    return
  }

  if (url.pathname.startsWith('/data/') && state.scenario === 'timeout') {
    await new Promise((resolve) => setTimeout(resolve, state.delayMs))
  }

  if (request.method === 'GET' && url.pathname === '/data/aircraft.json') {
    state.requests.aircraft += 1
    if (state.scenario === 'invalid-json') {
      text(response, 200, '{"now":', 'application/json; charset=utf-8')
      return
    }
    json(response, 200, aircraftSnapshot())
    return
  }

  if (request.method === 'GET' && url.pathname === '/data/receiver.json') {
    state.requests.receiver += 1
    json(response, 200, receiverSnapshot())
    return
  }

  if (request.method === 'GET' && url.pathname === '/data/stats.json') {
    state.requests.stats += 1
    json(response, 200, statsSnapshot())
    return
  }

  json(response, 404, {
    error: 'not_found',
    endpoints: [
      '/data/aircraft.json',
      '/data/receiver.json',
      '/data/stats.json',
      '/__control',
      '/health',
    ],
  })
})

server.requestTimeout = 65_000
server.headersTimeout = 66_000

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      message: 'fake receiver listening',
      port,
      receiverLat,
      receiverLon,
      aircraftCount: initialAircraftCount,
    })}\n`,
  )
})

function shutdown(signal) {
  process.stdout.write(
    `${JSON.stringify({ level: 'info', message: 'fake receiver stopping', signal })}\n`,
  )
  server.closeIdleConnections()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
