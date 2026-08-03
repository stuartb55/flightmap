import { useEffect, useState } from 'react'
import type { AircraftSortKey } from './aircraft-filter'

/**
 * The live table shipped with four fixed columns, so fields the payload already
 * carried — vertical rate, squawk, track, operator — were only reachable by
 * selecting an aircraft one at a time. Columns are now chosen per browser.
 */
export type ColumnKey =
  | 'identity'
  | 'altitude'
  | 'speed'
  | 'distance'
  | 'verticalRate'
  | 'track'
  | 'squawk'
  | 'operator'
  | 'type'
  | 'age'

export interface ColumnDefinition {
  key: ColumnKey
  label: string
  sortKey: AircraftSortKey
  description: string
}

export const columnDefinitions: readonly ColumnDefinition[] = [
  { key: 'identity', label: 'Aircraft', sortKey: 'identity', description: 'Callsign, registration and alert state' },
  { key: 'altitude', label: 'Altitude', sortKey: 'altitude', description: 'Barometric altitude with climb or descent' },
  { key: 'speed', label: 'Speed', sortKey: 'speed', description: 'Ground speed' },
  { key: 'distance', label: 'Range', sortKey: 'distance', description: 'Distance from the receiver' },
  { key: 'verticalRate', label: 'V/S', sortKey: 'verticalRate', description: 'Vertical rate in feet per minute' },
  { key: 'track', label: 'Track', sortKey: 'track', description: 'Ground track in degrees' },
  { key: 'squawk', label: 'Squawk', sortKey: 'squawk', description: 'Transponder code' },
  { key: 'operator', label: 'Operator', sortKey: 'operator', description: 'Airline or owner' },
  { key: 'type', label: 'Type', sortKey: 'typeCode', description: 'ICAO type designator' },
  { key: 'age', label: 'Age', sortKey: 'freshness', description: 'Seconds since the last report' },
]

/** Identity carries selection and alert state, so it is never removable. */
export const requiredColumn: ColumnKey = 'identity'

export const defaultColumns: readonly ColumnKey[] = [
  'identity',
  'altitude',
  'speed',
  'distance',
]

/**
 * The mobile sheet is far too narrow for a chosen desktop layout, so it keeps
 * its own fixed set regardless of what the browser has stored.
 */
export const mobileColumns: readonly ColumnKey[] = ['identity', 'altitude', 'distance']

const STORAGE_KEY = 'flightmap.aircraft-columns.v1'
const knownKeys = new Set<string>(columnDefinitions.map((column) => column.key))

/** Order chosen columns the way the definitions are declared, identity first. */
export function normaliseColumns(values: readonly string[]): ColumnKey[] {
  const chosen = new Set(values.filter((value) => knownKeys.has(value)))
  chosen.add(requiredColumn)
  return columnDefinitions
    .map((column) => column.key)
    .filter((key) => chosen.has(key))
}

export function readColumns(storage: Pick<Storage, 'getItem'> = localStorage): ColumnKey[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')
    if (!Array.isArray(parsed)) return [...defaultColumns]
    const strings = parsed.filter((value): value is string => typeof value === 'string')
    // An array of nothing recognisable means corrupt storage, not a deliberate
    // "identity only" choice, so fall back rather than showing one column.
    return strings.some((value) => knownKeys.has(value))
      ? normaliseColumns(strings)
      : [...defaultColumns]
  } catch {
    return [...defaultColumns]
  }
}

export function useAircraftColumns() {
  const [columns, setColumns] = useState<ColumnKey[]>(readColumns)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(columns))
    } catch {
      // Column choice is a convenience and must never block live data.
    }
  }, [columns])
  return [columns, setColumns] as const
}
