import type { Airport } from "@flightmap/shared";

/**
 * Empty on purpose.
 *
 * Unlike `defaultMapWaypoints`, this is not shipped populated for the reference
 * deployment: an airport dataset is thousands of records that would sit in the
 * repository, go stale silently, and be wrong for every other receiver. It is
 * an operator-run build step instead — `npm run airports:build` reads an
 * OurAirports CSV export and writes the `mapAirports` setting. See
 * `docs/airports.md`.
 *
 * A deployment that never runs the CLI therefore has no airport data, which the
 * client shows as no layer at all rather than as an error.
 */
export const defaultMapAirports: readonly Airport[] = Object.freeze([]);
