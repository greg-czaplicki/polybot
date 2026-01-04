import type { Env } from '../env'
import { nowUnixSeconds } from '../env'
import {
  upsertSharpMoneyCache,
  pruneSharpMoneyCache,
  type TopHolderPnlData,
  type UpsertSharpMoneyCacheInput,
} from '../repositories/sharp-money'

const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com'
const POLYMARKET_DATA_API = 'https://data-api.polymarket.com'

// Gamma API tag IDs for sports (from /sports endpoint)
const SPORT_TAG_IDS: Record<string, number> = {
  nfl: 450,
  nba: 745,
  ncaab: 100149,
  mlb: 100381,
  nhl: 899,
  epl: 82,
  laliga: 780,
  bundesliga: 1494,
}


// Minimum volume to show in sharp money
const MIN_VOLUME_USD = 50000
const UNIT_SIZE_SAMPLE_LIMIT = 20
const MIN_UNIT_SIZE_SAMPLES = 3

// Target sport tags for sharp money analysis
// Note: 'soccer' is what detectSportTag returns for EPL games
const TARGET_SPORT_TAGS = ['nfl', 'nba', 'ncaaf', 'ncaab', 'mlb', 'nhl', 'epl', 'soccer']

// Configuration
const MAX_MARKETS_PER_RUN = 10 // Limit to avoid rate limits
const DELAY_BETWEEN_MARKETS_MS = 1000 // 1 second delay between markets
const DELAY_BETWEEN_PNL_BATCHES_MS = 200 // 200ms delay between PnL batches

interface GammaMarket {
  id: string
  question: string
  conditionId: string
  slug: string
  eventSlug?: string
  volumeNum?: number
  volume?: number
  closed?: boolean
  active?: boolean
  outcomes?: string
}

interface HolderData {
  proxyWallet: string
  name?: string
  pseudonym?: string
  amount: number
  outcomeIndex: number
  profileImage?: string
  profileImageOptimized?: string
}

