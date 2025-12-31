import type { Env } from '../env'
import { nowUnixSeconds } from '../env'
import { detectSportTag } from '@/lib/sports'
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
function calculatePnlTierWeight(pnlAll: number | null): number {
  if (pnlAll === null) return 1.0
  if (pnlAll >= 100_000) return 2.0
  if (pnlAll >= 10_000) return 1.5
  if (pnlAll >= 0) return 1.0
  if (pnlAll >= -10_000) return 0.8
  return 0.7
}

/**
 * Calculate sharp score for a side
 */
function calculateSharpScore(holders: TopHolderPnlData[], totalValue: number): number {
  if (holders.length === 0 || totalValue <= 0) return 50

  let weightedSum = 0
  for (const holder of holders) {
    const positionWeight = holder.amount / totalValue
    const combinedWeight = holder.momentumWeight * holder.pnlTierWeight
    weightedSum += positionWeight * combinedWeight
  }

  const normalized = ((weightedSum - 0.35) / (3.0 - 0.35)) * 100
  return Math.max(0, Math.min(100, normalized))
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

  // Process holders with PnL data
  const processHolders = (holders: HolderData[]): TopHolderPnlData[] => {
    return holders.slice(0, 10).map((holder) => {
      const pnl = pnlResults[holder.proxyWallet] ?? {
        day: null,
        week: null,
        month: null,
        all: null,
      }

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
        volume: pnl.volume,
        momentumWeight: calculateMomentumWeight(pnl),
        pnlTierWeight: calculatePnlTierWeight(pnl.all),
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

  const sportTag = detectSportTag({
    title: market.question,
    slug: market.slug,
    eventSlug: market.eventSlug,
  })

  return {
    conditionId,
    marketTitle: market.question,
    marketSlug: market.slug,
    eventSlug: market.eventSlug,
    sportTag: sportTag ?? undefined,
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
