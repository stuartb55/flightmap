import type { ReactNode } from 'react'

/**
 * The keyboard-reachable equivalent of a chart. Every chart in the app carries
 * one: an SVG is a picture to a screen reader however carefully it is labelled,
 * and a summary sentence cannot answer "what was it at 14:00".
 *
 * Values arrive already formatted, so they route through the same helpers the
 * chart itself uses and honour unit preferences and the display time zone.
 * Unavailable values are the caller's `—`, never a zero standing in for one.
 */
export interface ChartDataRow {
  key: string
  /** The row's identity — a time, a bearing, a weekday-hour. */
  header: ReactNode
  cells: ReactNode[]
}

export function ChartDataTable({
  summary,
  caption,
  columns,
  rows,
  rowCap,
  open = false,
}: {
  /** The disclosure's label, e.g. "View activity data table". */
  summary: string
  /** Named for screen readers; visually hidden, as the panel heading is above. */
  caption: string
  columns: string[]
  rows: ChartDataRow[]
  /** Long series are capped, and a capped table says so rather than trailing off. */
  rowCap?: number
  open?: boolean
}) {
  const capped = rowCap != null && rows.length > rowCap
  const visible = capped ? rows.slice(0, rowCap) : rows
  return (
    <details className="chart-data-table" open={open}>
      <summary>{summary}</summary>
      {/*
        The container scrolls once a table is taller than its box, and a region
        that scrolls has to be reachable by keyboard or its lower rows are
        unreachable without a pointer. Naming it as well keeps the focus stop
        meaningful rather than an unlabelled group.
      */}
      <div className="table-scroll" tabIndex={0} role="region" aria-label={caption}>
        <table>
          <caption>
            {caption}
            {capped
              ? `. Showing the first ${rowCap!.toLocaleString('en-GB')} of ${rows.length.toLocaleString('en-GB')} rows`
              : ''}
          </caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th scope="col" key={column}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.header}</th>
                {row.cells.map((cell, index) => (
                  <td key={`${row.key}:${columns[index + 1] ?? index}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {capped ? (
        <small className="chart-data-table-cap">
          Showing the first {rowCap!.toLocaleString('en-GB')} of {rows.length.toLocaleString('en-GB')} rows.
        </small>
      ) : null}
    </details>
  )
}