interface MultiPeriodPnl {
  day: number | null
  week: number | null
  month: number | null
  all: number | null
  volume?: number
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

type ClosedPosition = {
  avgPrice?: number
  totalBought: number
  realizedPnl: number
}

type OpenPosition = {
  avgPrice?: number
  initialValue?: number
  size?: number
  totalBought?: number
}

function calculateMedian(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

function calculateMedianTopHalf(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const start = Math.floor(sorted.length / 2)
  const topHalf = sorted.slice(start)
  return calculateMedian(topHalf)
}

function normalizePnl(pnl: number | null | undefined, unitSize: number | null | undefined): number | null {
  if (pnl === null || pnl === undefined) return null
  if (!unitSize || unitSize <= 0) return null
  return pnl / unitSize
}

function calculateStakeUnitWeight(stakeUnits: number | null | undefined): number {
  if (stakeUnits === null || stakeUnits === undefined || !Number.isFinite(stakeUnits)) {
    return 1.0
  }

  const clampedUnits = Math.max(stakeUnits, 0)
  const raw = Math.sqrt(clampedUnits)
  return Math.min(2.0, Math.max(0.25, raw))
}

async function fetchWalletUnitSize(walletAddress: string): Promise<number | null> {
  try {
    const openUrl = new URL('/positions', POLYMARKET_DATA_API)
    openUrl.searchParams.set('user', walletAddress)
    openUrl.searchParams.set('sizeThreshold', '1')
    openUrl.searchParams.set('limit', '100')
    openUrl.searchParams.set('sortBy', 'INITIAL')
    openUrl.searchParams.set('sortDirection', 'DESC')

    const openResponse = await fetch(openUrl)
    if (openResponse.ok) {
      const openData = (await openResponse.json()) as OpenPosition[]
      if (Array.isArray(openData) && openData.length > 0) {
        const openStakes = openData
          .map((position) =>
            position.initialValue ?? ((position.size ?? position.totalBought ?? 0) * (position.avgPrice ?? 0)),
          )
          .filter((value) => Number.isFinite(value) && value > 0)

        if (openStakes.length >= MIN_UNIT_SIZE_SAMPLES) {
          return calculateMedianTopHalf(openStakes)
        }
      }
    }

    const closedUrl = new URL('/closed-positions', POLYMARKET_DATA_API)
    closedUrl.searchParams.set('user', walletAddress)
    closedUrl.searchParams.set('limit', String(UNIT_SIZE_SAMPLE_LIMIT))
    closedUrl.searchParams.set('sortBy', 'TIMESTAMP')
    closedUrl.searchParams.set('sortDirection', 'DESC')

    const closedResponse = await fetch(closedUrl)
    if (!closedResponse.ok) return null

    const closedData = (await closedResponse.json()) as ClosedPosition[]
    if (!Array.isArray(closedData) || closedData.length === 0) return null

    const closedStakes = closedData
      .map((position) => (position.totalBought ?? 0) * (position.avgPrice ?? 0))
      .filter((value) => Number.isFinite(value) && value > 0)

    if (closedStakes.length < MIN_UNIT_SIZE_SAMPLES) {
      return null
    }

    return calculateMedianTopHalf(closedStakes)
  } catch {
    return null
  }
}

/**
 * Calculate momentum weight based on recent PnL performance
 */
function calculateMomentumWeight(pnl: MultiPeriodPnl): number {
  const dayPositive = (pnl.day ?? 0) > 0
  const weekPositive = (pnl.week ?? 0) > 0
  const monthPositive = (pnl.month ?? 0) > 0

  if (dayPositive && weekPositive) return 1.5
  if (weekPositive && monthPositive) return 1.2
  if (dayPositive || weekPositive) return 1.1
  if (monthPositive) return 1.0

  const dayNegative = (pnl.day ?? 0) < 0
  const weekNegative = (pnl.week ?? 0) < 0

  if (dayNegative && weekNegative) return 0.5
  return 0.8
}

/**
 * Calculate PnL tier weight based on all-time profitability
 */
function calculatePnlTierWeight(pnlAll: number | null, pnlAllUnits?: number | null): number {
  const useUnits = pnlAllUnits !== null && pnlAllUnits !== undefined
  const value = useUnits ? pnlAllUnits : pnlAll

  if (value === null || value === undefined) return 1.0

  if (useUnits) {
    if (value >= 30) return 2.0
    if (value >= 15) return 1.7
    if (value >= 7) return 1.4
    if (value >= 3) return 1.2
    if (value >= 0) return 1.0
    if (value >= -3) return 0.9
    if (value >= -7) return 0.8
    if (value >= -15) return 0.7
    if (value >= -30) return 0.6
    return 0.5
  }

  if (value >= 100_000) return 2.0
  if (value >= 10_000) return 1.5
  if (value >= 0) return 1.0
  if (value >= -10_000) return 0.8
  return 0.7
}

/**
 * Calculate sharp score for a side
 */
function calculateSharpScore(holders: TopHolderPnlData[], totalValue: number): number {
  if (holders.length === 0 || totalValue <= 0) return 50

  const effectiveTotalValue = holders.reduce(
    (sum, holder) => sum + holder.amount * (holder.stakeUnitWeight ?? 1),
    0,
  )

  let weightedSum = 0
  for (const holder of holders) {
    const positionWeight =
      effectiveTotalValue > 0
        ? (holder.amount * (holder.stakeUnitWeight ?? 1)) / effectiveTotalValue
        : holder.amount / totalValue
    const combinedWeight = holder.momentumWeight * holder.pnlTierWeight * (holder.stakeUnitWeight ?? 1)
    weightedSum += positionWeight * combinedWeight
  }

  const normalized = ((weightedSum - 0.35) / (3.0 - 0.35)) * 100
  return Math.max(0, Math.min(100, normalized))
}

/**
 * Calculate "fade boost" from anti-sharps on one side
 * Anti-sharps are big losers on cold streaks - betting against them is valuable
 * Returns a multiplier (1.0 = no boost, 1.18 = 18% boost)
 */
function calculateFadeBoost(holders: TopHolderPnlData[], totalValue: number): number {
  if (holders.length === 0 || totalValue <= 0) return 1.0

  const effectiveTotalValue = holders.reduce(
    (sum, holder) => sum + holder.amount * (holder.stakeUnitWeight ?? 1),
    0,
  )

  let fadeBoostSum = 0

  for (const holder of holders) {
    const hasUnitPnl = holder.pnlAllUnits !== null && holder.pnlAllUnits !== undefined
    const pnlAll = hasUnitPnl ? holder.pnlAllUnits ?? 0 : holder.pnlAll ?? 0
    const isOnColdStreak = holder.momentumWeight <= 0.5

    const mildLoss = hasUnitPnl ? -7 : -50_000
    const moderateLoss = hasUnitPnl ? -15 : -100_000
    const severeLoss = hasUnitPnl ? -30 : -250_000

    if (pnlAll < mildLoss && isOnColdStreak) {
      const positionWeight =
        effectiveTotalValue > 0
          ? (holder.amount * (holder.stakeUnitWeight ?? 1)) / effectiveTotalValue
          : holder.amount / totalValue

      let fadeMultiplier = 0
      if (pnlAll < severeLoss) {
        fadeMultiplier = 0.18
      } else if (pnlAll < moderateLoss) {
        fadeMultiplier = 0.12
      } else {
        fadeMultiplier = 0.07
      }

      fadeBoostSum += positionWeight * fadeMultiplier
    }
  }

  return 1.0 + Math.min(fadeBoostSum, 0.30)
}

/**
 * Determine confidence level
 */
function determineConfidence(
  scoreDiff: number,
  sideAHolderCount: number,
  sideBHolderCount: number,
): 'HIGH' | 'MEDIUM' | 'LOW' {
  const minHolders = Math.min(sideAHolderCount, sideBHolderCount)

  if (minHolders < 3) return 'LOW'
  if (scoreDiff >= 15 && minHolders >= 5) return 'HIGH'
  if (scoreDiff >= 8) return 'MEDIUM'
  return 'LOW'
}

/**
 * Fetch upcoming sports games using Gamma API tag_id filtering
 * Only fetches games happening in the next 3 days (not futures)
 */
async function fetchTrendingSportsMarkets(limit: number): Promise<GammaMarket[]> {
  const allSportsMarkets: GammaMarket[] = []
  const tagIds = Object.values(SPORT_TAG_IDS)
  
  // Date range: today to 3 days from now
  const today = new Date()
  const endDateMin = today.toISOString().split('T')[0]
  const futureDate = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000)
  const endDateMax = futureDate.toISOString().split('T')[0]
  
  console.log(`[sharp-money-cron] Fetching games from ${endDateMin} to ${endDateMax}`)
  
  // Fetch markets for each sport tag
  for (const tagId of tagIds.slice(0, 7)) { // Limit to 7 sports
    try {
      const url = new URL('/markets', POLYMARKET_GAMMA_API)
      url.searchParams.set('tag_id', tagId.toString())
      url.searchParams.set('closed', 'false')
      url.searchParams.set('limit', '30')
      url.searchParams.set('end_date_min', endDateMin)
      url.searchParams.set('end_date_max', endDateMax)
      url.searchParams.set('volume_num_min', MIN_VOLUME_USD.toString())
      
      const response = await fetch(url)
      if (response.ok) {
        const markets = (await response.json()) as GammaMarket[]
        console.log(`[sharp-money-cron] Tag ${tagId}: found ${markets.length} upcoming games`)
        allSportsMarkets.push(...markets)
      }
      
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 100))
    } catch (error) {
      console.warn(`[sharp-money-cron] Failed to fetch tag ${tagId}:`, error)
    }
  }
  
  // Dedupe by conditionId
  const seenIds = new Set<string>()
  const uniqueMarkets = allSportsMarkets.filter(market => {
    if (!market.conditionId || seenIds.has(market.conditionId)) return false
    seenIds.add(market.conditionId)
    return true
  })
  
  console.log(`[sharp-money-cron] Total unique upcoming games: ${uniqueMarkets.length}`)
  return uniqueMarkets.slice(0, limit)
}

