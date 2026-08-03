/**
 * ADS-B emitter categories describe what kind of vehicle is transmitting. They
 * already arrive on every live record but were previously only an opaque filter
 * value, so the map drew the same airliner glyph for a Cessna, an A380, and an
 * airport tug. Mapping categories onto a small set of shapes makes the traffic
 * picture readable without opening the detail panel.
 */

export type AircraftShape =
  | 'light'
  | 'standard'
  | 'heavy'
  | 'highPerformance'
  | 'rotorcraft'
  | 'glider'
  | 'drone'
  | 'ground'

/** Every shape an icon is generated for, in legend order. */
export const aircraftShapes = [
  'light',
  'standard',
  'heavy',
  'highPerformance',
  'rotorcraft',
  'glider',
  'drone',
  'ground',
] as const satisfies readonly AircraftShape[]

const categoryShapes: Readonly<Record<string, AircraftShape>> = {
  A1: 'light',
  A2: 'standard',
  A3: 'standard',
  A4: 'heavy',
  A5: 'heavy',
  A6: 'highPerformance',
  A7: 'rotorcraft',
  B1: 'glider',
  B2: 'glider',
  B3: 'glider',
  B4: 'glider',
  B6: 'drone',
  B7: 'drone',
  C1: 'ground',
  C2: 'ground',
  C3: 'ground',
  C4: 'ground',
  C5: 'ground',
}

const categoryLabels: Readonly<Record<string, string>> = {
  A0: 'Unspecified',
  A1: 'Light',
  A2: 'Small',
  A3: 'Large',
  A4: 'High-vortex large',
  A5: 'Heavy',
  A6: 'High performance',
  A7: 'Rotorcraft',
  B0: 'Unspecified',
  B1: 'Glider or sailplane',
  B2: 'Lighter-than-air',
  B3: 'Parachutist',
  B4: 'Ultralight',
  B5: 'Reserved',
  B6: 'Unmanned',
  B7: 'Space vehicle',
  C0: 'Unspecified surface',
  C1: 'Emergency vehicle',
  C2: 'Service vehicle',
  C3: 'Point obstacle',
  C4: 'Cluster obstacle',
  C5: 'Line obstacle',
}

/**
 * Body outline for each shape in a 34x34 box, nose pointing north so the map's
 * icon-rotate aligns the glyph with the ground track. Shared by the map (which
 * paints it to a canvas and adds decoration) and the legend (which renders it
 * as an SVG polygon), so the two can never drift apart.
 */
export const shapeOutlines: Readonly<Record<AircraftShape, readonly (readonly [number, number])[]>> = {
  standard: [
    [17, 1], [19, 12], [31, 18], [31, 21], [19.5, 18.5], [20.5, 27], [25, 31],
    [24.5, 33], [17, 30], [9.5, 33], [9, 31], [13.5, 27], [14.5, 18.5],
    [3, 21], [3, 18], [15, 12],
  ],
  light: [
    [17, 4], [18.4, 13], [28, 16.5], [28, 19], [18.4, 17.6], [18.4, 26],
    [21.8, 29.5], [21.4, 31], [17, 29], [12.6, 31], [12.2, 29.5], [15.6, 26],
    [15.6, 17.6], [6, 19], [6, 16.5], [15.6, 13],
  ],
  heavy: [
    [17, 0.5], [19.6, 11], [33, 19], [33, 22.5], [20, 19.6], [21, 28],
    [26, 32.5], [25.5, 34], [17, 30.5], [8.5, 34], [8, 32.5], [13, 28],
    [14, 19.6], [1, 22.5], [1, 19], [14.4, 11],
  ],
  highPerformance: [
    [17, 1], [19, 14], [27, 28], [27, 30], [19.4, 26], [20, 31], [23, 33.5],
    [17, 32], [11, 33.5], [14, 31], [14.6, 26], [7, 30], [7, 28], [15, 14],
  ],
  rotorcraft: [
    [17, 8], [20.2, 12], [20.6, 18], [18.4, 18], [17.9, 29], [20.6, 29],
    [20.6, 31], [13.4, 31], [13.4, 29], [16.1, 29], [16.1, 18], [13.4, 18],
    [13.8, 12],
  ],
  glider: [
    [17, 3], [17.9, 14], [32, 16.6], [32, 18.2], [17.9, 17.6], [17.9, 28],
    [20.4, 31], [17, 30], [13.6, 31], [16.1, 28], [16.1, 17.6], [2, 18.2],
    [2, 16.6], [16.1, 14],
  ],
  drone: [[17, 3], [30, 29], [17, 22], [4, 29]],
  ground: [
    [10, 9], [24, 9], [25, 10], [25, 24], [24, 25], [10, 25], [9, 24], [9, 10],
  ],
}

