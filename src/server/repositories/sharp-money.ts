import type { Db } from '../db/client'
import { all, first, run } from '../db/client'
import { nowUnixSeconds } from '../env'

/**
 * Top holder data with PnL across multiple time periods
 */
export interface TopHolderPnlData {
  proxyWallet: string
  name?: string
  pseudonym?: string
  profileImage?: string
  amount: number
  pnlDay?: number | null
  pnlWeek?: number | null
  pnlMonth?: number | null
  pnlAll?: number | null
  pnlAllUnits?: number | null
  unitSize?: number | null
  stakeUnits?: number | null
  stakeUnitWeight?: number | null
  volume?: number
  momentumWeight: number
  pnlTierWeight: number
}

/**
 * Database row for sharp money cache
 */
export interface SharpMoneyCacheRow {
  id: string
  condition_id: string
  market_title: string
  market_slug?: string | null
  event_slug?: string | null
  sport_series_id?: number | null
  event_time?: string | null
  side_a_label: string
  side_a_total_value: number
  side_a_sharp_score: number
  side_a_holder_count: number
  side_a_price?: number | null
  side_a_top_holders?: string | null
  side_b_label: string
  side_b_total_value: number
  side_b_sharp_score: number
  side_b_holder_count: number
  side_b_price?: number | null
  side_b_top_holders?: string | null
  sharp_side?: string | null
  confidence?: string | null
  score_differential: number
  sharp_side_value_ratio?: number | null
  edge_rating?: number | null
  updated_at: number
}

/**
 * Parsed sharp money cache entry for frontend use
 */
export interface SharpMoneyCacheEntry {
  id: string
  conditionId: string
  marketTitle: string
  marketSlug?: string
  eventSlug?: string
  sportSeriesId?: number
  eventTime?: string
  sideA: {
    label: string
    totalValue: number
    sharpScore: number
    holderCount: number
    price?: number | null
    topHolders: TopHolderPnlData[]
  }
  sideB: {
    label: string
    totalValue: number
    sharpScore: number
    holderCount: number
    price?: number | null
    topHolders: TopHolderPnlData[]
  }
  sharpSide: 'A' | 'B' | 'EVEN'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  scoreDifferential: number
  sharpSideValueRatio?: number
  edgeRating: number
  updatedAt: number
}

/**
 * Input for upserting a sharp money cache entry
 */
export interface UpsertSharpMoneyCacheInput {
  conditionId: string
  marketTitle: string
  marketSlug?: string
  eventSlug?: string
  sportSeriesId?: number
  eventTime?: string
  sideA: {
    label: string
    totalValue: number
    sharpScore: number
    holderCount: number
    price?: number | null
    topHolders: TopHolderPnlData[]
  }
  sideB: {
    label: string
    totalValue: number
    sharpScore: number
    holderCount: number
    price?: number | null
    topHolders: TopHolderPnlData[]
  }
  sharpSide: 'A' | 'B' | 'EVEN'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  scoreDifferential: number
  sharpSideValueRatio?: number
  edgeRating: number
}