/**
 * Fetch holders for a market
 */
async function fetchMarketHolders(conditionId: string): Promise<Array<{
  token: string
  holders: HolderData[]
}> | null> {
  try {
    const url = new URL('/holders', POLYMARKET_DATA_API)
    url.searchParams.set('market', conditionId)
    url.searchParams.set('limit', '100') // Increased to ensure we get enough holders on both sides
    url.searchParams.set('minBalance', '1')

    const response = await fetch(url)
    if (!response.ok) {
      console.warn('[sharp-money] Holders request failed:', response.status, conditionId)
      return null
    }

    return (await response.json()) as Array<{ token: string; holders: HolderData[] }>
  } catch (error) {
    console.error('[sharp-money] Error fetching holders:', conditionId, error)
    return null
  }
}

/**
 * Fetch multi-period PnL for a wallet
 */
async function fetchWalletPnl(walletAddress: string): Promise<MultiPeriodPnl> {
  const periods = ['DAY', 'WEEK', 'MONTH', 'ALL'] as const
  const pnl: MultiPeriodPnl = { day: null, week: null, month: null, all: null }

  await Promise.all(
    periods.map(async (period) => {
      try {
        const url = new URL('/v1/leaderboard', POLYMARKET_DATA_API)
        url.searchParams.set('user', walletAddress)
        url.searchParams.set('timePeriod', period)

        const response = await fetch(url)
        if (!response.ok) return

        const data = (await response.json()) as Array<{ pnl?: number; vol?: number }>
        if (!Array.isArray(data) || data.length === 0) return

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
      } catch {
        // Ignore errors for individual periods
      }
    }),
  )

  return pnl
}

