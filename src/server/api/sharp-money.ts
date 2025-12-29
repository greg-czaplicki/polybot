import { createServerFn } from '@tanstack/react-start'
import { getDb } from '../env'
import { all, run } from '../db/client'
import { isSportsMarket, detectSportTag } from '@/lib/sports'
import {
  listSharpMoneyCache,
  getSharpMoneyCacheByConditionId,
  upsertSharpMoneyCache,
  getSharpMoneyCacheStats,
  clearAllSharpMoneyCache,
  type SharpMoneyCacheEntry,
  type TopHolderPnlData,
  type UpsertSharpMoneyCacheInput,
} from '../repositories/sharp-money'

// Re-export types for frontend use
export type { SharpMoneyCacheEntry, TopHolderPnlData } from '../repositories/sharp-money'

const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com'
const POLYMARKET_CLOB_API = 'https://clob.polymarket.com'
const POLYMARKET_DATA_API = 'https://data-api.polymarket.com'

// Sport tags we want to track for sharp money
// Note: 'soccer' is what detectSportTag returns for EPL games
// Note: 'cfb' is college football (Polymarket uses this, not 'ncaaf')
const TARGET_SPORT_TAGS = ['nfl', 'nba', 'cfb', 'ncaaf', 'ncaab', 'mlb', 'nhl', 'epl', 'soccer']

// Gamma API tag IDs for sports (from /sports endpoint)
const SPORT_TAG_IDS: Record<string, number> = {
  nfl: 450,
  nba: 745,
  cfb: 100351,    // College Football
  ncaaf: 100351,  // Alias for college football
  ncaab: 100149,  // College Basketball
  mlb: 100381,
  nhl: 899,
  // Soccer leagues
  epl: 82,        // Premier League
  laliga: 780,    // La Liga
  bundesliga: 1494, // Bundesliga
}

// Get unique sport tag IDs for filtering (dedupe since cfb/ncaaf share same ID)
const ALL_SPORT_TAG_IDS = [...new Set(Object.values(SPORT_TAG_IDS))]

// Minimum volume to show in sharp money (filters out low-liquidity games)
const MIN_VOLUME_USD = 50000

/**
 * Parse outcomes from Gamma API - can be JSON array string or comma-separated
 */
function parseOutcomes(outcomes: string | undefined | null): string[] {
  if (!outcomes) return ['Yes', 'No']
  
  // Try parsing as JSON array first (e.g., '["Patriots", "Jets"]')
  if (outcomes.startsWith('[')) {
    try {
      const parsed = JSON.parse(outcomes)
      if (Array.isArray(parsed)) {
        return parsed.map(o => String(o).trim())
      }
    } catch {
      // Fall through to comma split
    }
  }
  
  // Fall back to comma-separated (e.g., 'Yes, No')
  return outcomes.split(',').map(o => o.trim())
}

/**
 * Market data from Gamma API
 */
export interface GammaMarket {
  id: string
  question: string
  conditionId: string
  slug: string
  resolutionSource?: string
  endDate?: string
  liquidity?: number
  volume?: number
  volumeNum?: number
  liquidityNum?: number
  outcomes?: string
  outcomePrices?: string
  active?: boolean
  closed?: boolean
  marketMakerAddress?: string
  createdAt?: string
  updatedAt?: string
  // Event data
  groupItemTitle?: string
  eventSlug?: string
  enableOrderBook?: boolean
}

/**
 * Holder with multi-period PnL data
 */
export interface HolderWithPnl {
  proxyWallet: string
  name?: string
  pseudonym?: string
  profileImage?: string
  amount: number
  outcomeIndex: number
  pnlDay?: number | null
  pnlWeek?: number | null
  pnlMonth?: number | null
  pnlAll?: number | null
  volume?: number
}

/**
 * Multi-period PnL result
 */
export interface MultiPeriodPnl {
  day: number | null
  week: number | null
  month: number | null
  all: number | null
  volume?: number
}

/**
 * Sharp analysis result for a single market
 */
export interface SharpAnalysisResult {
  conditionId: string
  marketTitle: string
  marketSlug?: string
  eventSlug?: string
  sportTag?: string
  eventTime?: string // ISO date string for when the event starts/ends
  sideA: {
    label: string
    totalValue: number
    sharpScore: number
    holderCount: number
    topHolders: TopHolderPnlData[]
  }
  sideB: {
    label: string
    totalValue: number
    sharpScore: number
    holderCount: number
    topHolders: TopHolderPnlData[]
  }
  sharpSide: 'A' | 'B' | 'EVEN'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  scoreDifferential: number
  sharpSideValueRatio?: number // 0-1, what % of total value is on the sharp side
  edgeRating: number // 0-100, single ranking score for prioritizing bets
}

/**
 * Extract team names from market title
 */
function extractTeamNames(title: string): [string, string] | null {
  const vsMatch = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*\?.*)?$/i)
  if (vsMatch) {
    return [vsMatch[1].trim(), vsMatch[2].trim()]
  }
  const atMatch = title.match(/^(.+?)\s+@\s+(.+?)(?:\s*\?.*)?$/i)
  if (atMatch) {
    return [atMatch[1].trim(), atMatch[2].trim()]
  }
  return null
}

/**
 * Enhance market title for display - adds game context for generic O/U and Spread titles
 * Uses slug to extract team info when title is generic
 * e.g., "O/U 43.5" with slug "cfb-nmx-minnst-2025-12-26-total-43pt5" → "New Mexico vs. Minnesota: O/U 43.5"
 */
