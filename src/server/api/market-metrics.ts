import { createServerFn } from '@tanstack/react-start'

const POLYMARKET_DATA_API = 'https://data-api.polymarket.com'

export interface MarketVolume {
  conditionId?: string
  totalVolume?: number
  yesVolume?: number
  noVolume?: number
  timestamp?: number
}

export interface MarketOpenInterest {
  conditionId?: string
  yesOi?: number
  noOi?: number
  totalOi?: number
  timestamp?: number
}

export interface MarketMetrics {
  volume?: MarketVolume
  openInterest?: MarketOpenInterest
}

export interface MarketHolder {
  proxyWallet: string
  pseudonym?: string
  name?: string
  bio?: string
  amount: number
  outcomeIndex: number
  asset?: string
  displayUsernamePublic?: boolean
  profileImage?: string
  profileImageOptimized?: string
}

export interface MarketHoldersResponse {
  token: string
  holders: MarketHolder[]
}

/**
 * Server-side function to fetch market volume
 */
export const fetchMarketVolumeFn = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => {
    const payload = data as { conditionId?: string }
    const conditionId = payload.conditionId

    if (!conditionId) {
      return { volume: null }
    }

    try {
      const url = new URL('/volume', POLYMARKET_DATA_API)
      url.searchParams.set('conditionId', conditionId)

      const response = await fetch(url)

      if (!response.ok) {
        if (response.status === 404) {
          return { volume: null }
        }
        console.warn(
          `Volume request failed (${response.status}) for conditionId: ${conditionId}`,
        )
        return { volume: null }
      }

      const volume = (await response.json()) as MarketVolume
      return { volume }
    } catch (error) {
      console.warn('Error fetching market volume', conditionId, error)
      return { volume: null }
    }
  },
)

/**
 * Server-side function to fetch market open interest
 */
export const fetchMarketOpenInterestFn = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => {
    const payload = data as { conditionId?: string }
    const conditionId = payload.conditionId

    if (!conditionId) {
      return { openInterest: null }
    }

    try {
      const url = new URL('/oi', POLYMARKET_DATA_API)
      url.searchParams.set('conditionId', conditionId)

      const response = await fetch(url)

      if (!response.ok) {
        if (response.status === 404) {
          return { openInterest: null }
        }
        console.warn(
          `OI request failed (${response.status}) for conditionId: ${conditionId}`,
        )
        return { openInterest: null }
      }

      const openInterest = (await response.json()) as MarketOpenInterest
      return { openInterest }
    } catch (error) {
      console.warn('Error fetching market open interest', conditionId, error)
      return { openInterest: null }
    }
  },
)

/**
 * Server-side function to fetch both volume and open interest
 */
