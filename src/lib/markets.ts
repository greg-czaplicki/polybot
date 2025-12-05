export type BetType = 'moneyline' | 'spread' | 'total' | 'future' | 'prop' | 'parlay' | 'other'

export type HorizonBucket = 'intraday' | 'short' | 'medium' | 'long' | 'season' | 'unknown'

interface MarketDescriptor {
  title?: string | null
  outcome?: string | null
  eventSlug?: string | null
  slug?: string | null
}

const FUTURE_KEYWORDS = [
  'champion',
  'championship',
  'winner',
  'mvp',
  'cy young',
  'heisman',
  'super bowl',
  'world series',
  'stanley cup',
  'finals',
  'title',
]

const TOTAL_KEYWORDS = ['total', 'over', 'under', 'o/u', 'goals?', 'points?', 'runs?']
const SPREAD_KEYWORDS = ['spread', 'handicap', 'line', ' -', ' +']
const PROP_KEYWORDS = ['most', 'fewest', 'top', 'passes', 'yards', 'home runs', 'strikeouts']
const PARLAY_KEYWORDS = ['parlay']

function normalize(value?: string | null) {
  return (value ?? '').toLowerCase()
}

export function detectBetType(descriptor: MarketDescriptor): BetType {
  const title = normalize(descriptor.title)
  const outcome = normalize(descriptor.outcome)
  const slug = normalize(descriptor.slug) || normalize(descriptor.eventSlug)
  const haystack = `${title} ${outcome} ${slug}`

  if (PARLAY_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return 'parlay'
  }

  if (FUTURE_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return 'future'
  }

  if (TOTAL_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return 'total'
  }

  if (SPREAD_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return 'spread'
  }

  if (PROP_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return 'prop'
  }

  if (haystack.includes(' vs ') || haystack.includes(' at ') || haystack.includes('moneyline')) {
    return 'moneyline'
  }

  return 'other'
}

export function bucketSettlementHorizon(
  openedAt?: number | null,
  eventEndTimestamp?: number | null,
  resolvedAt?: number | null,
  betType?: BetType,
): HorizonBucket {
  if (!openedAt && !eventEndTimestamp && !resolvedAt) {
    return 'unknown'
  }

  if (betType === 'future') {
    return 'season'
  }

  const open = typeof openedAt === 'number' && openedAt > 0 ? openedAt : undefined
  const end = typeof eventEndTimestamp === 'number' && eventEndTimestamp > 0
    ? eventEndTimestamp
    : undefined
  const close = typeof resolvedAt === 'number' && resolvedAt > 0 ? resolvedAt : undefined

  if (open && (end || close)) {
    const anchor = end ?? close
    if (!anchor) {
      return 'unknown'
    }
    const horizonSeconds = anchor - open
    const horizonDays = horizonSeconds / 86_400
    if (!Number.isFinite(horizonDays) || horizonDays < 0) {
      return 'unknown'
    }
    if (horizonDays <= 1) {
      return 'intraday'
    }
    if (horizonDays <= 7) {
      return 'short'
    }
    if (horizonDays <= 30) {
      return 'medium'
    }
    return 'long'
  }

  return 'unknown'
}
