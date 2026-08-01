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
}

if (fakeReceiverUrl) {
  await exerciseIngestion(250);
  await exerciseIngestion(1_000);
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
    ingestionScenarios
  }) + "\n"
);
if (failures > maximumFailures || p95 > 2_000) process.exitCode = 1;
