const POLYMARKET_DATA_API = 'https://data-api.polymarket.com'
const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com'

export type TradeSide = 'BUY' | 'SELL'

export interface PolymarketTrade {
  proxyWallet: string
  side: TradeSide
  asset: string
  conditionId: string
  size: number
  price: number
  timestamp: number
  title: string
  slug: string
  icon?: string
  eventSlug?: string
  outcome?: string
  outcomeIndex?: number
  name?: string
  pseudonym?: string
  bio?: string
  profileImage?: string
  profileImageOptimized?: string
  transactionHash?: string
}

export interface PolymarketPosition {
  proxyWallet: string
  asset: string
  conditionId: string
  size: number
  avgPrice: number
  initialValue: number
  currentValue: number
  cashPnl: number
  percentPnl: number
  totalBought: number
  realizedPnl: number
  percentRealizedPnl: number
  curPrice: number
  redeemable: boolean
  mergeable: boolean
  title: string
  slug: string
  icon?: string
  eventId?: string
  eventSlug?: string
  outcome?: string
  outcomeIndex?: number
  oppositeOutcome?: string
  oppositeAsset?: string
  endDate?: string
  negativeRisk?: boolean
}

export async function fetchTradesForUser(
  user: string,
  signal?: AbortSignal,
): Promise<PolymarketTrade[]> {
  if (!user) {
    throw new Error('A wallet address is required.')
  }

  const url = new URL('/trades', POLYMARKET_DATA_API)
  url.searchParams.set('user', user)

  const response = await fetch(url, { signal })

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText)
    throw new Error(
      `Polymarket request failed (${response.status}): ${message}`.trim(),
    )
  }

  return (await response.json()) as PolymarketTrade[]
}

export async function fetchPositionsForUser(
  user: string,
  signal?: AbortSignal,
): Promise<PolymarketPosition[]> {
  if (!user) {
    throw new Error('A wallet address is required.')
  }

  const url = new URL('/positions', POLYMARKET_DATA_API)
  url.searchParams.set('user', user)

  const response = await fetch(url, { signal })

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText)
    throw new Error(
      `Polymarket positions request failed (${response.status}): ${message}`.trim(),
    )
  }

  return (await response.json()) as PolymarketPosition[]
}

/**
 * Fetches market data from Gamma API which includes volume and liquidity
 * Useful as a fallback when conditionId is not available
 */
export async function fetchMarketFromGamma(
  slug: string,
  signal?: AbortSignal,
): Promise<{ volume?: number; liquidity?: number } | null> {
  if (!slug) {
    return null
  }

  try {
    const url = new URL('/markets', POLYMARKET_GAMMA_API)
    url.searchParams.set('slug', slug)
    url.searchParams.set('active', 'true')
    url.searchParams.set('limit', '1')

    const response = await fetch(url, { signal })

    if (!response.ok) {
      if (response.status === 404) {
        return null
      }
      console.warn(`Gamma market request failed (${response.status}) for slug: ${slug}`)
      return null
    }

    const data = (await response.json()) as Array<{
      volume?: number
      liquidity?: number
    }>

    if (!Array.isArray(data) || data.length === 0) {
      return null
    }

    return data[0] ?? null
  } catch (error) {
    if (signal?.aborted) {
      return null
    }
    console.warn('Error fetching market from Gamma', slug, error)
    return null
  }
}