/**
 * Analyze a single market
 */
async function analyzeMarket(market: GammaMarket): Promise<UpsertSharpMoneyCacheInput | null> {
  const conditionId = market.conditionId

  // Fetch holders
  let holdersData = await fetchMarketHolders(conditionId)
  if (!holdersData || holdersData.length === 0) {
    return null
  }

  // Sort holders within each token group by amount (descending) and take top 20 per token
  for (const tokenData of holdersData) {
    tokenData.holders.sort((a, b) => b.amount - a.amount)
    tokenData.holders = tokenData.holders.slice(0, 20) // Take top 20 per token
  }
  
  // If any token has fewer than 10 holders, try to fetch more for that specific token
  for (const tokenData of holdersData) {
    if (tokenData.holders.length < 10 && tokenData.token) {
      try {
        const tokenUrl = new URL('/holders', POLYMARKET_DATA_API)
        tokenUrl.searchParams.set('token', tokenData.token)
        tokenUrl.searchParams.set('limit', '20')
        tokenUrl.searchParams.set('minBalance', '1')
        
        const tokenResponse = await fetch(tokenUrl)
        if (tokenResponse.ok) {
          const tokenResponseData = await tokenResponse.json() as { holders?: HolderData[] }
          if (tokenResponseData.holders && tokenResponseData.holders.length > tokenData.holders.length) {
            // Merge and sort, keeping top 20
            const allHolders = [...tokenData.holders, ...tokenResponseData.holders]
            allHolders.sort((a, b) => b.amount - a.amount)
            tokenData.holders = allHolders.slice(0, 20)
            console.log(`[sharp-money] Fetched additional holders for token ${tokenData.token}: ${tokenData.holders.length} total`)
          }
        }
      } catch (error) {
        console.warn(`[sharp-money] Failed to fetch additional holders for token ${tokenData.token}:`, error)
      }
    }
  }

  // Group holders by side
  const sideAHolders: HolderData[] = []
  const sideBHolders: HolderData[] = []

  holdersData.forEach((tokenData, tokenIndex) => {
    for (const holder of tokenData.holders) {
      if (tokenIndex === 0) {
        sideAHolders.push(holder)
      } else {
        sideBHolders.push(holder)
      }
    }
  })

  // Get unique wallets for top holders
  const topWallets = [
    ...sideAHolders.slice(0, 10).map((h) => h.proxyWallet),
    ...sideBHolders.slice(0, 10).map((h) => h.proxyWallet),
  ]
  const uniqueWallets = [...new Set(topWallets)]

  // Fetch PnL for top holders in batches
  const pnlResults: Record<string, MultiPeriodPnl> = {}
  const batchSize = 5

  for (let i = 0; i < uniqueWallets.length; i += batchSize) {
    const batch = uniqueWallets.slice(i, i + batchSize)

    await Promise.all(
      batch.map(async (wallet) => {
        pnlResults[wallet] = await fetchWalletPnl(wallet)
      }),
    )

    if (i + batchSize < uniqueWallets.length) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_PNL_BATCHES_MS))
    }
  }

  const unitSizeResults: Record<string, number | null> = {}
  const unitBatchSize = 5

  for (let i = 0; i < uniqueWallets.length; i += unitBatchSize) {
    const batch = uniqueWallets.slice(i, i + unitBatchSize)

    await Promise.all(
      batch.map(async (wallet) => {
        unitSizeResults[wallet] = await fetchWalletUnitSize(wallet)
      }),
    )

    if (i + unitBatchSize < uniqueWallets.length) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_PNL_BATCHES_MS))
    }
  }

  // Process holders with PnL data
  const processHolders = (holders: HolderData[]): TopHolderPnlData[] => {
    return holders.slice(0, 10).map((holder) => {
      const pnl = pnlResults[holder.proxyWallet] ?? {
        day: null,
        week: null,
        month: null,
        all: null,
      }

      const unitSize = unitSizeResults[holder.proxyWallet] ?? null
      const pnlAllUnits = normalizePnl(pnl.all, unitSize)
      const stakeUnits = normalizePnl(holder.amount, unitSize)
      const stakeUnitWeight = calculateStakeUnitWeight(stakeUnits)

      return {
        proxyWallet: holder.proxyWallet,
        name: holder.name,
        pseudonym: holder.pseudonym,
        profileImage: holder.profileImageOptimized || holder.profileImage,
        amount: holder.amount,
        pnlDay: pnl.day,
        pnlWeek: pnl.week,
        pnlMonth: pnl.month,
        pnlAll: pnl.all,
        pnlAllUnits,
        unitSize,
        stakeUnits,
        stakeUnitWeight,
        volume: pnl.volume,
        momentumWeight: calculateMomentumWeight(pnl),
        pnlTierWeight: calculatePnlTierWeight(pnl.all, pnlAllUnits),
      }
    })
  }

  const sideATopHolders = processHolders(sideAHolders)
  const sideBTopHolders = processHolders(sideBHolders)

  // Calculate totals and scores
  const sideATotalValue = sideAHolders.reduce((sum, h) => sum + h.amount, 0)
  const sideBTotalValue = sideBHolders.reduce((sum, h) => sum + h.amount, 0)

  const sideASharpScore = calculateSharpScore(sideATopHolders, sideATotalValue)
  const sideBSharpScore = calculateSharpScore(sideBTopHolders, sideBTotalValue)

  const scoreDifferential = Math.abs(sideASharpScore - sideBSharpScore)

  // Determine labels
  const teamNames = extractTeamNames(market.question)
  const outcomes = market.outcomes?.split(',').map((o) => o.trim()) ?? ['Yes', 'No']
  const sideALabel = teamNames ? teamNames[1] : (outcomes[0] ?? 'Yes')
  const sideBLabel = teamNames ? teamNames[0] : (outcomes[1] ?? 'No')

  // Determine sharp side
  let sharpSide: 'A' | 'B' | 'EVEN' = 'EVEN'
  if (sideASharpScore > sideBSharpScore + 5) {
    sharpSide = 'A'
  } else if (sideBSharpScore > sideASharpScore + 5) {
    sharpSide = 'B'
  }

  const confidence = determineConfidence(
    scoreDifferential,
    sideAHolders.length,
    sideBHolders.length,
  )

  return {
    conditionId,
    marketTitle: market.question,
    marketSlug: market.slug,
    eventSlug: market.eventSlug,
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
  }
}

