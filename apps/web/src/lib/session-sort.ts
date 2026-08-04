import { sessionSortSchema, type SessionSort } from '@flightmap/shared'

/**
 * The orderings the session list offers, in the order the control lists them.
 *
 * Each carries the direction that makes it useful — nobody looks for the
 * furthest approach first — so the control stays a single list rather than a
 * field and a direction to combine.
 */
export const sessionSortOptions: readonly { value: SessionSort; label: string }[] = [
  { value: 'started_desc', label: 'Newest first' },
  { value: 'started_asc', label: 'Oldest first' },
  { value: 'duration_desc', label: 'Longest' },
  { value: 'closest_asc', label: 'Closest approach' },
  { value: 'altitude_desc', label: 'Highest' },
  { value: 'samples_desc', label: 'Most samples' },
]

export const defaultSessionSort: SessionSort = 'started_desc'

/**
 * The ordering a URL or saved view asks for. Anything unrecognised — a
 * hand-edited link, a view saved by a later version — falls back to the
 * default rather than failing the search it came with.
 */
export function parseSessionSort(value: string | null | undefined): SessionSort {
  const parsed = sessionSortSchema.safeParse(value)
  return parsed.success ? parsed.data : defaultSessionSort
}