export const fetchMarketMetricsFn = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => {
    const payload = data as { conditionId?: string; eventId?: string; slug?: string }
    const conditionId = payload.conditionId
    const eventId = payload.eventId
    const slug = payload.slug

    if (!conditionId) {
      return { metrics: {} as MarketMetrics }
    }

    try {
      // According to Polymarket docs: /oi endpoint uses 'market' parameter
      // Response format: [{ "market": "0x...", "value": 123 }]
      const oiUrl = new URL('/oi', POLYMARKET_DATA_API)
      oiUrl.searchParams.set('market', conditionId) // API expects 'market' not 'conditionId'
      
      // Try /live-volume endpoint if we have eventId (preferred method)
      // Response format: [{ "total": 123, "markets": [{ "market": "0x...", "value": 123 }] }]
      let volumeUrl: URL | null = null
      if (eventId) {
        // Try to parse eventId as integer (API requires integer)
        const eventIdNum = parseInt(eventId, 10)
        if (!isNaN(eventIdNum)) {
          volumeUrl = new URL('/live-volume', POLYMARKET_DATA_API)
          volumeUrl.searchParams.set('id', eventIdNum.toString())
        }
      }
      
      // Fallback: try /volume endpoint with market parameter
      if (!volumeUrl) {
        volumeUrl = new URL('/volume', POLYMARKET_DATA_API)
        volumeUrl.searchParams.set('market', conditionId)
        volumeUrl.searchParams.set('conditionId', conditionId)
      }
      
      const [volumeResponse, oiResponse] = await Promise.all([
        fetch(volumeUrl).catch(() => null),
        fetch(oiUrl).catch(() => null),
      ])

      let volume: MarketVolume | null = null
      let openInterest: MarketOpenInterest | null = null

      if (volumeResponse?.ok) {
        try {
          const volData = await volumeResponse.json()
          
          // Handle /live-volume response format: [{ "total": 123, "markets": [{ "market": "0x...", "value": 123 }] }]
          // Note: eventData.total is for ALL markets in the event, marketMatch.value is for THIS specific market
          if (Array.isArray(volData) && volData.length > 0) {
            // If it's the live-volume format with markets array
            const eventData = volData[0]
            if (eventData?.markets && Array.isArray(eventData.markets)) {
              const marketMatch = eventData.markets.find((m: any) => 
                m.market === conditionId || m.conditionId === conditionId
              )
              if (marketMatch) {
                // Use marketMatch.value (specific market volume), not eventData.total (all markets combined)
                volume = {
                  conditionId: marketMatch.market || conditionId,
                  totalVolume: marketMatch.value, // This is the volume for THIS specific market
                  yesVolume: marketMatch.yesVolume ?? marketMatch.yes,
                  noVolume: marketMatch.noVolume ?? marketMatch.no,
                }
              }
            } else {
              // Direct array format: [{ "market": "0x...", "value": 123 }]
              const match = volData.find((item: any) => 
                item.market === conditionId || item.conditionId === conditionId
              )
              if (match) {
                volume = {
                  conditionId: match.market || match.conditionId || conditionId,
                  totalVolume: match.totalVolume ?? match.value,
                  yesVolume: match.yesVolume ?? match.yes,
                  noVolume: match.noVolume ?? match.no,
                }
              }
            }
          } else if (typeof volData === 'object' && volData !== null) {
            volume = volData as MarketVolume
          }
        } catch (error) {
          console.warn('Volume JSON parse error:', error)
        }
      }

      if (oiResponse?.ok) {
        try {
          const oiData = await oiResponse.json()
          
          // According to docs: /oi returns array of { market: string, value: number }
          if (Array.isArray(oiData)) {
            const match = oiData.find((item: any) => 
              item.market === conditionId || item.conditionId === conditionId
            )
            if (match) {
              // API returns single 'value' - this is total OI
              openInterest = {
                conditionId: match.market || conditionId,
                totalOi: match.value,
                // Note: API doesn't provide YES/NO breakdown in /oi endpoint
                yesOi: undefined,
                noOi: undefined,
              }
            }
          } else if (typeof oiData === 'object' && oiData !== null) {
            // Fallback for object format
            openInterest = oiData as MarketOpenInterest
          }
        } catch (error) {
          console.warn('OI JSON parse error:', error)
        }
      }

      // Try to get side-specific volume from /trades endpoint
      if (!volume || !volume.yesVolume || !volume.noVolume) {
        try {
          const tradesUrl = new URL('/trades', POLYMARKET_DATA_API)
          tradesUrl.searchParams.set('market', conditionId)
          
          const tradesResponse = await fetch(tradesUrl)
          if (tradesResponse?.ok) {
            const tradesData = (await tradesResponse.json()) as Array<{
              outcome?: string
              size?: number
              price?: number
            }>
            
            if (Array.isArray(tradesData) && tradesData.length > 0) {
              let yesVolume = 0
              let noVolume = 0
              
              // Aggregate volume by outcome
              for (const trade of tradesData) {
                const tradeValue = (trade.size ?? 0) * (trade.price ?? 0)
                const outcome = (trade.outcome ?? '').toLowerCase()
                
                if (outcome === 'yes' || outcome === '1') {
                  yesVolume += tradeValue
                } else if (outcome === 'no' || outcome === '0') {
                  noVolume += tradeValue
                }
              }
              
              if (yesVolume > 0 || noVolume > 0) {
                // Update or create volume object
                if (volume) {
                  volume.yesVolume = yesVolume
                  volume.noVolume = noVolume
                  volume.totalVolume = (volume.totalVolume ?? 0) || (yesVolume + noVolume)
                } else {
                  volume = {
                    conditionId: conditionId,
                    totalVolume: yesVolume + noVolume,
                    yesVolume: yesVolume,
                    noVolume: noVolume,
                  }
                }
              }
            }
          }
        } catch (error) {
          console.warn('Failed to fetch trades for volume:', error)
        }
      }

      // Fallback: Try Gamma API if we have a slug and didn't get volume
      if (!volume && slug) {
        try {
          const gammaUrl = new URL('/markets', 'https://gamma-api.polymarket.com')
          gammaUrl.searchParams.set('slug', slug)
          gammaUrl.searchParams.set('active', 'true')
          gammaUrl.searchParams.set('limit', '1')
          
          const gammaResponse = await fetch(gammaUrl)
          if (gammaResponse?.ok) {
            const gammaData = (await gammaResponse.json()) as Array<{
              volume?: number
              liquidity?: number
              volume24h?: number
            }>
            
            if (Array.isArray(gammaData) && gammaData.length > 0) {
              const marketData = gammaData[0]
              if (marketData.volume || marketData.volume24h) {
                volume = {
                  conditionId: conditionId,
                  totalVolume: marketData.volume ?? marketData.volume24h,
                  // Gamma API doesn't provide YES/NO breakdown
                  yesVolume: undefined,
                  noVolume: undefined,
                }
              }
            }
          }
        } catch (error) {
          console.warn('Gamma API fallback failed:', error)
        }
      }

      const metrics: MarketMetrics = {
        volume: volume ?? undefined,
        openInterest: openInterest ?? undefined,
      }

      return { metrics }
    } catch (error) {
      console.warn('Error fetching market metrics', conditionId, error)
      return { metrics: {} as MarketMetrics }
    }
  },
)

