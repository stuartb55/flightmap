import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const snapshot = vi.hoisted(() => ({
  chartSnapshot: vi.fn(),
  downloadBlob: vi.fn(),
  snapshotFilename: vi.fn(() => 'flightmap-insights-activity-2026-08-05.png'),
}))

vi.mock('../lib/map-snapshot', () => snapshot)

import { ChartImageButton } from './ChartImageButton'

function renderButton(chartRef = createRef<SVGSVGElement>()) {
  return render(
    <ChartImageButton
      chartRef={chartRef}
      surface="insights-activity"
      label="Save the activity chart as an image"
      caption={() => ({ title: 'Home receiver · Activity', detail: 'range', attribution: 'units' })}
    />,
  )
}

afterEach(cleanup)

/*
 * The file lands outside the page, so nothing else in the interface reports
 * that the export worked — the button has to say so itself, out loud.
 */
describe('chart image export', () => {
  beforeEach(() => vi.clearAllMocks())

  it('saves a captioned PNG and announces it', async () => {
    const blob = new Blob(['png'], { type: 'image/png' })
    snapshot.chartSnapshot.mockResolvedValue(blob)
    // React fills the ref in the app; here it is filled by hand.
    const chartRef = createRef<SVGSVGElement>()
    chartRef.current = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    renderButton(chartRef)

    fireEvent.click(screen.getByRole('button', { name: 'Save the activity chart as an image' }))

    await waitFor(() => expect(snapshot.downloadBlob).toHaveBeenCalledWith(blob, expect.any(String)))
    expect(snapshot.chartSnapshot).toHaveBeenCalledWith(
      chartRef.current,
      expect.objectContaining({ title: 'Home receiver · Activity' }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent('Image saved.')
  })

  it('reports a capture that produced nothing rather than saving an empty file', async () => {
    snapshot.chartSnapshot.mockResolvedValue(null)
    const chartRef = createRef<SVGSVGElement>()
    chartRef.current = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    renderButton(chartRef)

    fireEvent.click(screen.getByRole('button', { name: /Save the activity chart/ }))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('could not be captured'),
    )
    expect(snapshot.downloadBlob).not.toHaveBeenCalled()
  })

  it('says the chart is not ready rather than failing silently', async () => {
    renderButton()
    fireEvent.click(screen.getByRole('button', { name: /Save the activity chart/ }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('not ready'))
    expect(snapshot.chartSnapshot).not.toHaveBeenCalled()
  })
})
