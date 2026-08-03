import { describe, expect, it } from 'vitest'
import {
  columnDefinitions,
  defaultColumns,
  mobileColumns,
  normaliseColumns,
  readColumns,
  requiredColumn,
} from './table-columns'

const storage = (value: string | null) => ({ getItem: () => value })

describe('normaliseColumns', () => {
  it('always keeps the identity column', () => {
    expect(normaliseColumns([])).toContain(requiredColumn)
    expect(normaliseColumns(['speed'])).toEqual(['identity', 'speed'])
  })

  it('drops keys that are not columns', () => {
    expect(normaliseColumns(['altitude', 'nonsense'])).toEqual(['identity', 'altitude'])
  })

  it('returns a canonical order regardless of input order, without duplicates', () => {
    expect(normaliseColumns(['age', 'altitude', 'identity', 'altitude'])).toEqual([
      'identity',
      'altitude',
      'age',
    ])
  })
})

describe('readColumns', () => {
  it('uses the previous four-column layout by default', () => {
    expect(readColumns(storage(null))).toEqual([...defaultColumns])
  })

  it('restores a stored choice', () => {
    expect(readColumns(storage(JSON.stringify(['identity', 'squawk', 'altitude'])))).toEqual([
      'identity',
      'altitude',
      'squawk',
    ])
  })

  it('falls back rather than blocking the list on unusable storage', () => {
    expect(readColumns(storage('not json'))).toEqual([...defaultColumns])
    expect(readColumns(storage('{"columns":["speed"]}'))).toEqual([...defaultColumns])
    // An array with nothing recognisable is corruption, not an identity-only choice.
    expect(readColumns(storage(JSON.stringify(['gone', 'also-gone'])))).toEqual([
      ...defaultColumns,
    ])
  })

  it('treats a deliberate identity-only choice as valid', () => {
    expect(readColumns(storage(JSON.stringify(['identity'])))).toEqual(['identity'])
  })
})

describe('column definitions', () => {
  it('gives every column a distinct key and a sort key', () => {
    const keys = columnDefinitions.map((column) => column.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const column of columnDefinitions) {
      expect(column.sortKey).toBeTruthy()
      expect(column.label).toBeTruthy()
    }
  })

  it('keeps the mobile set narrow and valid', () => {
    expect(mobileColumns).toContain(requiredColumn)
    expect(mobileColumns.length).toBeLessThanOrEqual(3)
    expect(normaliseColumns([...mobileColumns])).toEqual([...mobileColumns])
  })
})
