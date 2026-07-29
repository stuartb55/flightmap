import { describe, expect, it } from 'vitest'
import { shouldShowSummarySection } from './HistoryPage'

describe('history summary pagination visibility', () => {
  it('keeps load-more reachable when a page contains only filtered recent summaries', () => {
    expect(shouldShowSummarySection(0, 'older-summary-cursor')).toBe(true)
  })

  it('hides an exhausted empty summary section', () => {
    expect(shouldShowSummarySection(0, null)).toBe(false)
  })
})
