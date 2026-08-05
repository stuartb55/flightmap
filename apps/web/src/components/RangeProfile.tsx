import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { RangeProfileResponse } from '@flightmap/shared'
import { formatDistance } from '../lib/format'
import { convertDistance, unitLabels, useUnitPreferences } from '../lib/unit-preferences'
import { ChartDataTable } from './ChartDataTable'

function polarPoints(values: Array<number | null>, maximum: number, radius: number, centre: number) {
  return values.map((value, index) => {
    const angle = ((index * 5 + 2.5) - 90) * Math.PI / 180
    const distance = ((value ?? 0) / maximum) * radius
    return `${(centre + Math.cos(angle) * distance).toFixed(1)},${(centre + Math.sin(angle) * distance).toFixed(1)}`
  }).join(' ')
}

/** The pie slice covering one five-degree sector, from the centre outwards. */
function wedgePath(bearingStartDeg: number, radius: number, centre: number) {
  const point = (bearing: number) => {
    const angle = (bearing - 90) * Math.PI / 180
    return `${(centre + Math.cos(angle) * radius).toFixed(1)},${(centre + Math.sin(angle) * radius).toFixed(1)}`
  }
  return `M ${centre},${centre} L ${point(bearingStartDeg)} A ${radius},${radius} 0 0 1 ${point(bearingStartDeg + 5)} Z`
}

