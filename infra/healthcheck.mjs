const kind = process.argv[2] === 'ready' ? 'ready' : 'live'
const port = process.env.APP_PORT ?? '8080'
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 4_000)

try {
  const response = await fetch(`http://127.0.0.1:${port}/health/${kind}`, {
    signal: controller.signal,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    process.exitCode = 1
  }
} catch {
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
}