function enhanceMarketTitle(title: string, slug?: string): string {
  // Only enhance generic O/U or Spread titles
  const isGenericOU = /^O\/U\s+[\d.]+$/i.test(title)
  const isGenericSpread = /^Spread:\s+/i.test(title) && !title.includes(' vs')
  
  if (!slug || (!isGenericOU && !isGenericSpread)) {
    return title
  }
  
  // Extract game info from slug
  // Format: {sport}-{team1}-{team2}-{date}-{type}
  // e.g., cfb-nmx-minnst-2025-12-26-total-43pt5, nba-cha-orl-2025-12-26-total-230pt5
  const slugMatch = slug.match(/^(?:cfb|nfl|nba|nhl|mlb|ncaab|epl)-([a-z0-9]+)-([a-z0-9]+)-\d{4}-\d{2}-\d{2}/i)
  
  if (!slugMatch) {
    return title
  }
  
  const team1Code = slugMatch[1].toUpperCase()
  const team2Code = slugMatch[2].toUpperCase()
  
  // Build enhanced title
  return `${team1Code} vs ${team2Code}: ${title}`
}

/**
 * CLOB API market response type
 */
interface ClobMarket {
  condition_id: string
  question: string
  slug?: string
  end_date_iso?: string
  game_start_time?: string
  category?: string
  active?: boolean
  closed?: boolean
  tokens?: Array<{ outcome: string }>
}

/**
 * Fetch trending sports markets - tries CLOB API first, then Gamma
 */
export const fetchTrendingSportsMarketsFn = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => {
    console.log('[sharp-money] fetchTrendingSportsMarketsFn called')
    const payload = data as { limit?: number; sportTags?: string[] }
    const limit = payload.limit ?? 50
    // Use TARGET_SPORT_TAGS if sportTags is undefined, null, or empty array
    const sportTags = payload.sportTags && payload.sportTags.length > 0 
      ? payload.sportTags 
      : TARGET_SPORT_TAGS
    console.log('[sharp-money] Received sportTags:', payload.sportTags, '→ Using:', sportTags)

    // Use Gamma API with tag_id filtering for sports markets
    try {
      // Map sport tags to tag IDs
      const tagIdsToFetch = sportTags
        .map(tag => SPORT_TAG_IDS[tag])
        .filter((id): id is number => id !== undefined)
      
      if (tagIdsToFetch.length === 0) {
        // Use all sport tag IDs if no specific sport selected
        tagIdsToFetch.push(...ALL_SPORT_TAG_IDS)
      }
      
      // Date range: now to 24 hours from now
      const today = new Date()
      const endDateMin = today.toISOString().split('T')[0]
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)
      const endDateMax = tomorrow.toISOString().split('T')[0]
      
      console.log(`[sharp-money] Fetching games from ${endDateMin} to ${endDateMax}`)
      console.log(`[sharp-money] Fetching markets for tag IDs: ${tagIdsToFetch.join(', ')}`)
      
      // Fetch markets for each sport tag (Gamma API only supports one tag_id at a time)
      const allSportsMarkets: GammaMarket[] = []
      
      for (const tagId of tagIdsToFetch) { // Fetch all configured sports
        const url = new URL('/markets', POLYMARKET_GAMMA_API)
        url.searchParams.set('tag_id', tagId.toString())
        url.searchParams.set('closed', 'false')
        url.searchParams.set('limit', '100')
        url.searchParams.set('end_date_min', endDateMin)
        url.searchParams.set('end_date_max', endDateMax)
        url.searchParams.set('volume_num_min', MIN_VOLUME_USD.toString())
        
        try {
          const response = await fetch(url)
          if (response.ok) {
            const markets = (await response.json()) as GammaMarket[]
            console.log(`[sharp-money] Tag ${tagId}: found ${markets.length} upcoming games`)
            allSportsMarkets.push(...markets)
          }
        } catch (err) {
          console.warn(`[sharp-money] Failed to fetch tag ${tagId}:`, err)
        }
        
        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      
      console.log(`[sharp-money] Total sports markets found: ${allSportsMarkets.length}`)
      
      // Filter to markets with condition IDs, dedupe, exclude started games, and within 24 hours
      const now = new Date()
      const twentyFourHoursFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
      const seenIds = new Set<string>()
      const sportsMarkets = allSportsMarkets.filter(market => {
        if (!market.conditionId || seenIds.has(market.conditionId)) return false
        if (market.endDate) {
          const gameTime = new Date(market.endDate)
          // Exclude games that have already started
          if (gameTime < now) return false
          // Exclude games more than 24 hours out
          if (gameTime > twentyFourHoursFromNow) return false
        }
        seenIds.add(market.conditionId)
        return true
      })
      
      // Sort by volume (highest first) for consistent, quality-focused results
      const sorted = sportsMarkets.sort((a, b) => {
        const volA = a.volumeNum ?? a.volume ?? 0
        const volB = b.volumeNum ?? b.volume ?? 0
        return volB - volA
      })

      if (sorted.length > 0) {
        console.log(`[sharp-money] Top markets by volume:`, sorted.slice(0, 5).map(m => 
          `${m.question?.slice(0, 30)} ($${((m.volumeNum ?? 0) / 1000).toFixed(0)}k)`
        ))
      }

      // Take top N by volume
      const topMarkets = sorted.slice(0, limit).map((market) => ({
        id: market.id,
        conditionId: market.conditionId,
        title: enhanceMarketTitle(market.question ?? '', market.slug),
        slug: market.slug,
        eventSlug: market.eventSlug,
        sportTag: detectSportTag({
          title: market.question,
          slug: market.slug,
          eventSlug: market.eventSlug,
        }),
        volume: market.volumeNum ?? market.volume ?? 0,
        liquidity: market.liquidityNum ?? market.liquidity ?? 0,
        outcomes: parseOutcomes(market.outcomes),
        endDate: market.endDate,
      }))

      return { markets: topMarkets }
    } catch (error) {
      console.warn('Error fetching trending sports markets', error)
      return { markets: [] }
    }
  },
)

