const baseUrl = process.env.FLIGHTMAP_LOAD_URL ?? "http://127.0.0.1:8080";
const total = Number(process.env.LOAD_REQUESTS ?? 120);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 12);
const fakeReceiverUrl = process.env.FLIGHTMAP_FAKE_RECEIVER_URL;

if (
  !Number.isInteger(total) ||
  total < 1 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > total
) {
  throw new Error("LOAD_REQUESTS and LOAD_CONCURRENCY must be positive integers");
}

const latencies = [];
let failures = 0;
let next = 0;
const ingestionScenarios = [];
let clientRenderBudget = null;
let liveSnapshotBudget = null;

async function worker() {
  while (next < total) {
    const index = next;
    next += 1;
    const path =
      index % 4 === 0 ? "/api/v1/status" : "/api/v1/aircraft/live";
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { accept: "application/json" }
      });
      if (!response.ok) failures += 1;
      else await response.arrayBuffer();
    } catch {
      failures += 1;
    }
    latencies.push(performance.now() - started);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

async function waitForCurrentAircraft(target) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/v1/aircraft/live`, {
      headers: { accept: "application/json" }
    });
    if (response.ok) {
      const snapshot = await response.json();
      if (
        Array.isArray(snapshot.aircraft) &&
        snapshot.aircraft.length >= target &&
        (snapshot.receiver?.snapshotAgeSeconds ?? Infinity) <= 5
      ) {
        return snapshot;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Collector did not expose ${target} current aircraft within 30 seconds`);
}

async function exerciseIngestion(target) {
  const configure = await fetch(`${fakeReceiverUrl}/__control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: "normal", aircraftCount: target })
  });
  if (!configure.ok) {
    throw new Error(`Fake receiver rejected ${target}-aircraft scenario (${configure.status})`);
  }
  const started = performance.now();
  const snapshot = await waitForCurrentAircraft(target);
  const collectedInMs = performance.now() - started;
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86_400_000);
  const query = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    bucket: "day"
  });
  const insightStarted = performance.now();
  const insightResponse = await fetch(
    `${baseUrl}/api/v1/insights/overview?${query.toString()}`,
    { headers: { accept: "application/json" } }
  );
  const insightMs = performance.now() - insightStarted;
  if (!insightResponse.ok) {
    throw new Error(`30-day Insights query failed (${insightResponse.status})`);
  }
  await insightResponse.arrayBuffer();
  if (insightMs > 2_000) {
    throw new Error(`30-day Insights query took ${Math.round(insightMs)}ms with ${target} aircraft`);
  }
  ingestionScenarios.push({
    aircraftPerSecond: target,
    currentAircraft: snapshot.aircraft.length,
    snapshotAgeSeconds: snapshot.receiver.snapshotAgeSeconds,
    collectedInMs: Math.round(collectedInMs),
    insight30DayMs: Math.round(insightMs)
  });
  return snapshot;
}

/**
 * What the 1 Hz snapshot itself costs, measured on its own rather than mixed in
 * with the status requests the p95 above averages over. The query joins the
 * watchlist, the alert events, the metadata and the summary in one statement,
 * so this is the number that says whether a join added to it is affordable —
 * it has to complete comfortably inside the one-second poll it feeds.
 */
async function measureLiveSnapshot(expectedAircraft) {
  const samples = [];
  let carriedFirstSeen = 0;
  for (let pass = 0; pass < 20; pass += 1) {
    const started = performance.now();
    const response = await fetch(`${baseUrl}/api/v1/aircraft/live`, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Live snapshot failed (${response.status})`);
    const snapshot = await response.json();
    samples.push(performance.now() - started);
    carriedFirstSeen = snapshot.aircraft.filter(
      (item) => "firstSeenAt" in item
    ).length;
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  liveSnapshotBudget = {
    aircraft: expectedAircraft,
    medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(1)),
    p95Ms: Number(p95.toFixed(1)),
    carriedFirstSeen
  };
  // The join is only worth having if every row actually carries the field.
  if (carriedFirstSeen < expectedAircraft) {
    throw new Error(
      `Only ${carriedFirstSeen} of ${expectedAircraft} live rows carried firstSeenAt`
    );
  }
  if (p95 > 400) {
    throw new Error(
      `Live snapshot p95 was ${p95.toFixed(0)}ms with ${expectedAircraft} aircraft`
    );
  }
}