/**
 * Main cron job function
 */
export async function runSharpMoneyCron(env: Env) {
  const db = env.POLYWHALER_DB
  const startTime = nowUnixSeconds()

  console.log('[sharp-money] Starting cron run...')

  try {
    // Prune old cache entries (older than 24 hours)
    const pruned = await pruneSharpMoneyCache(db, 24)
    if (pruned > 0) {
      console.log('[sharp-money] Pruned', pruned, 'old cache entries')
    }

    // Fetch trending sports markets
    const markets = await fetchTrendingSportsMarkets(MAX_MARKETS_PER_RUN)
    console.log('[sharp-money] Found', markets.length, 'sports markets to analyze')

    if (markets.length === 0) {
      console.log('[sharp-money] No markets to analyze')
      return
    }

    // Analyze each market sequentially with delays
    let successCount = 0
    let errorCount = 0

    for (let i = 0; i < markets.length; i++) {
      const market = markets[i]

      try {
        console.log('[sharp-money] Analyzing market', i + 1, '/', markets.length, ':', market.question)

        const analysis = await analyzeMarket(market)

        if (analysis) {
          await upsertSharpMoneyCache(db, analysis)
          successCount++
          console.log('[sharp-money] Cached analysis for:', market.question, '| Sharp side:', analysis.sharpSide, '| Confidence:', analysis.confidence)
        } else {
          console.log('[sharp-money] No analysis result for:', market.question)
        }
      } catch (error) {
        errorCount++
        console.error('[sharp-money] Error analyzing market:', market.question, error)
      }

      // Delay between markets
      if (i < markets.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_MARKETS_MS))
      }
    }

    const duration = nowUnixSeconds() - startTime
    console.log('[sharp-money] Cron complete', {
      markets: markets.length,
      success: successCount,
      errors: errorCount,
      durationSeconds: duration,
    })
  } catch (error) {
    console.error('[sharp-money] Cron failed:', error)
    throw error
  }
}
