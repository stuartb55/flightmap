const baseUrl = process.env.FLIGHTMAP_LOAD_URL ?? "http://127.0.0.1:8080";
const total = Number(process.env.LOAD_REQUESTS ?? 120);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 12);

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
    p95Ms: Math.round(p95)
  }) + "\n"
);
if (failures > maximumFailures || p95 > 2_000) process.exitCode = 1;
