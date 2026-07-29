# Controllable fake readsb receiver

This dependency-free Node service exposes compatible `aircraft.json`,
`receiver.json`, and `stats.json` responses under `/data`. It is intended for
integration and load tests, not production.

Run it directly:

```sh
PORT=8081 AIRCRAFT_COUNT=3 node infra/fake-receiver/server.mjs
```

Or run the Compose testing profile without publishing another host port:

```sh
docker compose --profile testing up -d fake-receiver
```

When the app also runs in Compose, set the receiver data URL in Flightmap
Settings to `http://fake-receiver:8081/data`.

The control endpoint accepts JSON:

```sh
curl -X POST http://127.0.0.1:8081/__control \
  -H 'content-type: application/json' \
  -d '{"scenario":"partial"}'
```

Supported scenarios are `normal`, `timeout`, `invalid-json`, `partial`,
`duplicate`, `out-of-order`, `restart`, `outage`, `stale`, and `empty`.
`delayMs`, `aircraftCount` (up to 1,000), and `frozenNow` are independently
controllable. POST a complete fixture to `/__control/snapshot`; send
`{"clearCustomSnapshot":true}` to `/__control` to resume generated snapshots.
POST `/__control/reset` to restore defaults.
