import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { ImageDown } from 'lucide-react'
import { chartSnapshot, downloadBlob, snapshotFilename } from '../lib/map-snapshot'
import type { SnapshotCaption } from '../lib/map-snapshot'

/**
 * Saves a chart as a captioned PNG, on the same compositor the map snapshot
 * uses. A picture of a chart with no caption is unreadable a week later — it
 * says nothing about which receiver, which range, or which units — so the
 * caption is not optional and the caller has to supply one.
 */
export function ChartImageButton({
  chartRef,
  surface,
  caption,
  label = 'Save chart image',
}: {
  chartRef: RefObject<SVGSVGElement | null>
  /** Names the file, e.g. "insights-activity". */
  surface: string
  caption: () => SnapshotCaption
  label?: string
}) {
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 6_000)
    return () => window.clearTimeout(timer)
  }, [status])

  const save = async () => {
    const svg = chartRef.current
    if (!svg) {
      setStatus('The chart is not ready yet.')
      return
    }
    setStatus('Preparing image…')
    try {
      const blob = await chartSnapshot(svg, caption())
      if (!blob) {
        setStatus('The chart image could not be captured.')
        return
      }
      downloadBlob(blob, snapshotFilename(surface))
      setStatus('Image saved.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The chart image could not be saved.')
    }
  }

  return (
    <span className="chart-image-action">
      <button
        type="button"
        className="secondary-button small"
        aria-label={label}
        onClick={() => void save()}
      >
        <ImageDown size={14} /> PNG
      </button>
      {/* The outcome is announced rather than only shown: the file lands
          outside the page, so nothing else reports that it worked. */}
      <span role="status" aria-live="polite">{status}</span>
    </span>
  )
}
