import type { MapWaypoint } from "@flightmap/shared";

/**
 * Shipped default for the reference deployment (a receiver near Manchester).
 * These are display-only reference points from the UK AIP Manchester SID/STAR
 * charts current in AIRAC 07/2026; they are not intended for navigation.
 *
 * Any deployment can replace them wholesale through the `mapWaypoints`
 * application setting, including with an empty list.
 */
export const defaultMapWaypoints: readonly MapWaypoint[] = Object.freeze([
  { name: "ROSUN", kind: "arrival", latitude: 53.6689139, longitude: -2.3492389 },
  { name: "MIRSI", kind: "arrival", latitude: 53.5379694, longitude: -2.7117111 },
  { name: "DAYNE", kind: "arrival", latitude: 53.2386444, longitude: -2.0292389 },
  { name: "ASMIM", kind: "departure", latitude: 53.4461111, longitude: -2.6530556 },
  { name: "KUXEM", kind: "departure", latitude: 53.2530556, longitude: -2.6797222 },
  { name: "EKLAD", kind: "departure", latitude: 53.2538889, longitude: -2.8247222 },
  { name: "LISTO", kind: "departure", latitude: 53.1433333, longitude: -2.1991667 },
  { name: "POL", kind: "departure", latitude: 53.7438889, longitude: -2.1033333 },
  { name: "SONEX", kind: "departure", latitude: 53.4980556, longitude: -2.1725 },
  { name: "DESIG", kind: "departure", latitude: 53.5272222, longitude: -1.8927778 },
  { name: "SANBA", kind: "departure", latitude: 53.1394444, longitude: -2.3341667 }
] satisfies MapWaypoint[]);