/** The same outline as an SVG `points` attribute. */
export function shapePoints(shape: AircraftShape): string {
  return shapeOutlines[shape].map(([x, y]) => `${x},${y}`).join(' ')
}

export const shapeLabels: Readonly<Record<AircraftShape, string>> = {
  light: 'Light',
  standard: 'Airliner',
  heavy: 'Heavy',
  highPerformance: 'High performance',
  rotorcraft: 'Rotorcraft',
  glider: 'Glider',
  drone: 'Unmanned',
  ground: 'Surface',
}

/**
 * Receivers that never send an emitter category still identify most airframes
 * through the local metadata database, so a short list of unambiguous ICAO type
 * designators recovers the two shapes worth recovering. This is deliberately a
 * fallback: a matching category always wins.
 */
const heavyTypes = new Set([
  'A124', 'A225', 'A332', 'A333', 'A338', 'A339', 'A342', 'A343', 'A345', 'A346',
  'A359', 'A35K', 'A388', 'B741', 'B742', 'B743', 'B744', 'B748', 'B74D', 'B74R',
  'B752', 'B753', 'B762', 'B763', 'B764', 'B772', 'B773', 'B77L', 'B77W', 'B778',
  'B779', 'B788', 'B789', 'B78X', 'C5M', 'C17', 'IL76', 'IL96', 'MD11', 'A400',
])

const rotorcraftTypes = new Set([
  'A109', 'A119', 'A139', 'A149', 'A169', 'A189', 'B06', 'B06T', 'B222', 'B230',
  'B407', 'B412', 'B429', 'B430', 'B505', 'EC20', 'EC25', 'EC30', 'EC35', 'EC45',
  'EC55', 'EC75', 'EH10', 'H125', 'H135', 'H145', 'H160', 'H175', 'H500', 'R22',
  'R44', 'R66', 'S61', 'S64', 'S76', 'S92', 'AS32', 'AS50', 'AS55', 'AS65',
  'UH60', 'CH47', 'MI8', 'MI17', 'GAZL', 'LYNX', 'PUMA', 'MERL',
])

export function normaliseCategory(value: string | null | undefined): string | null {
  const category = value?.trim().toUpperCase()
  return category ? category : null
}

/** Human-readable name for an emitter category, or null when it is unknown. */
export function categoryLabel(value: string | null | undefined): string | null {
  const category = normaliseCategory(value)
  return category ? categoryLabels[category] ?? null : null
}

/** Label for a category filter option: `A3 · Large`, or the raw code if unmapped. */
export function categoryOptionLabel(value: string): string {
  const label = categoryLabel(value)
  const category = normaliseCategory(value) ?? value
  return label ? `${category} · ${label}` : category
}

/**
 * The glyph an aircraft should be drawn with. Category is authoritative; the
 * type designator only fills the gap when no category was transmitted.
 */
export function aircraftShape(aircraft: {
  category?: string | null
  typeCode?: string | null
}): AircraftShape {
  const category = normaliseCategory(aircraft.category)
  const mapped = category ? categoryShapes[category] : undefined
  if (mapped) return mapped

  const typeCode = aircraft.typeCode?.trim().toUpperCase()
  if (typeCode) {
    if (heavyTypes.has(typeCode)) return 'heavy'
    if (rotorcraftTypes.has(typeCode)) return 'rotorcraft'
  }
  return 'standard'
}
