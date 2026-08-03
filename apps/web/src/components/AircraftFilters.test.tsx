import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAircraftFilters, type AircraftFilters as AircraftFilterState } from '../lib/aircraft-filter'
import { aviationUnits, metricUnits, setUnitPreferences } from '../lib/unit-preferences'
import { AircraftFilters } from './AircraftFilters'

/** The drawer is controlled by LivePage, so the test owns the state too. */
function Harness({
  initial,
  onChange,
}: {
  initial: Partial<AircraftFilterState>
  onChange: (filters: AircraftFilterState) => void
}) {
  const [filters, setFilters] = useState<AircraftFilterState>({
    ...defaultAircraftFilters,
    ...initial,
  })
  return (
    <AircraftFilters
      filters={filters}
      sources={['adsb']}
      categories={['A3']}
      onChange={(next) => {
        setFilters(next)
        onChange(next)
      }}
    />
  )
}

function renderFilters(initial: Partial<AircraftFilterState> = {}) {
  const onChange = vi.fn()
  render(<Harness initial={initial} onChange={onChange} />)
  return onChange
}

afterEach(() => {
  setUnitPreferences(aviationUnits)
})

describe('AircraftFilters units', () => {
  it('shows filter bounds converted into the chosen units', () => {
    setUnitPreferences(metricUnits)
    renderFilters({ maximumDistance: '40', minimumAltitude: '10000' })

    expect(screen.getByLabelText(/Maximum range/)).toHaveValue(74.08)
    expect(screen.getByLabelText(/Minimum altitude/)).toHaveValue(3_048)
    expect(screen.getByLabelText(/Maximum range/).nextSibling).toHaveTextContent('km')
    expect(screen.getByLabelText(/Minimum altitude/).nextSibling).toHaveTextContent('m')
  })

  it('converts a typed value back to canonical units rather than reinterpreting it', async () => {
    setUnitPreferences(metricUnits)
    const onChange = renderFilters()

    await userEvent.type(screen.getByLabelText(/Minimum speed/), '400')

    // 400 km/h is 216 kt: the stored filter stays in knots so it still matches
    // receiver data, saved views, and shared URLs.
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ minimumSpeed: '215.983' }),
    )
    // What was typed survives the round trip rather than being reformatted.
    expect(screen.getByLabelText(/Minimum speed/)).toHaveValue(400)
  })

  it('leaves aviation units untouched', async () => {
    const onChange = renderFilters({ maximumAltitude: '40000' })
    expect(screen.getByLabelText(/Maximum altitude/)).toHaveValue(40_000)

    await userEvent.type(screen.getByLabelText(/Minimum speed/), '250')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ minimumSpeed: '250' }))
  })
})