function generateId(): string {
  return `sharp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function parseRow(row: SharpMoneyCacheRow): SharpMoneyCacheEntry {
  return {
    id: row.id,
    conditionId: row.condition_id,
    marketTitle: row.market_title,
    marketSlug: row.market_slug ?? undefined,
    eventSlug: row.event_slug ?? undefined,
    sportSeriesId: row.sport_series_id ?? undefined,
    eventTime: row.event_time ?? undefined,
    sideA: {
      label: row.side_a_label,
      totalValue: row.side_a_total_value,
      sharpScore: row.side_a_sharp_score,
      holderCount: row.side_a_holder_count,
      price: row.side_a_price ?? null,
      topHolders: row.side_a_top_holders
        ? (JSON.parse(row.side_a_top_holders) as TopHolderPnlData[])
        : [],
    },
    sideB: {
      label: row.side_b_label,
      totalValue: row.side_b_total_value,
      sharpScore: row.side_b_sharp_score,
      holderCount: row.side_b_holder_count,
      price: row.side_b_price ?? null,
      topHolders: row.side_b_top_holders
        ? (JSON.parse(row.side_b_top_holders) as TopHolderPnlData[])
        : [],
    },
    sharpSide: (row.sharp_side as 'A' | 'B' | 'EVEN') ?? 'EVEN',
    confidence: (row.confidence as 'HIGH' | 'MEDIUM' | 'LOW') ?? 'LOW',
    scoreDifferential: row.score_differential,
    sharpSideValueRatio: row.sharp_side_value_ratio ?? undefined,
    edgeRating: row.edge_rating ?? 0,
    updatedAt: row.updated_at,
  }
}

/**
 * Upsert a sharp money cache entry
 */
export async function upsertSharpMoneyCache(
  db: Db,
  input: UpsertSharpMoneyCacheInput,
): Promise<void> {
  const now = nowUnixSeconds()

  // Check if entry exists
  const existing = await first<SharpMoneyCacheRow>(
    db,
    `SELECT id FROM sharp_money_cache WHERE condition_id = ?`,
    input.conditionId,
  )

  const id = existing?.id ?? generateId()

  await run(
    db,
    `INSERT INTO sharp_money_cache (
      id, condition_id, market_title, market_slug, event_slug, sport_series_id, event_time,
      side_a_label, side_a_total_value, side_a_sharp_score, side_a_holder_count, side_a_price, side_a_top_holders,
      side_b_label, side_b_total_value, side_b_sharp_score, side_b_holder_count, side_b_price, side_b_top_holders,
      sharp_side, confidence, score_differential, sharp_side_value_ratio, edge_rating, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(condition_id) DO UPDATE SET
      market_title = excluded.market_title,
      market_slug = excluded.market_slug,
      event_slug = excluded.event_slug,
      sport_series_id = excluded.sport_series_id,
      event_time = excluded.event_time,
      side_a_label = excluded.side_a_label,
      side_a_total_value = excluded.side_a_total_value,
      side_a_sharp_score = excluded.side_a_sharp_score,
      side_a_holder_count = excluded.side_a_holder_count,
      side_a_price = excluded.side_a_price,
      side_a_top_holders = excluded.side_a_top_holders,
      side_b_label = excluded.side_b_label,
      side_b_total_value = excluded.side_b_total_value,
      side_b_sharp_score = excluded.side_b_sharp_score,
      side_b_holder_count = excluded.side_b_holder_count,
      side_b_price = excluded.side_b_price,
      side_b_top_holders = excluded.side_b_top_holders,
      sharp_side = excluded.sharp_side,
      confidence = excluded.confidence,
      score_differential = excluded.score_differential,
      sharp_side_value_ratio = excluded.sharp_side_value_ratio,
      edge_rating = excluded.edge_rating,
      updated_at = excluded.updated_at`,
    id,
    input.conditionId,
    input.marketTitle,
    input.marketSlug ?? null,
    input.eventSlug ?? null,
    input.sportSeriesId ?? null,
    input.eventTime ?? null,
    input.sideA.label,
    input.sideA.totalValue,
    input.sideA.sharpScore,
    input.sideA.holderCount,
    input.sideA.price ?? null,
    JSON.stringify(input.sideA.topHolders),
    input.sideB.label,
    input.sideB.totalValue,
    input.sideB.sharpScore,
    input.sideB.holderCount,
    input.sideB.price ?? null,
    JSON.stringify(input.sideB.topHolders),
    input.sharpSide,
    input.confidence,
    input.scoreDifferential,
    input.sharpSideValueRatio ?? null,
    input.edgeRating,
    now,
  )
}

/**
 * Get a single sharp money cache entry by condition ID
 */
export async function getSharpMoneyCacheByConditionId(
  db: Db,
  conditionId: string,
): Promise<SharpMoneyCacheEntry | null> {
  const row = await first<SharpMoneyCacheRow>(
    db,
    `SELECT * FROM sharp_money_cache WHERE condition_id = ?`,
    conditionId,
  )

  return row ? parseRow(row) : null
}

/**
 * Get all sharp money cache entries, optionally filtered by sport
 */
export async function listSharpMoneyCache(
  db: Db,
  options?: {
    sportSeriesId?: number
    limit?: number
  },
): Promise<SharpMoneyCacheEntry[]> {
  const { sportSeriesId, limit = 50 } = options ?? {}

  let query = `SELECT * FROM sharp_money_cache`
  const params: unknown[] = []

  if (sportSeriesId !== undefined) {
    query += ` WHERE sport_series_id = ?`
    params.push(sportSeriesId)
  }

  // Order by: Edge Rating (highest first), then score differential (highest first), 
  // then confidence (HIGH > MEDIUM > LOW), then conviction (balanced is better), then event time (soonest first)
  query += ` ORDER BY 
    edge_rating DESC NULLS LAST,
    score_differential DESC NULLS LAST,
    CASE confidence
      WHEN 'HIGH' THEN 3
      WHEN 'MEDIUM' THEN 2
      WHEN 'LOW' THEN 1
      ELSE 0
    END DESC,
    ABS(sharp_side_value_ratio - 0.5) ASC NULLS LAST,
    event_time ASC NULLS LAST
    LIMIT ?`
  params.push(limit)

  const rows = await all<SharpMoneyCacheRow>(db, query, ...params)
  return rows.map(parseRow)
}

/**
 * Get all unique sport tags from the cache
 */
/**
 * Delete old cache entries (older than specified hours)
 */
export async function pruneSharpMoneyCache(
  db: Db,
  olderThanHours: number = 24,
): Promise<number> {
  const cutoff = nowUnixSeconds() - olderThanHours * 60 * 60
  const result = await run(
    db,
    `DELETE FROM sharp_money_cache WHERE updated_at < ?`,
    cutoff,
  )
  return result.meta?.changes as number ?? 0
}

/**
 * Delete a specific cache entry
 */
export async function deleteSharpMoneyCache(
  db: Db,
  conditionId: string,
): Promise<void> {
  await run(
    db,
    `DELETE FROM sharp_money_cache WHERE condition_id = ?`,
    conditionId,
  )
}

/**
 * Clear all sharp money cache entries
 */
export async function clearAllSharpMoneyCache(db: Db): Promise<void> {
  await run(db, `DELETE FROM sharp_money_cache`)
}

/**
 * Get cache stats
 */
export async function getSharpMoneyCacheStats(db: Db): Promise<{
  totalEntries: number
  bySport: Record<string, number>
  byConfidence: Record<string, number>
  oldestEntry?: number
  newestEntry?: number
}> {
  const [countResult, sportCounts, confidenceCounts, timestamps] =
    await Promise.all([
      first<{ count: number }>(
        db,
        `SELECT COUNT(*) as count FROM sharp_money_cache`,
      ),
      all<{ sport_series_id: number | null; count: number }>(
        db,
        `SELECT sport_series_id, COUNT(*) as count FROM sharp_money_cache GROUP BY sport_series_id`,
      ),
      all<{ confidence: string; count: number }>(
        db,
        `SELECT confidence, COUNT(*) as count FROM sharp_money_cache GROUP BY confidence`,
      ),
      first<{ oldest: number; newest: number }>(
        db,
        `SELECT MIN(updated_at) as oldest, MAX(updated_at) as newest FROM sharp_money_cache`,
      ),
    ])

  const bySport: Record<string, number> = {}
  for (const row of sportCounts) {
    const key = row.sport_series_id === null ? 'unknown' : String(row.sport_series_id)
    bySport[key] = row.count
  }

  const byConfidence: Record<string, number> = {}
  for (const row of confidenceCounts) {
    byConfidence[row.confidence ?? 'unknown'] = row.count
  }

  return {
    totalEntries: countResult?.count ?? 0,
    bySport,
    byConfidence,
    oldestEntry: timestamps?.oldest,
    newestEntry: timestamps?.newest,
  }
}