/** The subset of the client aircraft shape that filtering and sorting read. */
function toClientAircraft(item) {
  return {
    icao: item.icao.toLowerCase(),
    callsign: item.callsign,
    registration: item.metadata?.registration ?? null,
    typeCode: item.metadata?.typeCode ?? null,
    operator: item.metadata?.operator ?? null,
    latitude: item.latitude,
    longitude: item.longitude,
    altitudeBaro: item.onGround ? "ground" : item.altitudeBarometricFt,
    groundSpeed: item.groundSpeedKt,
    verticalRate: item.barometricRateFpm,
    track: item.trackDeg,
    trueHeading: item.trueHeadingDeg,
    squawk: item.squawk,
    category: item.category,
    source: item.source,
    seenSeconds: item.seenSeconds,
    distanceNm: item.distanceNm,
    watched: item.watched,
    hasActiveAlert: item.hasActiveAlert,
    firstSeenAt: item.firstSeenAt
  };
}

function medianPassMs(passes, run) {
  const samples = [];
  for (let pass = 0; pass < passes; pass += 1) {
    const started = performance.now();
    run(pass);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)];
}

/**
 * What the live table costs the browser for a snapshot this size: the ordering
 * pass that runs on every filter change, the cheaper one that runs at 1 Hz, and
 * the number of rows windowing actually puts in the DOM. Measured with the same
 * modules the web workspace ships, imported directly by Node's type stripping.
 */
async function measureClientRenderBudget(snapshot) {
  const { defaultAircraftFilters, orderAircraft } = await import(
    "../../apps/web/src/lib/aircraft-filter.ts"
  );
  const { windowRange } = await import("../../apps/web/src/lib/use-window-list.ts");
  const aircraft = snapshot.aircraft.map(toClientAircraft);
  const filters = { ...defaultAircraftFilters };
  const sort = { key: "distance", direction: "asc" };

  // A change of filters: nothing can be reused, so this is filter plus sort.
  const coldMs = medianPassMs(25, () => orderAircraft(aircraft, filters, sort, null, 0));
  // A snapshot with the same aircraft in it, which is the once-a-second case.
  const warm = orderAircraft(aircraft, filters, sort, null, 0);
  const warmMs = medianPassMs(25, () => orderAircraft(aircraft, filters, sort, warm, 0));

  // A tall desktop panel, against the 70px row height the stylesheet fixes.
  const window = windowRange({
    count: warm.list.length,
    rowHeight: 70,
    scrollTop: 0,
    viewportHeight: 1_200
  });
  const renderedRows = window.end - window.start;

  clientRenderBudget = {
    aircraft: aircraft.length,
    orderedAircraft: warm.list.length,
    coldOrderMs: Number(coldMs.toFixed(2)),
    warmOrderMs: Number(warmMs.toFixed(2)),
    renderedRows
  };
  if (coldMs > 25) throw new Error(`Ordering ${aircraft.length} aircraft took ${coldMs.toFixed(1)}ms`);
  if (warmMs > 10) {
    throw new Error(`Reapplying the order to ${aircraft.length} aircraft took ${warmMs.toFixed(1)}ms`);
  }
  if (renderedRows > 32) {
    throw new Error(`Windowing left ${renderedRows} of ${warm.list.length} rows in the table`);
  }
}

if (fakeReceiverUrl) {
  await exerciseIngestion(250);
  const thousand = await exerciseIngestion(1_000);
  await measureLiveSnapshot(thousand.aircraft.length);
  await measureClientRenderBudget(thousand);
}

latencies.sort((left, right) => left - right);
const percentile = (fraction) =>
  latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))] ??
  Infinity;
const p95 = percentile(0.95);
const maximumFailures = Math.max(1, Math.floor(total * 0.01));
process.stdout.write(
  JSON.stringify({
    requests: total,
    concurrency,
    failures,
    p50Ms: Math.round(percentile(0.5)),
    p95Ms: Math.round(p95),
    ingestionScenarios,
    liveSnapshotBudget,
    clientRenderBudget
  }) + "\n"
);
if (failures > maximumFailures || p95 > 2_000) process.exitCode = 1;
