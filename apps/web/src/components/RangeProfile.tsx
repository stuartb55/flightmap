import type { RangeProfileResponse } from '@flightmap/shared'
import { formatDistance } from '../lib/format'

function polarPoints(values: Array<number | null>, maximum: number, radius: number, centre: number) {
  return values.map((value, index) => {
    const angle = ((index * 5 + 2.5) - 90) * Math.PI / 180
    const distance = ((value ?? 0) / maximum) * radius
    return `${(centre + Math.cos(angle) * distance).toFixed(1)},${(centre + Math.sin(angle) * distance).toFixed(1)}`
  }).join(' ')
}

export function RangeProfile({ profile }: { profile: RangeProfileResponse }) {
  const values = profile.sectors.map((sector) => sector.p95RangeNm)
  const medians = profile.sectors.map((sector) => sector.medianRangeNm)
  const maximum = Math.max(10, ...profile.sectors.map((sector) => sector.maximumRangeNm ?? 0))
  const centre = 190
  const radius = 155
  return (
    <div className="range-profile-layout">
      <svg className="range-profile-chart" viewBox="0 0 380 380" role="img" aria-label={`Polar receiver range profile; maximum scale ${formatDistance(maximum)}`}>
        {[.25, .5, .75, 1].map((fraction) => <circle key={fraction} cx={centre} cy={centre} r={radius * fraction} className="range-ring" />)}
        {[0, 90, 180, 270].map((bearing) => {
          const angle = (bearing - 90) * Math.PI / 180
          return <g key={bearing}><line x1={centre} y1={centre} x2={centre + Math.cos(angle) * radius} y2={centre + Math.sin(angle) * radius} className="range-axis" /><text x={centre + Math.cos(angle) * (radius + 15)} y={centre + Math.sin(angle) * (radius + 15) + 4} textAnchor="middle">{bearing === 0 ? 'N' : bearing === 90 ? 'E' : bearing === 180 ? 'S' : 'W'}</text></g>
        })}
        <polygon points={polarPoints(values, maximum, radius, centre)} className="range-p95" />
        <polygon points={polarPoints(medians, maximum, radius, centre)} className="range-median" />
        <text x={centre} y={centre + 4} textAnchor="middle" className="range-scale-label">{Math.round(maximum)} nm</text>
      </svg>
      <div className="range-profile-summary">
        <p><i className="p95" /> 95th-percentile range</p><p><i className="median" /> Median range</p>
        <strong>Sector changes</strong>
        <ol>{profile.sectors.filter((sector) => sector.p95ChangeNm != null).sort((left, right) => Math.abs(right.p95ChangeNm!) - Math.abs(left.p95ChangeNm!)).slice(0, 8).map((sector) => <li key={sector.bearingStartDeg}><span>{sector.bearingStartDeg}–{sector.bearingEndDeg}°</span><strong className={sector.p95ChangeNm! >= 0 ? 'positive' : 'negative'}>{sector.p95ChangeNm! > 0 ? '+' : ''}{sector.p95ChangeNm!.toFixed(1)} nm</strong></li>)}</ol>
        {profile.availableFrom ? <small>Range profiles available from {profile.availableFrom}.</small> : <small>Range profile aggregation begins with new positioned reports.</small>}
      </div>
    </div>
  )
}
