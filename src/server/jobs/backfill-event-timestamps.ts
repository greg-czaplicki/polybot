import { all, run } from '../db/client'
import type { Env } from '../env'

interface MissingEventRow {
  event_slug: string
}

const GAMMA_EVENTS_ENDPOINT = 'https://gamma-api.polymarket.com/events'

async function fetchEventTimestamp(slug: string): Promise<number | null> {
  const url = new URL(GAMMA_EVENTS_ENDPOINT)
  url.searchParams.set('slug', slug)
  const response = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } })
  if (!response.ok) {
    console.warn('[backfill] Unable to load gamma event', slug, response.status)
    return null
  }
  const payload = (await response.json()) as Array<{ endDate?: string | null }>
  if (!Array.isArray(payload) || payload.length === 0) {
    return null
  }
  const [event] = payload
  if (!event?.endDate) {
    return null
  }
  const parsed = new Date(event.endDate)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return Math.floor(parsed.getTime() / 1000)
}

export async function backfillEventTimestamps(env: Env, options?: { batchSize?: number }) {
  const db = env.POLYWHALER_DB
  const batchSize = options?.batchSize ?? 25
  const rows = await all<MissingEventRow>(
    db,
    `SELECT DISTINCT event_slug FROM wallet_results WHERE event_slug IS NOT NULL AND event_end_timestamp IS NULL`,
  )
  if (rows.length === 0) {
    console.log('[backfill] No wallet_results rows require updates.')
    return
  }

  let updated = 0
  for (let index = 0; index < rows.length; index += batchSize) {
    const slice = rows.slice(index, index + batchSize)
    const results = await Promise.all(
      slice.map(async (row) => ({
        slug: row.event_slug,
        timestamp: await fetchEventTimestamp(row.event_slug),
      })),
    )

    for (const result of results) {
      if (!result.timestamp) {
        continue
      }
      await run(
        db,
        `UPDATE wallet_results
         SET event_end_timestamp = ?, resolved_at = ?
         WHERE event_slug = ? AND event_end_timestamp IS NULL`,
        result.timestamp,
        result.timestamp,
        result.slug,
      )
      updated += 1
    }
  }

  console.log('[backfill] Completed event timestamp updates', {
    slugsProcessed: rows.length,
    slugsUpdated: updated,
  })
}