/**
 * Fetch PnL for a user across multiple time periods
 */
export const fetchMultiPeriodPnlFn = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => {
    const payload = data as { walletAddress: string }
    const walletAddress = payload.walletAddress

    if (!walletAddress) {
      return { pnl: null }
    }

    const periods = ['DAY', 'WEEK', 'MONTH', 'ALL'] as const

    try {
      // Fetch all periods in parallel
      const results = await Promise.all(
        periods.map(async (period) => {
          try {
            const url = new URL('/v1/leaderboard', POLYMARKET_DATA_API)
            url.searchParams.set('user', walletAddress)
            url.searchParams.set('timePeriod', period)

            const response = await fetch(url)

            if (!response.ok) {
              return { period, pnl: null, volume: undefined }
            }

            const data = (await response.json()) as Array<{
              pnl?: number
              vol?: number
            }>

            if (!Array.isArray(data) || data.length === 0) {
              return { period, pnl: null, volume: undefined }
            }

            return {
              period,
              pnl: data[0].pnl ?? null,
              volume: data[0].vol,
            }
          } catch {
            return { period, pnl: null, volume: undefined }
          }
        }),
      )

      const pnlByPeriod: MultiPeriodPnl = {
        day: null,
        week: null,
        month: null,
        all: null,
        volume: undefined,
      }

      for (const result of results) {
        switch (result.period) {
          case 'DAY':
            pnlByPeriod.day = result.pnl
            break
          case 'WEEK':
            pnlByPeriod.week = result.pnl
            break
          case 'MONTH':
            pnlByPeriod.month = result.pnl
            break
          case 'ALL':
            pnlByPeriod.all = result.pnl
            pnlByPeriod.volume = result.volume
            break
        }
      }

      return { pnl: pnlByPeriod }
    } catch (error) {
      console.warn('Error fetching multi-period PnL', walletAddress, error)
      return { pnl: null }
    }
  },
)

/**
 * Batch fetch multi-period PnL for multiple users
 * Processes sequentially with delays to avoid rate limits
 */