export function RangeProfile({
  profile,
  onSelectSector,
  selectedSectorStartDeg = null,
}: {
  profile: RangeProfileResponse
  /** Drills into the bearing wedge; absent leaves the chart inert. */
  onSelectSector?: (bearingStartDeg: number) => void
  selectedSectorStartDeg?: number | null
}) {
  const units = useUnitPreferences()
  const values = profile.sectors.map((sector) => sector.p95RangeNm)
  const medians = profile.sectors.map((sector) => sector.medianRangeNm)
  const maximum = Math.max(10, ...profile.sectors.map((sector) => sector.maximumRangeNm ?? 0))
  const centre = 190
  const radius = 155
  /*
   * 72 wedges would be 72 tab stops. The chart takes one and the arrow keys
   * walk the compass from it, which is also the only sane way to reach a
   * five-degree target without a pointer.
   */
  const [cursor, setCursor] = useState(0)
  const chartRef = useRef<SVGSVGElement>(null)

  const moveCursor = (event: KeyboardEvent<SVGElement>, index: number) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelectSector?.(index * 5)
      return
    }
    let next: number
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % 72
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + 71) % 72
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = 71
    else return
    event.preventDefault()
    setCursor(next)
    chartRef.current?.querySelector<SVGElement>(`[data-sector="${next * 5}"]`)?.focus()
  }

  const sectorLabel = (sector: RangeProfileResponse['sectors'][number]) =>
    `${sector.bearingStartDeg}–${sector.bearingEndDeg}°: ` +
    `median ${formatDistance(sector.medianRangeNm)}, ` +
    `95th percentile ${formatDistance(sector.p95RangeNm)}, ` +
    `${sector.reports.toLocaleString('en-GB')} reports`

  return (
    <div className="range-profile-layout">
      <svg
        ref={chartRef}
        className="range-profile-chart"
        viewBox="0 0 380 380"
        role={onSelectSector ? 'group' : 'img'}
        aria-label={`Polar receiver range profile; maximum scale ${formatDistance(maximum)}`}
      >
        {[.25, .5, .75, 1].map((fraction) => <circle key={fraction} cx={centre} cy={centre} r={radius * fraction} className="range-ring" />)}
        {[0, 90, 180, 270].map((bearing) => {
          const angle = (bearing - 90) * Math.PI / 180
          return <g key={bearing}><line x1={centre} y1={centre} x2={centre + Math.cos(angle) * radius} y2={centre + Math.sin(angle) * radius} className="range-axis" /><text x={centre + Math.cos(angle) * (radius + 15)} y={centre + Math.sin(angle) * (radius + 15) + 4} textAnchor="middle">{bearing === 0 ? 'N' : bearing === 90 ? 'E' : bearing === 180 ? 'S' : 'W'}</text></g>
        })}
        <polygon points={polarPoints(values, maximum, radius, centre)} className="range-p95" />
        <polygon points={polarPoints(medians, maximum, radius, centre)} className="range-median" />
        {onSelectSector
          ? profile.sectors.map((sector, index) => (
              <path
                key={sector.bearingStartDeg}
                d={wedgePath(sector.bearingStartDeg, radius, centre)}
                className={`range-sector${selectedSectorStartDeg === sector.bearingStartDeg ? ' selected' : ''}`}
                data-sector={sector.bearingStartDeg}
                role="button"
                tabIndex={cursor === index ? 0 : -1}
                aria-pressed={selectedSectorStartDeg === sector.bearingStartDeg}
                aria-label={`${sectorLabel(sector)}. Show coverage on this bearing`}
                onFocus={() => setCursor(index)}
                onKeyDown={(event) => moveCursor(event, index)}
                onClick={() => onSelectSector(sector.bearingStartDeg)}
              />
            ))
          : null}
        <text x={centre} y={centre + 4} textAnchor="middle" className="range-scale-label">{formatDistance(maximum, units)}</text>
      </svg>
      <div className="range-profile-summary">
        <p><i className="p95" /> 95th-percentile range</p><p><i className="median" /> Median range</p>
        <strong>Sector changes</strong>
        <ol>{profile.sectors.filter((sector) => sector.p95ChangeNm != null).sort((left, right) => Math.abs(right.p95ChangeNm!) - Math.abs(left.p95ChangeNm!)).slice(0, 8).map((sector) => <li key={sector.bearingStartDeg}><span>{sector.bearingStartDeg}–{sector.bearingEndDeg}°</span><strong className={sector.p95ChangeNm! >= 0 ? 'positive' : 'negative'}>{sector.p95ChangeNm! > 0 ? '+' : ''}{convertDistance(sector.p95ChangeNm!, units.distance).toFixed(1)} {unitLabels.distance[units.distance]}</strong></li>)}</ol>
        {profile.availableFrom ? <small>Range profiles available from {profile.availableFrom}.</small> : <small>Range profile aggregation begins with new positioned reports.</small>}
        {onSelectSector ? (
          /*
           * The histogram behind these sectors is aggregated by day and cannot
           * name the sessions it counted, so a sector cannot open a matching
           * History search. It lands on the coverage in that direction, which
           * is a true statement about a different measurement — and the copy
           * has to say so, or the two look like they should tally.
           */
          <small>
            Selecting a sector filters the coverage heatmap below to that bearing. The heatmap counts
            positioned reports per cell; these sectors come from a daily range histogram, so the two
            are different measurements of the same sky.
          </small>
        ) : null}
      </div>
      <ChartDataTable
        summary="View range profile data table"
        caption="Receiver range by bearing sector"
        columns={['Bearing', 'Median range', '95th percentile', 'Maximum range', 'Change vs preceding']}
        rows={profile.sectors.map((sector) => ({
          key: String(sector.bearingStartDeg),
          header: onSelectSector ? (
            <button type="button" className="text-button" onClick={() => onSelectSector(sector.bearingStartDeg)}>
              {sector.bearingStartDeg}–{sector.bearingEndDeg}°
            </button>
          ) : (
            `${sector.bearingStartDeg}–${sector.bearingEndDeg}°`
          ),
          cells: [
            formatDistance(sector.medianRangeNm),
            formatDistance(sector.p95RangeNm),
            formatDistance(sector.maximumRangeNm),
            sector.p95ChangeNm == null
              ? '—'
              : `${sector.p95ChangeNm > 0 ? '+' : ''}${convertDistance(sector.p95ChangeNm, units.distance).toFixed(1)} ${unitLabels.distance[units.distance]}`,
          ],
        }))}
      />
    </div>
  )
}
