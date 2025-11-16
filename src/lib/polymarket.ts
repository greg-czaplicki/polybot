const POLYMARKET_DATA_API = 'https://data-api.polymarket.com'

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