export const fetchBatchMultiPeriodPnlFn = createServerFn({ method: 'POST' }).handler(
  async ({ context, data }) => {
    const payload = data as { walletAddresses: string[] }
    const walletAddresses = payload.walletAddresses

    if (!walletAddresses || walletAddresses.length === 0) {
      return { results: {} as Record<string, MultiPeriodPnl> }
    }

    const db = getDb(context)
    const results: Record<string, MultiPeriodPnl> = {}
    const uniqueWallets = [...new Set(walletAddresses)]

    // Check cache first (1 hour TTL)
    const cacheExpiry = Math.floor(Date.now() / 1000) - 3600
    const cachedResults = await all<{
      wallet_address: string
      pnl_day: number | null
      pnl_week: number | null
      pnl_month: number | null
      pnl_all: number | null
      volume: number | null
    }>(
      db,
      `SELECT * FROM wallet_pnl_cache WHERE wallet_address IN (${uniqueWallets.map(() => '?').join(',')}) AND fetched_at > ?`,
      ...uniqueWallets,
      cacheExpiry,
    )

    // Populate results from cache
    const cachedWallets = new Set<string>()
    for (const row of cachedResults) {
      cachedWallets.add(row.wallet_address)
      results[row.wallet_address] = {
        day: row.pnl_day,
        week: row.pnl_week,
        month: row.pnl_month,
        all: row.pnl_all,
        volume: row.volume ?? undefined,
      }
    }

    // Only fetch wallets not in cache
    const walletsToFetch = uniqueWallets.filter(w => !cachedWallets.has(w))
    console.log(`[sharp-money] fetchBatchMultiPeriodPnlFn: ${cachedWallets.size} cached, ${walletsToFetch.length} to fetch`)

    // Fetch uncached wallets (max 10 wallets = 40 subrequests, staying under 50 limit)
    const maxToFetch = Math.min(walletsToFetch.length, 10)
    const batchSize = 2 // Process 2 wallets at a time (8 subrequests per batch)

    for (let i = 0; i < maxToFetch; i += batchSize) {
      const batch = walletsToFetch.slice(i, i + batchSize)

      await Promise.all(
        batch.map(async (walletAddress) => {
          const periods = ['DAY', 'WEEK', 'MONTH', 'ALL'] as const
          const pnl: MultiPeriodPnl = {
            day: null,
            week: null,
            month: null,
            all: null,
            volume: undefined,
          }
          let walletSuccess = false

          const periodResults = await Promise.all(
            periods.map(async (period) => {
              try {
                const url = new URL('/v1/leaderboard', POLYMARKET_DATA_API)
                url.searchParams.set('user', walletAddress)
                url.searchParams.set('timePeriod', period)

                const response = await fetch(url)

                if (!response.ok) {
                  return { period, pnl: null, volume: undefined }
                }

                const data = (await response.json()) as Array<{
                  pnl?: number
                  vol?: number
                }>

                if (!Array.isArray(data) || data.length === 0) {
                  return { period, pnl: null, volume: undefined }
                }

                walletSuccess = true
                return {
                  period,
                  pnl: data[0].pnl ?? null,
                  volume: data[0].vol,
                }
              } catch {
                return { period, pnl: null, volume: undefined }
              }
            }),
          )

          for (const result of periodResults) {
            switch (result.period) {
              case 'DAY':
                pnl.day = result.pnl
                break
              case 'WEEK':
                pnl.week = result.pnl
                break
              case 'MONTH':
                pnl.month = result.pnl
                break
              case 'ALL':
                pnl.all = result.pnl
                pnl.volume = result.volume
                break
            }
          }

          if (walletSuccess) {
            // Cache the result
            await run(
              db,
              `INSERT OR REPLACE INTO wallet_pnl_cache (wallet_address, pnl_day, pnl_week, pnl_month, pnl_all, volume, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              walletAddress,
              pnl.day,
              pnl.week,
              pnl.month,
              pnl.all,
              pnl.volume ?? null,
              Math.floor(Date.now() / 1000),
            )
          }

          results[walletAddress] = pnl
        }),
      )

      // Delay between batches to avoid rate limits
      if (i + batchSize < maxToFetch) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }

    return { results }
  },
)

/**
 * Calculate momentum weight based on recent PnL performance
 * Higher weight = hotter streak
 */
function calculateMomentumWeight(pnl: MultiPeriodPnl): number {
  const dayPositive = (pnl.day ?? 0) > 0
  const weekPositive = (pnl.week ?? 0) > 0
  const monthPositive = (pnl.month ?? 0) > 0

  // Hot streak: positive day + positive week
  if (dayPositive && weekPositive) {
    return 1.5
  }

  // Consistent: positive week + positive month
  if (weekPositive && monthPositive) {
    return 1.2
  }

  // Recent positive
  if (dayPositive || weekPositive) {
    return 1.1
  }

  // Neutral or mixed
  if (monthPositive) {
    return 1.0
  }

  // Cold streak
  const dayNegative = (pnl.day ?? 0) < 0
  const weekNegative = (pnl.week ?? 0) < 0

  if (dayNegative && weekNegative) {
    return 0.5
  }

  return 0.8
}

/**
 * Calculate PnL tier weight based on all-time profitability
 * Higher weight = more profitable trader
 */
function calculatePnlTierWeight(pnlAll: number | null): number {
  if (pnlAll === null) {
    return 1.0
  }

  // Whale sharp: >$100k profit
  if (pnlAll >= 100_000) {
    return 2.0
  }

  // Solid sharp: $10k-$100k profit
  if (pnlAll >= 10_000) {
    return 1.5
  }

  // Minor positive: $0-$10k profit
  if (pnlAll >= 0) {
    return 1.0
  }

  // Losing trader: negative PnL (potential fade signal)
  if (pnlAll >= -10_000) {
    return 0.8
  }

  // Big loser
  return 0.7
}

/**
 * Calculate "fade boost" from anti-sharps on one side
 * Anti-sharps are big losers on cold streaks - betting against them is valuable
 * Returns a multiplier (1.0 = no boost, 1.15 = 15% boost)
 */
function calculateFadeBoost(holders: TopHolderPnlData[], totalValue: number): number {
  if (holders.length === 0 || totalValue <= 0) {
    return 1.0
  }

  let fadeBoostSum = 0

  for (const holder of holders) {
    const pnlAll = holder.pnlAll ?? 0
    const isOnColdStreak = holder.momentumWeight <= 0.5 // Day + Week negative

    // Only count as anti-sharp if big loser AND on cold streak
    if (pnlAll < -50_000 && isOnColdStreak) {
      const positionWeight = holder.amount / totalValue

      // Fade boost based on how much they've lost
      let fadeMultiplier = 0
      if (pnlAll < -250_000) {
        fadeMultiplier = 0.15 // Severe loser: 15% boost to other side
      } else if (pnlAll < -100_000) {
        fadeMultiplier = 0.10 // Moderate loser: 10% boost
      } else {
        fadeMultiplier = 0.05 // Mild loser: 5% boost
      }

      // Weight by their position size (bigger position = stronger fade signal)
      fadeBoostSum += positionWeight * fadeMultiplier
    }
  }

  // Cap total fade boost at 20%
  return 1.0 + Math.min(fadeBoostSum, 0.20)
}

/**
 * Calculate sharp score for a side
 * Returns 0-100 scale
 */
function calculateSharpScore(holders: TopHolderPnlData[], totalValue: number): number {
  if (holders.length === 0 || totalValue <= 0) {
    return 50 // Neutral score
  }

  let weightedSum = 0

  for (const holder of holders) {
    const positionWeight = holder.amount / totalValue
    const combinedWeight = holder.momentumWeight * holder.pnlTierWeight
    weightedSum += positionWeight * combinedWeight
  }

  // Normalize to 0-100 scale
  // Average weight is ~1.0, max is 3.0 (1.5 * 2.0), min is 0.35 (0.5 * 0.7)
  // Scale so that 1.0 = 50, 3.0 = 100, 0.35 = 0
  const normalized = ((weightedSum - 0.35) / (3.0 - 0.35)) * 100
  return Math.max(0, Math.min(100, normalized))
}

/**
 * Determine confidence level based on score differential and conviction
 */
function determineConfidence(
  scoreDiff: number,
  sideAHolderCount: number,
  sideBHolderCount: number,
  sharpSideValueRatio: number, // 0-1, what % of total value is on the sharp side
): 'HIGH' | 'MEDIUM' | 'LOW' {
  const minHolders = Math.min(sideAHolderCount, sideBHolderCount)

  // Need at least 3 holders on each side for any confidence
  if (minHolders < 3) {
    return 'LOW'
  }

  // Calculate base confidence from score differential
  let baseConfidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW'
  
  if (scoreDiff >= 15 && minHolders >= 5) {
    baseConfidence = 'HIGH'
  } else if (scoreDiff >= 8) {
    baseConfidence = 'MEDIUM'
  }

  // Downgrade confidence if sharp side has very low conviction (< 15% of total value)
  // This catches cases like Jets: $8.8K vs Patriots: $71.8K (Jets = 10.9%)
  if (sharpSideValueRatio < 0.15) {
    if (baseConfidence === 'HIGH') return 'MEDIUM'
    if (baseConfidence === 'MEDIUM') return 'LOW'
  }
  // Also downgrade if sharp side has < 25% and trying to be HIGH
  else if (sharpSideValueRatio < 0.25 && baseConfidence === 'HIGH') {
    return 'MEDIUM'
  }

  return baseConfidence
}

/**
 * Calculate Edge Rating (0-100) for ranking bets
 * Primary factor: Sharp score differential
 * Bonus/Penalty: Quality of top 20 holders (avg PnL including losers)
 */
function calculateEdgeRating(
  scoreDifferential: number,
  sharpSideTopHolders: TopHolderPnlData[],
  holderCount: number,
): number {
  // Base rating from score differential (max 70 points)
  // Score diff ranges from 0-100 theoretically, but usually 10-60 in practice
  // Map: 0 diff = 0, 30+ diff = 70
  const diffScore = Math.min((scoreDifferential / 30) * 70, 70)
  
  // Holder quality bonus/penalty (-10 to +20 points)
  // Based on avg all-time PnL of ALL top 20 sharp side holders (including losers!)
  let qualityBonus = 0
  if (sharpSideTopHolders.length > 0) {
    // Use ALL holders passed in (top 20), not just top 5
    const holderPnLs = sharpSideTopHolders.map(h => h.pnlAll ?? 0)
    
    if (holderPnLs.length > 0) {
      const avgPnL = holderPnLs.reduce((a, b) => a + b, 0) / holderPnLs.length
      
      if (avgPnL >= 0) {
        // Positive avg: bonus up to 20 points ($100K+ avg = max)
        qualityBonus = Math.min((avgPnL / 100_000) * 20, 20)
      } else {
        // Negative avg: penalty up to -10 points (-$50K or worse = max penalty)
        qualityBonus = Math.max((avgPnL / 50_000) * 10, -10)
      }
    }
  }
  
  // Holder count bonus (max 10 points)
  // More holders = more reliable signal
  // 10+ holders on sharp side = max bonus
  const holderBonus = Math.min((holderCount / 10) * 10, 10)
  
  const total = diffScore + qualityBonus + holderBonus
  return Math.round(Math.max(0, Math.min(100, total)))
}

/**
 * Analyze sharp money for a single market
 */
export const analyzeMarketSharpnessFn = createServerFn({ method: 'POST' }).handler(
  async ({ context, data }) => {
    console.log('[sharp-money] analyzeMarketSharpnessFn called')
    const db = getDb(context)
    const payload = data as {
      conditionId: string
      marketTitle: string
      marketSlug?: string
      eventSlug?: string
      sportTag?: string
      outcomes?: string[]
      endDate?: string
    }

    const { conditionId, marketTitle, marketSlug, eventSlug, sportTag, outcomes, endDate } = payload
    console.log('[sharp-money] Analyzing:', { conditionId, marketTitle })

    if (!conditionId) {
      return { analysis: null, error: 'No condition ID provided' }
    }

    try {
      // Step 1: Fetch market prices and holders in parallel
      console.log('[sharp-money] Fetching market prices and holders...')
      
      const holdersUrl = new URL('/holders', POLYMARKET_DATA_API)
      holdersUrl.searchParams.set('market', conditionId)
      holdersUrl.searchParams.set('limit', '20')
      holdersUrl.searchParams.set('minBalance', '1')

      // Use CLOB API for accurate prices (Gamma API condition_id lookup is unreliable)
      const clobMarketUrl = `https://clob.polymarket.com/markets/${conditionId}`

      const [holdersResponse, clobResponse] = await Promise.all([
        fetch(holdersUrl),
        fetch(clobMarketUrl),
      ])

      if (!holdersResponse.ok) {
        return { analysis: null, error: `Failed to fetch holders: ${holdersResponse.status}` }
      }

      // Parse market prices from CLOB API (prices are 0-1, e.g. 0.65 = $0.65 per share)
      let prices: [number, number] = [1, 1] // Default to $1 if we can't get prices
      if (clobResponse.ok) {
        const clobData = await clobResponse.json() as {
          tokens?: Array<{ outcome: string; price: number }>
        }
        if (clobData?.tokens && clobData.tokens.length >= 2) {
          prices = [
            clobData.tokens[0]?.price ?? 1,
            clobData.tokens[1]?.price ?? 1,
          ]
          console.log('[sharp-money] Prices:', prices)
        }
      }

      const holdersData = (await holdersResponse.json()) as Array<{
        token: string
        holders: Array<{
          proxyWallet: string
          name?: string
          pseudonym?: string
          amount: number
          outcomeIndex: number
          profileImage?: string
          profileImageOptimized?: string
        }>
      }>

      if (!holdersData || holdersData.length === 0) {
        return { analysis: null, error: 'No holders data' }
      }

      // Step 2: Group holders by outcomeIndex (0 or 1) for consistent assignment
      // outcomeIndex 0 = first outcome (typically Yes or first team)
      // outcomeIndex 1 = second outcome (typically No or second team)
      // Convert shares to USD using market prices
      const sideAHolders: HolderWithPnl[] = []
      const sideBHolders: HolderWithPnl[] = []
      const allWallets = new Set<string>()

      // Flatten all holders and group by outcomeIndex
      for (const tokenData of holdersData) {
        for (const holder of tokenData.holders) {
          allWallets.add(holder.proxyWallet)
          
          // Convert shares to USD: shares * price
          const priceForOutcome = prices[holder.outcomeIndex] ?? 1
          const usdValue = holder.amount * priceForOutcome
          
          const holderData: HolderWithPnl = {
            proxyWallet: holder.proxyWallet,
            name: holder.name,
            pseudonym: holder.pseudonym,
            profileImage: holder.profileImageOptimized || holder.profileImage,
            amount: usdValue, // Now in USD instead of shares
            outcomeIndex: holder.outcomeIndex,
          }

          // Use outcomeIndex to determine side (0 = sideA, 1 = sideB)
          if (holder.outcomeIndex === 0) {
            sideAHolders.push(holderData)
          } else {
            sideBHolders.push(holderData)
          }
        }
      }

      // Step 3: Sort holders by position size (descending) before taking top 20
      sideAHolders.sort((a, b) => b.amount - a.amount)
      sideBHolders.sort((a, b) => b.amount - a.amount)

      // Fetch PnL for top holders on each side (top 20 each for scoring = 40 wallets)
      const topWallets = [
        ...sideAHolders.slice(0, 20).map((h) => h.proxyWallet),
        ...sideBHolders.slice(0, 20).map((h) => h.proxyWallet),
      ]

      const uniqueWallets = [...new Set(topWallets)]
      const pnlResults: Record<string, MultiPeriodPnl> = {}
      
      // Check cache first (1 hour TTL) - this doesn't count as subrequests
      const cacheExpiry = Math.floor(Date.now() / 1000) - 3600
      const cachedResults = await all<{
        wallet_address: string
        pnl_day: number | null
        pnl_week: number | null
        pnl_month: number | null
        pnl_all: number | null
        volume: number | null
      }>(
        db,
        `SELECT * FROM wallet_pnl_cache WHERE wallet_address IN (${uniqueWallets.map(() => '?').join(',')}) AND fetched_at > ?`,
        ...uniqueWallets,
        cacheExpiry,
      )
      
      // Populate results from cache
      const cachedWallets = new Set<string>()
      for (const row of cachedResults) {
        cachedWallets.add(row.wallet_address)
        pnlResults[row.wallet_address] = {
          day: row.pnl_day,
          week: row.pnl_week,
          month: row.pnl_month,
          all: row.pnl_all,
          volume: row.volume ?? undefined,
        }
      }
      
      // Only fetch wallets not in cache
      const walletsToFetch = uniqueWallets.filter(w => !cachedWallets.has(w))
      console.log(`[sharp-money] PnL: ${cachedWallets.size} cached, ${walletsToFetch.length} to fetch`)

      // Fetch uncached wallets in batches
      // We have 2 subrequests used for market data (holders + CLOB)
      // So we have ~48 subrequests left for PnL = 12 wallets × 4 periods
      // But we want all 40 wallets, so we'll fetch what we can and cache the rest for next time
      const maxToFetch = Math.min(walletsToFetch.length, 12) // 12 wallets = 48 subrequests
      const batchSize = 3 // Process 3 wallets at a time (12 subrequests per batch)
      
      for (let i = 0; i < maxToFetch; i += batchSize) {
        const batch = walletsToFetch.slice(i, i + batchSize)

        await Promise.all(
          batch.map(async (wallet) => {
            const periods = ['DAY', 'WEEK', 'MONTH', 'ALL'] as const
            const pnl: MultiPeriodPnl = { day: null, week: null, month: null, all: null }
            let walletSuccess = false

            await Promise.all(
              periods.map(async (period) => {
                try {
                  const url = new URL('/v1/leaderboard', POLYMARKET_DATA_API)
                  url.searchParams.set('user', wallet)
                  url.searchParams.set('timePeriod', period)

                  const response = await fetch(url)
                  if (!response.ok) return

                  const data = (await response.json()) as Array<{ pnl?: number; vol?: number }>
                  if (!Array.isArray(data) || data.length === 0) return

                  walletSuccess = true
                  switch (period) {
                    case 'DAY':
                      pnl.day = data[0].pnl ?? null
                      break
                    case 'WEEK':
                      pnl.week = data[0].pnl ?? null
                      break
                    case 'MONTH':
                      pnl.month = data[0].pnl ?? null
                      break
                    case 'ALL':
                      pnl.all = data[0].pnl ?? null
                      pnl.volume = data[0].vol
                      break
                  }
                } catch (err) {
                  console.log(`[sharp-money] PnL error ${wallet.slice(0,10)} ${period}:`, err)
                }
              }),
            )

            if (walletSuccess) {
              // Cache the result
              await run(
                db,
                `INSERT OR REPLACE INTO wallet_pnl_cache (wallet_address, pnl_day, pnl_week, pnl_month, pnl_all, volume, fetched_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                wallet,
                pnl.day,
                pnl.week,
                pnl.month,
                pnl.all,
                pnl.volume ?? null,
                Math.floor(Date.now() / 1000),
              )
            }
            pnlResults[wallet] = pnl
          }),
        )

        // Delay between batches
        if (i + batchSize < maxToFetch) {
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }

      // For wallets we couldn't fetch this time, use null PnL (they'll be cached next refresh)
      for (const wallet of uniqueWallets) {
        if (!pnlResults[wallet]) {
          pnlResults[wallet] = { day: null, week: null, month: null, all: null }
        }
      }

      console.log(`[sharp-money] PnL fetch: ${maxToFetch} fetched, ${cachedWallets.size} from cache, ${uniqueWallets.length - maxToFetch - cachedWallets.size} will be cached next refresh`)

      // Step 4: Calculate weights and build top holder data (top 20 for scoring, display top 5)
      const processHolders = (holders: HolderWithPnl[]): TopHolderPnlData[] => {
        return holders.slice(0, 20).map((holder) => {
          const pnl = pnlResults[holder.proxyWallet] ?? {
            day: null,
            week: null,
            month: null,
            all: null,
          }

          const momentumWeight = calculateMomentumWeight(pnl)
          const pnlTierWeight = calculatePnlTierWeight(pnl.all)

          return {
            proxyWallet: holder.proxyWallet,
            name: holder.name,
            pseudonym: holder.pseudonym,
            profileImage: holder.profileImage,
            amount: holder.amount,
            pnlDay: pnl.day,
            pnlWeek: pnl.week,
            pnlMonth: pnl.month,
            pnlAll: pnl.all,
            volume: pnl.volume,
            momentumWeight,
            pnlTierWeight,
          }
        })
      }

      const sideATopHolders = processHolders(sideAHolders)
      const sideBTopHolders = processHolders(sideBHolders)

      // Step 5: Calculate totals and scores
      const sideATotalValue = sideAHolders.reduce((sum, h) => sum + h.amount, 0)
      const sideBTotalValue = sideBHolders.reduce((sum, h) => sum + h.amount, 0)

      // Calculate raw sharp scores
      const sideARawScore = calculateSharpScore(sideATopHolders, sideATotalValue)
      const sideBRawScore = calculateSharpScore(sideBTopHolders, sideBTotalValue)

      // Calculate fade boosts (anti-sharps on one side boost the other side)
      const fadeBoostFromSideA = calculateFadeBoost(sideATopHolders, sideATotalValue)
      const fadeBoostFromSideB = calculateFadeBoost(sideBTopHolders, sideBTotalValue)

      // Apply fade boosts: anti-sharps on A boost B's score, and vice versa
      const sideASharpScore = Math.min(100, sideARawScore * fadeBoostFromSideB)
      const sideBSharpScore = Math.min(100, sideBRawScore * fadeBoostFromSideA)

      const scoreDifferential = Math.abs(sideASharpScore - sideBSharpScore)

      // Determine labels
      // Check for special market types first
      const isOverUnder = /O\/U|Over\/Under|over\/under/i.test(marketTitle)
      const isSpread = /Spread:/i.test(marketTitle)
      
      let sideALabel: string
      let sideBLabel: string
      
      if (isOverUnder) {
        // O/U markets: use Over/Under labels
        sideALabel = 'Over'
        sideBLabel = 'Under'
      } else if (isSpread) {
        // Spread markets: use the outcomes from API (e.g., "Patriots", "Jets")
        sideALabel = outcomes?.[0] ?? 'Yes'
        sideBLabel = outcomes?.[1] ?? 'No'
      } else {
        // Regular game markets: extract team names from title
        const teamNames = extractTeamNames(marketTitle)
        sideALabel = teamNames ? teamNames[0] : (outcomes?.[0] ?? 'Yes')
        sideBLabel = teamNames ? teamNames[1] : (outcomes?.[1] ?? 'No')
      }

      // Determine sharp side
      let sharpSide: 'A' | 'B' | 'EVEN' = 'EVEN'
      if (sideASharpScore > sideBSharpScore + 5) {
        sharpSide = 'A'
      } else if (sideBSharpScore > sideASharpScore + 5) {
        sharpSide = 'B'
      }

      // Calculate sharp side's value ratio (conviction)
      const totalMarketValue = sideATotalValue + sideBTotalValue
      let sharpSideValueRatio = 0.5 // Default to 50% if even
      if (sharpSide === 'A' && totalMarketValue > 0) {
        sharpSideValueRatio = sideATotalValue / totalMarketValue
      } else if (sharpSide === 'B' && totalMarketValue > 0) {
        sharpSideValueRatio = sideBTotalValue / totalMarketValue
      }

      const confidence = determineConfidence(
        scoreDifferential,
        sideAHolders.length,
        sideBHolders.length,
        sharpSideValueRatio,
      )

      // Calculate Edge Rating for ranking
      const sharpSideTopHolders = sharpSide === 'A' ? sideATopHolders : sideBTopHolders
      const sharpSideHolderCount = sharpSide === 'A' ? sideAHolders.length : sideBHolders.length
      const edgeRating = calculateEdgeRating(
        scoreDifferential,
        sharpSideTopHolders,
        sharpSideHolderCount,
      )

      const analysis: SharpAnalysisResult = {
        conditionId,
        marketTitle,
        marketSlug,
        eventSlug,
        sportTag,
        eventTime: endDate,
        sideA: {
          label: sideALabel,
          totalValue: sideATotalValue,
          sharpScore: sideASharpScore,
          holderCount: sideAHolders.length,
          topHolders: sideATopHolders.slice(0, 5),
        },
        sideB: {
          label: sideBLabel,
          totalValue: sideBTotalValue,
          sharpScore: sideBSharpScore,
          holderCount: sideBHolders.length,
          topHolders: sideBTopHolders.slice(0, 5),
        },
        sharpSide,
        confidence,
        scoreDifferential,
        sharpSideValueRatio,
        edgeRating,
      }

      return { analysis, allWalletAddresses: uniqueWallets }
    } catch (error) {
      console.error('Error analyzing market sharpness', conditionId, error)
      return { analysis: null, error: 'Analysis failed' }
    }
  },
)

/**
 * Get cached sharp money data
 */
export const getSharpMoneyCacheFn = createServerFn({ method: 'POST' }).handler(
  async ({ context, data }) => {
    const payload = data as { sportTag?: string; limit?: number }
    const db = getDb(context)

    const entries = await listSharpMoneyCache(db, {
      sportTag: payload.sportTag,
      limit: payload.limit ?? 50,
    })

    return { entries }
  },
)

/**
 * Get cache stats
 */
export const getSharpMoneyCacheStatsFn = createServerFn({ method: 'POST' }).handler(
  async ({ context }) => {
    const db = getDb(context)
    const stats = await getSharpMoneyCacheStats(db)
    return { stats }
  },
)

/**
 * Clear all cached sharp money data
 */
export const clearSharpMoneyCacheFn = createServerFn({ method: 'POST' }).handler(
  async ({ context }) => {
    const db = getDb(context)
    await clearAllSharpMoneyCache(db)
    console.log('[sharp-money] Cache cleared')
    return { success: true }
  },
)

/**
 * Manually refresh sharp money analysis for a specific market
 */
export const refreshMarketSharpnessFn = createServerFn({ method: 'POST' }).handler(
  async ({ context, data }) => {
    console.log('[sharp-money] refreshMarketSharpnessFn called')
    const payload = data as {
      conditionId: string
      marketTitle: string
      marketSlug?: string
      eventSlug?: string
      sportTag?: string
      outcomes?: string[]
      endDate?: string
    }
    
    // Validate this is actually a sports market before processing
    const descriptor = {
      title: payload.marketTitle,
      slug: payload.marketSlug,
      eventSlug: payload.eventSlug,
    }
    
    console.log('[sharp-money] Checking descriptor:', JSON.stringify(descriptor))
    
    const detectedSportTag = detectSportTag(descriptor)
    const isSport = isSportsMarket(descriptor)
    
    console.log('[sharp-money] Detection result:', { isSport, detectedSportTag })
    
    if (!isSport) {
      console.warn('[sharp-money] REJECTED - Not a sports market:', payload.marketTitle)
      return { success: false, error: 'Not a sports market' }
    }
    
    if (!detectedSportTag || !TARGET_SPORT_TAGS.includes(detectedSportTag)) {
      console.warn('[sharp-money] REJECTED - Not a target sport:', payload.marketTitle, detectedSportTag)
      return { success: false, error: 'Not a target sport' }
    }
    
    console.log('[sharp-money] ACCEPTED:', payload.marketTitle, '| sport:', detectedSportTag)

    const db = getDb(context)

    // Run analysis
    const { analysis, error, allWalletAddresses } = await analyzeMarketSharpnessFn({ data: payload })

    if (!analysis) {
      console.warn('[sharp-money] Analysis failed:', error)
      return { success: false, error }
    }
    console.log('[sharp-money] Analysis complete:', analysis.sharpSide, analysis.confidence)

    // Save to cache
    const cacheInput: UpsertSharpMoneyCacheInput = {
      conditionId: analysis.conditionId,
      marketTitle: analysis.marketTitle,
      marketSlug: analysis.marketSlug,
      eventSlug: analysis.eventSlug,
      sportTag: analysis.sportTag,
      eventTime: analysis.eventTime,
      sideA: analysis.sideA,
      sideB: analysis.sideB,
      sharpSide: analysis.sharpSide,
      confidence: analysis.confidence,
      scoreDifferential: analysis.scoreDifferential,
      sharpSideValueRatio: analysis.sharpSideValueRatio,
      edgeRating: analysis.edgeRating,
    }

    await upsertSharpMoneyCache(db, cacheInput)

    return { success: true, analysis, allWalletAddresses }
  },
)
