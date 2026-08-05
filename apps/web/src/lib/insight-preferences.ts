import { useEffect, useState } from 'react'
import {
  defaultInsightSeries,
  insightSeriesPreferencesSchema,
  type InsightSeriesPreferences,
} from '@flightmap/shared'

const STORAGE_KEY = 'flightmap.insight-series.v1'

/**
 * Which series the activity chart draws, remembered between visits.
 *
 * Corrupt or absent storage falls back to every series shown: a hidden series
 * is a deliberate choice, and inventing one from a bad parse would silently
 * withhold data the page is there to show.
 */
export function readInsightSeries(
  storage: Pick<Storage, 'getItem'> = localStorage,
): InsightSeriesPreferences {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')
    const result = insightSeriesPreferencesSchema.safeParse(parsed)
    return result.success ? result.data : { ...defaultInsightSeries }
  } catch {
    return { ...defaultInsightSeries }
  }
}

export function useInsightSeries() {
  const [series, setSeries] = useState<InsightSeriesPreferences>(readInsightSeries)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(series))
    } catch {
      // A chart preference must never stand between the page and its data.
    }
  }, [series])
  return [series, setSeries] as const
}