/**
 * Server-side function to fetch top holders for a market
 * Uses the /holders endpoint from Polymarket Data API
 */
export const fetchMarketHoldersFn = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => {
    const payload = data as { conditionId?: string; limit?: number; minBalance?: number }
    const conditionId = payload.conditionId
    const limit = payload.limit ?? 20 // Max allowed by API
    const minBalance = payload.minBalance ?? 1

    if (!conditionId) {
      return { holders: null }
    }

    try {
      const url = new URL('/holders', POLYMARKET_DATA_API)
      url.searchParams.set('market', conditionId)
      url.searchParams.set('limit', limit.toString())
      url.searchParams.set('minBalance', minBalance.toString())

      const response = await fetch(url)

      if (!response.ok) {
        if (response.status === 404) {
          return { holders: null }
        }
        console.warn(
          `Holders request failed (${response.status}) for conditionId: ${conditionId}`,
        )
        return { holders: null }
      }

      const holdersData = (await response.json()) as MarketHoldersResponse[]
      return { holders: holdersData }
    } catch (error) {
      console.warn('Error fetching market holders', conditionId, error)
      return { holders: null }
    }
  },
)

/**
 * User PnL stats from leaderboard API
 */
export interface UserPnlStats {
  pnl: number | null
  volume?: number
  error?: string
}

/**
 * Server-side function to fetch PnL for a user
 * Uses the /v1/leaderboard endpoint which has accurate PnL data
 */
export const fetchUserPnlFn = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => {
    const payload = data as { walletAddress: string }
    const walletAddress = payload.walletAddress

    if (!walletAddress) {
      return { pnl: null, error: 'No wallet address provided' } as UserPnlStats
    }

    try {
      // Use leaderboard endpoint which has accurate PnL
      const url = new URL('/v1/leaderboard', POLYMARKET_DATA_API)
      url.searchParams.set('user', walletAddress)
      url.searchParams.set('timePeriod', 'ALL')

      const response = await fetch(url)

      if (!response.ok) {
        if (response.status === 404) {
          return { pnl: null } as UserPnlStats
        }
        return { pnl: null, error: `Request failed: ${response.status}` } as UserPnlStats
      }

      const leaderboardData = await response.json() as Array<{
        pnl?: number
        vol?: number
        proxyWallet?: string
      }>

      if (!Array.isArray(leaderboardData) || leaderboardData.length === 0) {
        return { pnl: null } as UserPnlStats
      }

      const userData = leaderboardData[0]
      return {
        pnl: userData.pnl ?? null,
        volume: userData.vol,
      } as UserPnlStats
    } catch (error) {
      console.warn('Error fetching user PnL', walletAddress, error)
      return { pnl: null, error: 'Failed to fetch' } as UserPnlStats
    }
  },
)

/**
 * Batch fetch PnL for multiple users using leaderboard API
 */
export const fetchBatchUserPnlFn = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => {
    const payload = data as { walletAddresses: string[] }
    const walletAddresses = payload.walletAddresses

    if (!walletAddresses || walletAddresses.length === 0) {
      return { results: {} as Record<string, UserPnlStats> }
    }

    const results: Record<string, UserPnlStats> = {}

    // Fetch in parallel using leaderboard endpoint
    const fetchPromises = walletAddresses.map(async (walletAddress) => {
      try {
        const url = new URL('/v1/leaderboard', POLYMARKET_DATA_API)
        url.searchParams.set('user', walletAddress)
        url.searchParams.set('timePeriod', 'ALL')

        const response = await fetch(url)

        if (!response.ok) {
          results[walletAddress] = { pnl: null }
          return
        }

        const leaderboardData = await response.json() as Array<{
          pnl?: number
          vol?: number
        }>

        if (!Array.isArray(leaderboardData) || leaderboardData.length === 0) {
          results[walletAddress] = { pnl: null }
          return
        }

        const userData = leaderboardData[0]
        results[walletAddress] = {
          pnl: userData.pnl ?? null,
          volume: userData.vol,
        }
      } catch (error) {
        results[walletAddress] = { pnl: null }
      }
    })

    await Promise.all(fetchPromises)

    return { results }
  },
)

