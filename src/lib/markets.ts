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

// Word-boundary matching: bare substrings misclassified real titles —
// 'under' matched "Thunder", 'line' matched "moneyline", and ' vs ' missed
// the "vs." (dot) form every moneyline title actually uses.
const TOTAL_RE = /\b(?:total|over|under|o\/u)\b/
const SPREAD_RE = /\b(?:spread|handicap|line)\b|[\s(][+-]\d/
const MONEYLINE_RE = /\bvs\b|\bat\b|moneyline/
const PROP_KEYWORDS = ['most', 'fewest', 'top', 'passes', 'yards', 'home runs', 'strikeouts', 'both teams to score']
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

  if (TOTAL_RE.test(haystack)) {
    return 'total'
  }

  if (SPREAD_RE.test(haystack)) {
    return 'spread'
  }

  if (PROP_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return 'prop'
  }

  if (MONEYLINE_RE.test(haystack)) {
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
