import { createFileRoute } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import {
  AlertTriangle,
  BellRing,
  ChevronDown,
  Clock,
  Eye,
  EyeOff,
  ExternalLink,
  Flame,
  Skull,
  Loader2,
  Plus,
  Scale,
  RefreshCw,
  Settings,
  Sparkles,
  Target,
  TrendingUp,
  Trash2,
  Trophy,
  User,
  Users,
  Wallet,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useId } from 'react'

// Type declaration for Pusher Beams
declare global {
  interface Window {
    PusherPushNotifications?: {
      Client: new (config: { instanceId: string }) => {
        start: () => Promise<void>
        addDeviceInterest: (interest: string) => Promise<void>
        getDeviceInterests: () => Promise<string[] | { interests: string[] }>
      }
    }
  }
}

import type { AlertEventRecord, WatcherRule } from '@/lib/alerts/types'
import { detectSportTag, getSportLabel, isEsportsMarket, isSportsMarket } from '@/lib/sports'
import {
  fetchPositionsForUser,
  fetchTradesForUser,
  type PolymarketPosition,
  type PolymarketTrade,
  type MarketMetrics,
} from '../lib/polymarket'
import {
  fetchMarketMetricsFn,
  fetchMarketHoldersFn,
  fetchBatchUserPnlFn,
  type MarketHolder,
  type MarketHoldersResponse,
  type UserPnlStats,
} from '../server/api/market-metrics'
import {
  deleteWatcherFn,
  ensureUserFn,
  listAlertHistoryFn,
  listWatchersFn,
  runAlertScanFn,
  testPushNotificationFn,
  upsertWatcherFn,
} from '../server/api/watchers'
import {
  getWalletSizingFn,
  getWalletStatsFn,
  listWalletResultsFn,
} from '../server/api/wallet-stats'
import { getWalletDiagnosticsFn } from '../server/api/diagnostics'

const GLOBAL_POSITIONS_REFRESH_MS = 5 * 60 * 1000
const INITIAL_TRADE_BATCH_SIZE = 20
const TRADE_BATCH_INCREMENT = 20
const ALERT_CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

interface WalletStatsBucket {
  wins: number
  losses: number
  ties: number
  pnlUsd: number
}

interface WalletSportRecord extends WalletStatsBucket {
  sport: string
}

interface WalletSportEdge extends WalletSportRecord {
  label: string
  sampleSize: number
  winRate: number
}

type WalletSportEdgeMap = Map<string, Map<string, WalletSportEdge>>

interface WalletStatsSummary {
  allTime: WalletStatsBucket
  daily: WalletStatsBucket
  weekly: WalletStatsBucket
  monthly: WalletStatsBucket
  bySport: WalletSportRecord[]
  byEdge: WalletEdgePocket[]
}

interface WalletEdgePocket extends WalletStatsBucket {
  sport?: string
  betType?: string
  horizon?: string
  sampleSize: number
}

type WalletStatsBucketKey = 'daily' | 'weekly' | 'monthly'

interface WalletResultSummary {
  asset: string
  title?: string
  eventSlug?: string
  resolvedAt: number
  pnlUsd: number
  result: 'win' | 'loss' | 'tie'
  isSports: boolean
  sportTag?: string
}

interface AggregatedWalletPosition {
  walletAddress: string
  label: string
  value: number
  initialValue: number
  pnl: number
  redeemable: boolean
  highlight?: WalletHighlight
  endDate?: string
  confidence?: WalletPositionConfidence
  averageSize?: number
}

interface AggregatedOutcomeEntry {
  outcome: string
  totalValue: number
  wallets: AggregatedWalletPosition[]
}

interface AggregatedMarketEntry {
  id: string
  title: string
  totalValue: number
  icon?: string
  outcomes: AggregatedOutcomeEntry[]
  eventSlug?: string
  slug?: string
  sportTag?: string | null
  conditionId?: string
  eventId?: string
  metrics?: MarketMetrics
}

interface OppositionBalanceSnapshot {
  primaryLabel: string
  secondaryLabel: string
  primaryAmount: number
  secondaryAmount: number
  primaryShare: number
  secondaryShare: number
  totalAmount: number
  callout: 'money' | 'units' | 'conviction' | 'mixed'
  primaryUnitShare: number
  secondaryUnitShare: number
  primaryConfidence: number
  secondaryConfidence: number
  primaryMaxClipCount: number
  secondaryMaxClipCount: number
}

interface WalletDiagnosticsSummary {
  closed: {
    wins: number
    losses: number
    ties: number
    pnlUsd: number
    sampleCount: number
    since: number
    results: WalletResultSummary[]
  }
  open: {
    pnlUsd: number
    positionCount: number
  }
  trades: {
    since: number
    buyVolume: number
    sellVolume: number
  }
}

interface WalletSizingSnapshot {
  averageSize: number
  positionCount: number
  updatedAt: number
}

interface TrackedWalletRow {
  walletAddress: string
  nickname?: string | null
  watcherId: string
}

interface AddWalletFormState {
  walletAddress: string
  nickname: string
}

const DEFAULT_ADD_WALLET_FORM: AddWalletFormState = {
  walletAddress: '',
  nickname: '',
}

const EMPTY_WALLET_STATS: WalletStatsSummary = {
  allTime: { wins: 0, losses: 0, ties: 0, pnlUsd: 0 },
  daily: { wins: 0, losses: 0, ties: 0, pnlUsd: 0 },
  weekly: { wins: 0, losses: 0, ties: 0, pnlUsd: 0 },
  monthly: { wins: 0, losses: 0, ties: 0, pnlUsd: 0 },
  bySport: [],
  byEdge: [],
}

const WEEKLY_HOT_PNL_THRESHOLD = 500_000
const WEEKLY_HOT_WIN_DELTA = 5
const DAILY_HOT_PNL_THRESHOLD = 100_000
const WEEKLY_TILT_PNL_THRESHOLD = -250_000
const WEEKLY_TILT_LOSS_DELTA = 3
const DAILY_TILT_PNL_THRESHOLD = -100_000
const SHOW_TILT_BADGE = false
const MS_PER_DAY = 86_400_000

const SPORT_EDGE_MIN_DECISIONS = 6
const SPORT_EDGE_MIN_WIN_RATE = 0.6
const SPORT_EDGE_MIN_PNL = 50_000

type WalletHighlightKind = 'top' | 'weekly' | 'daily' | 'tilt'

interface WalletHighlight {
  kind: WalletHighlightKind
  label: string
  detail: string
  badgeClass: string
  Icon: LucideIcon
}

type ConfidenceLevel = 'low' | 'medium' | 'high'

interface WalletPositionConfidence {
  score: number
  level: ConfidenceLevel
  reasons: string[]
}

const HIGHLIGHT_META: Record<
  WalletHighlightKind,
  { label: string; badgeClass: string; Icon: LucideIcon }
> = {
  top: {
    label: 'Top performer',
    badgeClass: 'border-amber-400/60 bg-amber-500/10 text-amber-50',
    Icon: Trophy,
  },
  weekly: {
    label: 'Hot streak',
    badgeClass: 'border-rose-400/60 bg-rose-500/15 text-rose-100',
    Icon: Flame,
  },
  daily: {
    label: 'Heater today',
    badgeClass: 'border-cyan-400/60 bg-cyan-500/10 text-cyan-100',
    Icon: Sparkles,
  },
  tilt: {
    label: 'On tilt',
    badgeClass: 'border-fuchsia-500/70 bg-fuchsia-600/15 text-fuchsia-100',
    Icon: Skull,
  },
}

function pickWalletHighlight(
  stats: WalletStatsSummary,
  options?: { isTopPerformer?: boolean },
): WalletHighlight | null {
  const weeklyLossEdge = stats.weekly.losses - stats.weekly.wins
  if (
    SHOW_TILT_BADGE &&
    stats.weekly.pnlUsd <= WEEKLY_TILT_PNL_THRESHOLD &&
    weeklyLossEdge >= WEEKLY_TILT_LOSS_DELTA
  ) {
    const meta = HIGHLIGHT_META.tilt
    return {
      kind: 'tilt',
      label: meta.label,
      detail: `-${formatUsdCompact(Math.abs(stats.weekly.pnlUsd))} last 7d`,
      badgeClass: meta.badgeClass,
      Icon: meta.Icon,
    }
  }

  if (
    SHOW_TILT_BADGE &&
    stats.daily.pnlUsd <= DAILY_TILT_PNL_THRESHOLD &&
    stats.daily.losses >= Math.max(1, stats.daily.wins)
  ) {
    const meta = HIGHLIGHT_META.tilt
    return {
      kind: 'tilt',
      label: meta.label,
      detail: `-${formatUsdCompact(Math.abs(stats.daily.pnlUsd))} today`,
      badgeClass: meta.badgeClass,
      Icon: meta.Icon,
    }
  }

  if (options?.isTopPerformer && stats.allTime.pnlUsd > 0) {
    const meta = HIGHLIGHT_META.top
    return {
      kind: 'top',
      label: meta.label,
      detail: `+${formatUsdCompact(Math.abs(stats.allTime.pnlUsd))} all-time`,
      badgeClass: meta.badgeClass,
      Icon: meta.Icon,
    }
  }

  if (
    stats.weekly.pnlUsd >= WEEKLY_HOT_PNL_THRESHOLD &&
    weeklyLossEdge <= -WEEKLY_HOT_WIN_DELTA
  ) {
    const meta = HIGHLIGHT_META.weekly
    return {
      kind: 'weekly',
      label: meta.label,
      detail: `+${formatUsdCompact(Math.abs(stats.weekly.pnlUsd))} last 7d`,
      badgeClass: meta.badgeClass,
      Icon: meta.Icon,
    }
  }

  if (stats.daily.pnlUsd >= DAILY_HOT_PNL_THRESHOLD && stats.daily.wins >= 1) {
    const meta = HIGHLIGHT_META.daily
    return {
      kind: 'daily',
      label: meta.label,
      detail: `+${formatUsdCompact(Math.abs(stats.daily.pnlUsd))} today`,
      badgeClass: meta.badgeClass,
      Icon: meta.Icon,
    }
  }

  return null
}

function evaluateSportEdge(record: WalletSportRecord): WalletSportEdge | null {
  const decisions = record.wins + record.losses
  if (decisions < SPORT_EDGE_MIN_DECISIONS) {
    return null
  }

  if (record.pnlUsd <= 0) {
    return null
  }

  const winRate = decisions > 0 ? record.wins / decisions : 0
  const strongWinRate = winRate >= SPORT_EDGE_MIN_WIN_RATE
  const strongPnl = record.pnlUsd >= SPORT_EDGE_MIN_PNL

  if (!strongWinRate && !strongPnl) {
    return null
  }

  return {
    ...record,
    label: getSportLabel(record.sport) ?? record.sport.toUpperCase(),
    sampleSize: decisions,
    winRate,
  }
}

function buildWalletSportEdgeMap(
  statsByWallet: Record<string, WalletStatsSummary>,
): WalletSportEdgeMap {
  const walletMap: WalletSportEdgeMap = new Map()
  Object.entries(statsByWallet).forEach(([walletKey, summary]) => {
    const sportEntries = summary?.bySport ?? []
    const edges = new Map<string, WalletSportEdge>()
    sportEntries.forEach((record) => {
      const edge = evaluateSportEdge(record)
      if (edge) {
        edges.set(record.sport, edge)
      }
    })
    if (edges.size > 0) {
      walletMap.set(walletKey, edges)
    }
  })
  return walletMap
}

const CONFIDENCE_META: Record<
  ConfidenceLevel,
  { label: string; barClass: string; textClass: string }
> = {
  high: {
    label: 'High confidence',
    barClass: 'from-emerald-400 via-emerald-500 to-emerald-600',
    textClass: 'text-emerald-200',
  },
  medium: {
    label: 'Steady confidence',
    barClass: 'from-cyan-400 via-blue-500 to-blue-600',
    textClass: 'text-cyan-200',
  },
  low: {
    label: 'Low confidence',
    barClass: 'from-amber-400 via-amber-500 to-amber-600',
    textClass: 'text-amber-200',
  },
}

function computePositionConfidence({
  sportTag,
  sportEdge,
  highlight,
  initialValue,
  averageSize,
  endDate,
}: {
  sportTag?: string | null
  sportEdge?: WalletSportEdge
  highlight?: WalletHighlight
  initialValue: number
  averageSize?: number
  endDate?: string | null
}): WalletPositionConfidence | undefined {
  if (!Number.isFinite(initialValue) || initialValue <= 0) {
    return undefined
  }

  const reasons: string[] = []
  let score = 0.45

  if (sportTag && sportEdge) {
    score += 0.3
    reasons.push(`Proven edge in ${sportEdge.label}`)
  } else if (sportTag) {
    score -= 0.05
    reasons.push(`Limited data in ${getSportLabel(sportTag) ?? sportTag.toUpperCase()}`)
  }

  if (highlight?.kind === 'top' || highlight?.kind === 'weekly') {
    score += 0.05
    reasons.push('Recent performance momentum')
  } else if (highlight?.kind === 'tilt' && SHOW_TILT_BADGE) {
    score -= 0.08
    reasons.push('In active drawdown')
  }

  if (averageSize && averageSize > 0) {
    const ratio = initialValue / averageSize
    if (ratio >= 1.5) {
      score += 0.12
      reasons.push('Sizing up vs typical exposure')
    } else if (ratio <= 0.5) {
      score -= 0.08
      reasons.push('Small probe vs usual size')
    } else {
      reasons.push('Bet size near normal range')
    }
  } else {
    reasons.push('No historical sizing data')
  }

  if (endDate) {
    const parsed = new Date(endDate)
    if (Number.isFinite(parsed.getTime())) {
      const daysOut = (parsed.getTime() - Date.now()) / MS_PER_DAY
      if (daysOut <= 14) {
        score += 0.05
        reasons.push('Near-term resolution')
      } else if (daysOut > 60) {
        score -= 0.05
        reasons.push('Long resolution horizon')
      }
    }
  }

  const clamped = Math.min(Math.max(score, 0), 1)
  const level: ConfidenceLevel =
    clamped >= 0.75 ? 'high' : clamped >= 0.5 ? 'medium' : 'low'

  return {
    score: clamped,
    level,
    reasons,
  }
}

function getTopWalletKey(
  trackedWallets: TrackedWalletRow[],
  walletStats: Record<string, WalletStatsSummary>,
) {
  let topKey: string | null = null
  let topScore = Number.NEGATIVE_INFINITY

  for (const wallet of trackedWallets) {
    const key = wallet.walletAddress.toLowerCase()
    const pnl = walletStats[key]?.allTime.pnlUsd ?? 0
    if (pnl > topScore) {
      topScore = pnl
      topKey = key
    }
  }

  return topKey
}

function parsePositiveNumber(value: string) {
  if (!value) {
    return undefined
  }
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  return undefined
}

function formatUsdCompact(value?: number | null) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '—'
  }
  return ALERT_CURRENCY_FORMATTER.format(value)
}

function formatPercent(value: number) {
  if (!Number.isFinite(value) || value === 0) {
    return '0%'
  }
  return `${Math.round(value * 100)}%`
}

const BET_TYPE_LABELS: Record<string, string> = {
  moneyline: 'Moneyline',
  spread: 'Spread',
  total: 'Totals',
  future: 'Futures',
  prop: 'Props',
  parlay: 'Parlays',
}

const HORIZON_LABELS: Record<string, string> = {
  intraday: 'Same day',
  short: 'Within week',
  medium: 'Within month',
  long: 'Multi-month',
  season: 'Season-long',
}

function getBetTypeLabel(value?: string | null) {
  if (!value) {
    return 'Any bet'
  }
  return BET_TYPE_LABELS[value] ?? value.replace(/_/g, ' ')
}

function getHorizonLabel(value?: string | null) {
  if (!value) {
    return 'Any duration'
  }
  return HORIZON_LABELS[value] ?? value.replace(/_/g, ' ')
}

function formatSizingRatio(ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return '1.0x'
  }
  if (ratio >= 10) {
    return `${Math.round(ratio)}x`
  }
  return `${ratio.toFixed(1)}x`
}

function getSizingSignal(initialValue: number, averageSize?: number) {
  if (!Number.isFinite(initialValue) || initialValue <= 0) {
    return null
  }
  if (!Number.isFinite(averageSize ?? 0) || !averageSize || averageSize <= 0) {
    return null
  }

  const ratio = initialValue / averageSize
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return null
  }

  const detail = `${formatSizingRatio(ratio)} avg`

  if (ratio >= 2.5) {
    return {
      label: 'Max clip',
      badgeClass: 'border-emerald-400/60 bg-emerald-500/10 text-emerald-100',
      detail,
      ratio,
    }
  }

  if (ratio >= 1.5) {
    return {
      label: 'Sizing up',
      badgeClass: 'border-cyan-400/60 bg-cyan-500/10 text-cyan-100',
      detail,
      ratio,
    }
  }

  if (ratio <= 0.4) {
    return {
      label: 'Tiny probe',
      badgeClass: 'border-amber-400/70 bg-amber-500/10 text-amber-100',
      detail,
      ratio,
    }
  }

  if (ratio <= 0.75) {
    return {
      label: 'Half stake',
      badgeClass: 'border-rose-400/70 bg-rose-500/10 text-rose-100',
      detail,
      ratio,
    }
  }

  return {
    label: 'Standard unit',
    badgeClass: 'border-slate-800/80 bg-slate-900/60 text-gray-200',
    detail,
    ratio,
  }
}

function formatWalletAddress(address: string) {
  if (address.length <= 10) {
    return address
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

const FAR_FUTURE_EVENT_THRESHOLD_DAYS = 150
const FAR_FUTURE_EVENT_THRESHOLD_MS =
  FAR_FUTURE_EVENT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
const STALE_POSITION_GRACE_PERIOD_DAYS = 2
const STALE_POSITION_GRACE_PERIOD_MS =
  STALE_POSITION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000

function parseDateFromWillTitle(title: string): number | null {
  const dateMatch = title.match(
    /\d{4}[-\/]\d{2}[-\/]\d{2}|\d{2}[-\/]\d{2}[-\/]\d{4}/,
  )
  if (!dateMatch) {
    return null
  }
  let normalized = dateMatch[0].replace(/\//g, '-')
  if (/^\d{2}-\d{2}-\d{4}$/.test(normalized)) {
    const [month, day, year] = normalized.split('-')
    normalized = `${year}-${month}-${day}`
  }
  const timestamp = Date.parse(normalized)
  return Number.isNaN(timestamp) ? null : timestamp
}

function isStalePosition(position?: { endDate?: string | null }): boolean {
  if (!position?.endDate) {
    return false
  }
  const endTimestamp = Date.parse(position.endDate)
  if (Number.isNaN(endTimestamp)) {
    return false
  }
  return endTimestamp + STALE_POSITION_GRACE_PERIOD_MS < Date.now()
}

function isFutureWillQuestion(title?: string | null, endDate?: string | null): boolean {
  const now = Date.now()
  const farFutureCutoff = now + FAR_FUTURE_EVENT_THRESHOLD_MS

  if (endDate) {
    const parsedEndDate = Date.parse(endDate)
    if (!Number.isNaN(parsedEndDate) && parsedEndDate > farFutureCutoff) {
      return true
    }
  }

  if (!title) {
    return false
  }
  const trimmed = title.trim()
  // Check if it starts with "Will" (case insensitive)
  if (!/^will\b/i.test(trimmed)) {
    return false
  }

  const explicitDate = parseDateFromWillTitle(trimmed)
  if (explicitDate && explicitDate > farFutureCutoff) {
    return true
  }

  // Filter out championship/season questions with years
  // These include: "Will X be the 2025 Drivers Champion?", "Will Chiefs win Super Bowl 2026?", etc.
  const hasYear = /\b(20\d{2})\b/.test(trimmed)
  const hasChampionshipKeywords = /\b(champion|championship|champions|winner|super bowl|world series|stanley cup|nba finals|drivers champion|constructors|playoffs|season|title)\b/i.test(
    trimmed,
  )

  // If it has a year and championship/winner keywords, it's a future championship bet
  if (hasYear && hasChampionshipKeywords) {
    return true
  }

  // Also filter if it's just a year far in the future (2026+) without a date
  // This catches things like "Will X win in 2026?" but allows "Will X win on 2025-12-03?"
  const hasFutureYear = /\b(202[6-9]|20[3-9]\d)\b/.test(trimmed)
  if (hasFutureYear) {
    return true
  }

  return false
}


export const Route = createFileRoute('/')({ component: App })

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null)
  const [trackingForm, setTrackingForm] = useState<AddWalletFormState>(
    DEFAULT_ADD_WALLET_FORM,
  )

  // Check authentication on mount
  useEffect(() => {
    const authStatus = sessionStorage.getItem('polywhaler_authenticated') === 'true'
    setIsAuthenticated(authStatus)
    if (!authStatus) {
      window.location.href = '/login'
    }
  }, [])

  // Load Polymarket embed script
  useEffect(() => {
    const script = document.createElement('script')
    script.type = 'module'
    script.src = 'https://unpkg.com/@polymarket/embeds@latest/dist/index.js'
    script.async = true
    document.head.appendChild(script)

    return () => {
      // Cleanup: remove script on unmount
      const existingScript = document.querySelector('script[src="https://unpkg.com/@polymarket/embeds@latest/dist/index.js"]')
      if (existingScript) {
        document.head.removeChild(existingScript)
      }
    }
  }, [])
  const [isAddingWallet, setIsAddingWallet] = useState(false)
  const [trackingError, setTrackingError] = useState<string | null>(null)
  const [insightTab, setInsightTab] = useState<'closed' | 'activity' | 'profile'>('closed')
  const [isAddWalletModalOpen, setIsAddWalletModalOpen] = useState(false)
  const [isWalletManagerOpen, setIsWalletManagerOpen] = useState(false)
  const [trades, setTrades] = useState<PolymarketTrade[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false)
  const [visibleTradeCount, setVisibleTradeCount] = useState(INITIAL_TRADE_BATCH_SIZE)
  const [autoLoadEnabled, setAutoLoadEnabled] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [watchers, setWatchers] = useState<WatcherRule[]>([])
  const [alertHistory, setAlertHistory] = useState<AlertEventRecord[]>([])
  const [alertCenterError, setAlertCenterError] = useState<string | null>(null)
  const [isScanningAlerts, setIsScanningAlerts] = useState(false)
  const [isTestingNotification, setIsTestingNotification] = useState(false)
  const [isGlobalRefreshing, setIsGlobalRefreshing] = useState(false)
  const [walletStats, setWalletStats] = useState<Record<string, WalletStatsSummary>>({})
  const [walletResults, setWalletResults] = useState<
    Record<string, WalletResultSummary[]>
  >({})
  const [walletDiagnostics, setWalletDiagnostics] = useState<
    Record<string, WalletDiagnosticsSummary>
  >({})
  const [walletSizing, setWalletSizing] = useState<
    Record<string, WalletSizingSnapshot | null>
  >({})
  const [walletPositions, setWalletPositions] = useState<Record<string, PolymarketPosition[]>>({})
  const [marketMetricsCache, setMarketMetricsCache] = useState<
    Map<string, { metrics: MarketMetrics; fetchedAt: number }>
  >(new Map())
  const walletSportEdges = useMemo<WalletSportEdgeMap>(
    () => buildWalletSportEdgeMap(walletStats),
    [walletStats],
  )
  const [notificationStatus, setNotificationStatus] = useState<
    'idle' | 'requesting' | NotificationPermission | 'unsupported'
  >('idle')
  const abortControllerRef = useRef<AbortController | null>(null)
  const globalPositionsTimerRef = useRef<ReturnType<typeof setInterval>>()
  const loadMoreTriggerRef = useRef<HTMLDivElement | null>(null)

  const trackedWallets = useMemo<TrackedWalletRow[]>(() => {
    if (watchers.length === 0) {
      return []
    }
    const unique = new Map<string, WatcherRule>()
    watchers.forEach((watcher) => {
      const key = watcher.walletAddress.toLowerCase()
      if (!unique.has(key)) {
        unique.set(key, watcher)
      }
    })
    return Array.from(unique.values()).map((watcher) => ({
      walletAddress: watcher.walletAddress,
      nickname: watcher.nickname ?? undefined,
      watcherId: watcher.id,
    }))
  }, [watchers])

  const walletLabelMap = useMemo(() => {
    const map = new Map<string, TrackedWalletRow>()
    trackedWallets.forEach((wallet) => {
      map.set(wallet.walletAddress.toLowerCase(), wallet)
    })
    return map
  }, [trackedWallets])
  const topWalletKey = useMemo(
    () => getTopWalletKey(trackedWallets, walletStats),
    [trackedWallets, walletStats],
  )

  const walletHighlightMap = useMemo(() => {
    const map = new Map<string, WalletHighlight>()
    trackedWallets.forEach((wallet) => {
      const key = wallet.walletAddress.toLowerCase()
      const stats = walletStats[key]
      if (!stats) {
        return
      }
      const highlight = pickWalletHighlight(stats, {
        isTopPerformer: topWalletKey === key,
      })
      if (highlight) {
        map.set(key, highlight)
      }
    })
    return map
  }, [trackedWallets, topWalletKey, walletStats])

  const walletAverageSize = useMemo(() => {
    const map = new Map<string, number>()
    Object.entries(walletSizing).forEach(([wallet, sizing]) => {
      if (!sizing || sizing.averageSize <= 0 || !Number.isFinite(sizing.averageSize)) {
        return
      }
      map.set(wallet, sizing.averageSize)
    })
    Object.entries(walletPositions).forEach(([wallet, positions]) => {
      if (map.has(wallet) || !positions || positions.length === 0) {
        return
      }
      const total = positions.reduce((sum, position) => {
        const value =
          typeof position.initialValue === 'number' ? position.initialValue : 0
        return sum + Math.max(value, 0)
      }, 0)
      const avg = total / positions.length
      if (avg > 0) {
        map.set(wallet, avg)
      }
    })
    return map
  }, [walletPositions, walletSizing])

  const selectedWalletMeta = useMemo(() => {
    if (!selectedWallet) {
      return undefined
    }
    const normalized = selectedWallet.toLowerCase()
    return trackedWallets.find(
      (wallet) => wallet.walletAddress.toLowerCase() === normalized,
    )
  }, [selectedWallet, trackedWallets])
  const selectedWalletKey = selectedWallet?.toLowerCase() ?? null
  const selectedResults = selectedWalletKey ? walletResults[selectedWalletKey] ?? [] : []
  const selectedStats = selectedWalletKey
    ? walletStats[selectedWalletKey] ?? EMPTY_WALLET_STATS
    : undefined
  const selectedDiagnostics = selectedWalletKey
    ? walletDiagnostics[selectedWalletKey]
    : undefined
  const selectedWalletSizing = selectedWalletKey
    ? walletSizing[selectedWalletKey] ?? null
    : null
  const selectedWalletAverageSize = selectedWalletSizing?.averageSize ?? (selectedWalletKey
    ? walletAverageSize.get(selectedWalletKey)
    : undefined)
  const selectedWalletOpenPositions = selectedWalletKey
    ? walletPositions[selectedWalletKey] ?? []
    : []
  const sizingSampleCount = selectedWalletSizing?.positionCount
    ?? (selectedWalletOpenPositions.length > 0
      ? selectedWalletOpenPositions.length
      : undefined)
  const aggregatedPositions = useMemo<AggregatedMarketEntry[]>(() => {
    const markets = new Map<string, AggregatedMarketEntry>()
    Object.entries(walletPositions).forEach(([normalizedAddress, positions]) => {
      if (!positions || positions.length === 0) {
        return
      }
      positions
        .filter((position) => {
          if (!position || position.currentValue <= 0) {
            return false
          }
          // Filter out future "Will" questions
          if (isFutureWillQuestion(position.title, position.endDate)) {
            return false
          }
          if (isStalePosition(position)) {
            return false
          }
          const descriptor = {
            title: position.title,
            slug: position.slug,
            eventSlug: position.eventSlug,
          }
          // If it's a "Will" question with a date, it's likely a sports bet even if not detected as sports market
          // This catches cases like "Will RB Leipzig win on 2025-12-02?" where the team name isn't in keywords
          const isWillWithDate = /^will\b/i.test(position.title?.trim() ?? '') && /\d{4}[-\/]\d{2}[-\/]\d{2}|\d{2}[-\/]\d{2}[-\/]\d{4}/.test(position.title?.trim() ?? '')
          return (isSportsMarket(descriptor) || isWillWithDate) && !isEsportsMarket(descriptor)
        })
        .forEach((position) => {
          const marketKey = position.slug ?? position.eventSlug ?? position.asset
          if (!marketKey) {
            return
          }
          const descriptor = {
            title: position.title,
            slug: position.slug,
            eventSlug: position.eventSlug,
          }
          const sportTag = detectSportTag(descriptor)
          let market = markets.get(marketKey)
          if (!market) {
            market = {
              id: marketKey,
              title: position.title ?? position.slug ?? 'Unknown market',
              totalValue: 0,
              icon: position.icon,
              outcomes: [],
              eventSlug: position.eventSlug,
              slug: position.slug,
              sportTag: sportTag ?? undefined,
              conditionId: position.conditionId,
              eventId: position.eventId,
            }
            markets.set(marketKey, market)
          } else {
            // Update conditionId and eventId if we have them and market doesn't
            if (!market.conditionId && position.conditionId) {
              market.conditionId = position.conditionId
            }
            if (!market.eventId && position.eventId) {
              market.eventId = position.eventId
            }
            if (!market.sportTag && sportTag) {
              market.sportTag = sportTag
            }
          }
          market.totalValue += position.currentValue
          const outcomeLabel = position.outcome ?? 'Outcome'
          let outcome = market.outcomes.find((entry) => entry.outcome === outcomeLabel)
          if (!outcome) {
            outcome = { outcome: outcomeLabel, totalValue: 0, wallets: [] }
            market.outcomes.push(outcome)
          }
          const meta = walletLabelMap.get(normalizedAddress)
          const originalAddress = meta?.walletAddress ?? normalizedAddress
          const label = meta?.nickname || formatWalletAddress(originalAddress)
          outcome.totalValue += position.currentValue
          const highlight = walletHighlightMap.get(normalizedAddress)
          const sportEdge = sportTag
            ? walletSportEdges.get(normalizedAddress)?.get(sportTag)
            : undefined
          const confidence = computePositionConfidence({
            sportTag,
            sportEdge,
            highlight,
            initialValue: position.initialValue,
            averageSize: walletAverageSize.get(normalizedAddress),
            endDate: position.endDate,
          })
          outcome.wallets.push({
            walletAddress: originalAddress,
            label,
            value: position.currentValue,
            initialValue: position.initialValue,
            pnl: position.cashPnl,
            redeemable: Boolean(position.redeemable),
            highlight,
            endDate: position.endDate,
            confidence,
            averageSize: walletAverageSize.get(normalizedAddress),
          })
        })
    })

    return Array.from(markets.values())
      .map((market) => {
        // Attach cached metrics if available
        const cached = market.conditionId
          ? marketMetricsCache.get(market.conditionId)
          : undefined
        return {
          ...market,
          metrics: cached?.metrics,
          outcomes: market.outcomes
            .map((outcome) => ({
              ...outcome,
              wallets: outcome.wallets.sort((a, b) => b.value - a.value),
            }))
            .sort((a, b) => b.totalValue - a.totalValue),
        }
      })
      .sort((a, b) => b.totalValue - a.totalValue)
  }, [
    walletPositions,
    walletLabelMap,
    walletHighlightMap,
    walletSportEdges,
    walletAverageSize,
    marketMetricsCache,
  ])

  // Track which condition IDs we've already fetched (with timestamp) to prevent duplicate requests
  const fetchedMetricsRef = useRef<Map<string, number>>(new Map())
  const METRICS_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

  // Fetch volume and OI metrics for markets - only when aggregatedPositions changes
  useEffect(() => {
    const now = Date.now()

    // Collect unique conditionIds from aggregated positions that need fetching
    const conditionIdsToFetch: Array<{ conditionId: string; eventId?: string; slug?: string }> = []
    
    for (const market of aggregatedPositions) {
      if (!market.conditionId) continue
      
      // Check if we've already fetched this recently
      const lastFetched = fetchedMetricsRef.current.get(market.conditionId)
      if (lastFetched && now - lastFetched < METRICS_CACHE_TTL_MS) {
        continue
      }
      
      conditionIdsToFetch.push({
        conditionId: market.conditionId,
        eventId: market.eventId,
        slug: market.slug,
      })
    }

    if (conditionIdsToFetch.length === 0) {
      return
    }

    // Mark these as being fetched now to prevent duplicate requests
    for (const item of conditionIdsToFetch) {
      fetchedMetricsRef.current.set(item.conditionId, now)
    }

    // Limit to first 10 markets to prevent resource exhaustion
    const limitedItems = conditionIdsToFetch.slice(0, 10)
    
    // Process each request with a delay to prevent ERR_INSUFFICIENT_RESOURCES
    limitedItems.forEach((item, index) => {
      setTimeout(() => {
        fetchMarketMetricsFn({
          data: {
            conditionId: item.conditionId,
            eventId: item.eventId,
            slug: item.slug,
          }
        })
          .then((response) => {
            const metrics = response.metrics
            if (metrics && (metrics.volume || metrics.openInterest)) {
              setMarketMetricsCache((prev) => {
                const next = new Map(prev)
                next.set(item.conditionId, { metrics, fetchedAt: Date.now() })
                return next
              })
            }
          })
          .catch((error) => {
            console.warn('[CLIENT] Failed to fetch metrics for conditionId:', item.conditionId, error)
            // Clear the fetched timestamp so we can retry later
            fetchedMetricsRef.current.delete(item.conditionId)
          })
      }, index * 500) // 500ms delay between each request
    })
  }, [aggregatedPositions]) // Only depend on aggregatedPositions, not marketMetricsCache

  const loadPositionsForWallet = useCallback(async (walletAddress: string) => {
    try {
      const response = await fetchPositionsForUser(walletAddress)
      const filtered = response.filter((position) => {
        if (position.currentValue <= 0) {
          return false
        }
        // Filter out future "Will" questions
        if (isFutureWillQuestion(position.title, position.endDate)) {
          return false
        }
        if (isStalePosition(position)) {
          return false
        }
        const descriptor = {
          title: position.title,
          slug: position.slug,
          eventSlug: position.eventSlug,
        }
        // If it's a "Will" question with a date, it's likely a sports bet even if not detected as sports market
        // This catches cases like "Will RB Leipzig win on 2025-12-02?" where the team name isn't in keywords
        const isWillWithDate = /^will\b/i.test(position.title?.trim() ?? '') && /\d{4}[-\/]\d{2}[-\/]\d{2}|\d{2}[-\/]\d{2}[-\/]\d{4}/.test(position.title?.trim() ?? '')
        return (isSportsMarket(descriptor) || isWillWithDate) && !isEsportsMarket(descriptor)
      })
      setWalletPositions((previous) => ({
        ...previous,
        [walletAddress.toLowerCase()]: filtered,
      }))
    } catch (error) {
      console.error('Unable to load positions for overview', walletAddress, error)
    }
  }, [])

  const loadWalletData = useCallback(
    async (wallet?: string | null, options?: { silent?: boolean }) => {
      const trimmedWallet = wallet?.trim() ?? ''

      if (!trimmedWallet) {
        setTrades([])
        setStatus('idle')
        setErrorMessage('Select a wallet from your dashboard to load data.')
        return
      }

      abortControllerRef.current?.abort()
      const controller = new AbortController()
      abortControllerRef.current = controller

      if (options?.silent) {
        setIsAutoRefreshing(true)
      } else {
        setStatus('loading')
        setErrorMessage(null)
      }

      try {
        const [tradesData] = await Promise.all([
          fetchTradesForUser(trimmedWallet, controller.signal),
        ])
        setTrades(tradesData)
        await loadPositionsForWallet(trimmedWallet)
        setStatus('success')
        setErrorMessage(null)
        setLastUpdated(Date.now())
      } catch (error) {
        if (controller.signal.aborted) {
          return
        }

        setStatus('error')
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Unable to load activity from Polymarket.',
        )
      } finally {
        if (options?.silent) {
          setIsAutoRefreshing(false)
        }
      }
    },
    [loadPositionsForWallet],
  )
  const loadWatchersForUser = useCallback(async (id: string) => {
    try {
      const response = await listWatchersFn({ data: { userId: id } })
      setWatchers(response.watchers)
    } catch (error) {
      console.error('Unable to load alert rules', error)
      setAlertCenterError(
        error instanceof Error
          ? error.message
          : 'Unable to load alert rules from D1.',
      )
    }
  }, [])

  const loadWalletStats = useCallback(
    async (walletAddress: string) => {
      try {
        const response = await getWalletStatsFn({
          data: { walletAddress, sportsOnly: true },
        })
        const normalized = walletAddress.toLowerCase()
        setWalletStats((previous) => ({
          ...previous,
          [normalized]: response.stats as WalletStatsSummary,
        }))
      } catch (error) {
        console.error('Unable to load wallet stats', walletAddress, error)
      }
    },
    [],
  )

  const loadWalletDiagnostics = useCallback(async (walletAddress: string) => {
    try {
      const response = await getWalletDiagnosticsFn({
        data: { walletAddress, days: 7 },
      })
      const normalized = walletAddress.toLowerCase()
      setWalletDiagnostics((previous) => ({
        ...previous,
        [normalized]: response as WalletDiagnosticsSummary,
      }))
    } catch (error) {
      console.error('Unable to load wallet diagnostics', walletAddress, error)
    }
  }, [])

  const loadWalletResults = useCallback(async (walletAddress: string) => {
    try {
      const response = await listWalletResultsFn({
        data: { walletAddress, sportsOnly: true, limit: 25 },
      })
      const normalized = walletAddress.toLowerCase()
      setWalletResults((previous) => ({
        ...previous,
        [normalized]: response.results as WalletResultSummary[],
      }))
    } catch (error) {
      console.error('Unable to load wallet history', walletAddress, error)
    }
  }, [])

  const loadWalletSizing = useCallback(async (walletAddress: string) => {
    try {
      const response = await getWalletSizingFn({
        data: { walletAddress },
      })
      const normalized = walletAddress.toLowerCase()
      setWalletSizing((previous) => ({
        ...previous,
        [normalized]: response.sizing
          ? {
            averageSize: response.sizing.averageSize,
            positionCount: response.sizing.positionCount,
            updatedAt: response.sizing.updatedAt,
          }
          : null,
      }))
    } catch (error) {
      console.error('Unable to load wallet sizing snapshot', walletAddress, error)
    }
  }, [])

  const loadAlertHistory = useCallback(async (id: string) => {
    try {
      const response = await listAlertHistoryFn({ data: { userId: id } })
      setAlertHistory(response.alerts)
    } catch (error) {
      console.error('Unable to load alert history', error)
    }
  }, [])

  const refreshAllPositions = useCallback(async () => {
    if (trackedWallets.length === 0) {
      return
    }
    await Promise.all(
      trackedWallets.map(async (wallet) => {
        try {
          await loadPositionsForWallet(wallet.walletAddress)
        } catch (error) {
          console.error('Unable to refresh positions for', wallet.walletAddress, error)
        }
      }),
    )
  }, [loadPositionsForWallet, trackedWallets])

  const refreshAllData = useCallback(async () => {
    setIsGlobalRefreshing(true)
    try {
      if (userId) {
        await Promise.all([
          loadWatchersForUser(userId),
          loadAlertHistory(userId),
        ])
      }
      await Promise.all(
        trackedWallets.map(async (wallet) => {
          await Promise.all([
            loadWalletStats(wallet.walletAddress),
            loadWalletResults(wallet.walletAddress),
            loadWalletSizing(wallet.walletAddress),
            loadPositionsForWallet(wallet.walletAddress),
          ])
        }),
      )
      if (selectedWallet) {
        await loadWalletDiagnostics(selectedWallet)
        await loadWalletData(selectedWallet, { silent: true })
      }
      setLastUpdated(Date.now())
    } catch (error) {
      console.error('Unable to refresh all data', error)
    } finally {
      setIsGlobalRefreshing(false)
    }
  }, [
    loadAlertHistory,
    loadPositionsForWallet,
    loadWalletData,
    loadWalletDiagnostics,
    loadWalletResults,
    loadWalletSizing,
    loadWalletStats,
    loadWatchersForUser,
    selectedWallet,
    trackedWallets,
    userId,
  ])

  useEffect(() => {
    let isMounted = true

    const bootstrapUser = async () => {
      try {
        const response = await ensureUserFn({ data: undefined })
        if (!isMounted) {
          return
        }
        setUserId(response.userId)
      } catch (error) {
        console.error('Unable to initialize user identity', error)
        setAlertCenterError(
          error instanceof Error
            ? error.message
            : 'Unable to initialize alert preferences.',
        )
      }
    }

    bootstrapUser()

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (!userId) {
      return
    }
    loadWatchersForUser(userId)
    loadAlertHistory(userId)
  }, [loadAlertHistory, loadWatchersForUser, userId])

  useEffect(() => {
    if (selectedWallet || trackedWallets.length === 0) {
      return
    }
    setSelectedWallet(trackedWallets[0].walletAddress)
  }, [selectedWallet, trackedWallets])

  useEffect(() => {
    trackedWallets.forEach((wallet) => {
      const key = wallet.walletAddress.toLowerCase()
      if (!walletStats[key]) {
        loadWalletStats(wallet.walletAddress)
      }
    })
  }, [loadWalletStats, trackedWallets, walletStats])

  useEffect(() => {
    trackedWallets.forEach((wallet) => {
      const key = wallet.walletAddress.toLowerCase()
      if (!walletResults[key]) {
        loadWalletResults(wallet.walletAddress)
      }
    })
  }, [loadWalletResults, trackedWallets, walletResults])

  useEffect(() => {
    trackedWallets.forEach((wallet) => {
      const key = wallet.walletAddress.toLowerCase()
      if (!(key in walletSizing)) {
        loadWalletSizing(wallet.walletAddress)
      }
    })
  }, [loadWalletSizing, trackedWallets, walletSizing])

  useEffect(() => {
    trackedWallets.forEach((wallet) => {
      const key = wallet.walletAddress.toLowerCase()
      if (!walletPositions[key]) {
        loadPositionsForWallet(wallet.walletAddress)
      }
    })
  }, [loadPositionsForWallet, trackedWallets, walletPositions])

  useEffect(() => {
    if (trackedWallets.length === 0) {
      return
    }
    globalPositionsTimerRef.current && clearInterval(globalPositionsTimerRef.current)
    globalPositionsTimerRef.current = setInterval(() => {
      refreshAllPositions()
    }, GLOBAL_POSITIONS_REFRESH_MS)
    return () => {
      if (globalPositionsTimerRef.current) {
        clearInterval(globalPositionsTimerRef.current)
      }
    }
  }, [refreshAllPositions, trackedWallets.length])

  useEffect(() => {
    if (!selectedWallet) {
      return
    }
    const key = selectedWallet.toLowerCase()
    if (!walletDiagnostics[key]) {
      loadWalletDiagnostics(selectedWallet)
    }
  }, [loadWalletDiagnostics, selectedWallet, walletDiagnostics])

  const handleAddTrackedWallet = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()

      if (!userId) {
        setTrackingError('Still preparing your workspace. Try again in a moment.')
        return
      }

      const walletAddress = trackingForm.walletAddress.trim()
      if (!walletAddress) {
        setTrackingError('Enter a wallet address to track.')
        return
      }

      setIsAddingWallet(true)
      try {
        await upsertWatcherFn({
          data: {
            userId,
            watcher: {
              walletAddress,
              nickname: trackingForm.nickname.trim() || undefined,
              notifyChannels: ['pusher'] as const,
            },
          },
        })
        setTrackingError(null)
        setTrackingForm(DEFAULT_ADD_WALLET_FORM)
        setIsAddWalletModalOpen(false)
        setSelectedWallet(walletAddress)
        await loadWatchersForUser(userId)
      } catch (error) {
        console.error('Unable to add tracked wallet', error)
        setTrackingError(
          error instanceof Error ? error.message : 'Unable to add wallet to dashboard.',
        )
      } finally {
        setIsAddingWallet(false)
      }
    },
    [loadWatchersForUser, trackingForm, userId],
  )

  const handleWatcherDelete = useCallback(
    async (watcherId: string, walletAddress?: string) => {
      if (!userId) {
        return
      }

      try {
        await deleteWatcherFn({ data: { userId, watcherId } })
        await loadWatchersForUser(userId)
        if (
          walletAddress &&
          selectedWallet &&
          walletAddress.toLowerCase() === selectedWallet.toLowerCase()
        ) {
          setSelectedWallet(null)
        }
      } catch (error) {
        console.error('Unable to delete watcher', error)
        setAlertCenterError(
          error instanceof Error
            ? error.message
            : 'Unable to delete alert rule.',
        )
      }
    },
    [loadWatchersForUser, selectedWallet, userId],
  )

  const handleAlertScan = useCallback(async () => {
    if (!userId) {
      return
    }

    setIsScanningAlerts(true)
    try {
      const response = await runAlertScanFn({ data: { userId } })
      if (response.alerts.length > 0) {
        setAlertCenterError(null)
      }
      await loadAlertHistory(userId)
    } catch (error) {
      console.error('Unable to run alert scan', error)
      setAlertCenterError(
        error instanceof Error
          ? error.message
          : 'Unable to manually scan for alerts.',
      )
    } finally {
      setIsScanningAlerts(false)
    }
  }, [loadAlertHistory, userId])

  const handleTestNotification = useCallback(async () => {
    setIsTestingNotification(true)
    setAlertCenterError(null)
    try {
      const result = await testPushNotificationFn({ data: undefined })
      console.log('[Test Notification] Server response:', result)

      // Check if notification permission is granted
      if ('Notification' in window && Notification.permission !== 'granted') {
        setAlertCenterError(
          'Notification permission not granted. Click "Enable push notifications" first.',
        )
        return
      }

      // Check service worker
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.ready
        if (!registration) {
          setAlertCenterError('Service worker not ready. Please refresh the page.')
          return
        }
      }

      // Check Pusher Beams subscription
      if (window.PusherPushNotifications) {
        try {
          const client = new window.PusherPushNotifications.Client({
            instanceId: import.meta.env.VITE_PUSHER_BEAMS_INSTANCE_ID || '',
          })
          const interestsResponse = await client.getDeviceInterests()
          console.log('[Test Notification] Subscribed interests:', interestsResponse)
          // getDeviceInterests returns {interests: string[]}, not an array directly
          const interests = Array.isArray(interestsResponse)
            ? interestsResponse
            : (interestsResponse && interestsResponse.interests ? interestsResponse.interests : [])
          if (!interests.includes('wallet-alerts')) {
            setAlertCenterError(
              'Not subscribed to wallet-alerts interest. Please refresh the page to re-subscribe.',
            )
            return
          }
        } catch (err) {
          console.error('[Test Notification] Error checking subscription:', err)
        }
      }

      // If we got here, everything looks good
      setAlertCenterError(null)
      console.log('[Test Notification] Notification sent successfully. Check your notifications!')

      // Check service worker for push event logs
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then((registrations) => {
          registrations.forEach((registration) => {
            if (registration.active) {
              registration.active.postMessage({ type: 'CHECK_PUSH_EVENTS' })
              console.log('[Test Notification] Service worker active, check console for push event logs')
            }
          })
        })
      }
    } catch (error) {
      console.error('Unable to send test notification', error)
      setAlertCenterError(
        error instanceof Error
          ? error.message
          : 'Unable to send test notification. Check your Pusher Beams configuration.',
      )
    } finally {
      setIsTestingNotification(false)
    }
  }, [])

  useEffect(() => {
    if (trades.length === 0) {
      setVisibleTradeCount(0)
      return
    }
    setVisibleTradeCount(Math.min(INITIAL_TRADE_BATCH_SIZE, trades.length))
  }, [trades])

  useEffect(() => {
    loadWalletData(selectedWallet)
  }, [loadWalletData, selectedWallet])

  useEffect(() => {
    const enableAutoLoad = () => {
      setAutoLoadEnabled(true)
      window.removeEventListener('scroll', enableAutoLoad)
    }

    window.addEventListener('scroll', enableAutoLoad, { passive: true })

    return () => {
      window.removeEventListener('scroll', enableAutoLoad)
    }
  }, [])

  useEffect(
    () => () => {
      abortControllerRef.current?.abort()
    },
    [],
  )

  const tradeStats = useMemo(() => {
    let lastTimestamp: number | null = null

    trades.forEach((trade) => {
      lastTimestamp =
        lastTimestamp !== null
          ? Math.max(lastTimestamp, trade.timestamp)
          : trade.timestamp
    })

    return {
      lastTimestamp,
    }
  }, [trades])

  const displayedTrades = useMemo(
    () => trades.slice(0, visibleTradeCount),
    [trades, visibleTradeCount],
  )
  const hasMoreTrades = visibleTradeCount < trades.length

  const profile = trades[0]

  const currencyFormatter = useMemo(
    () =>
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }),
    [],
  )

  const numberFormatter = useMemo(
    () =>
      new Intl.NumberFormat('en-US', {
        maximumFractionDigits: 2,
      }),
    [],
  )

  const manualRefresh = () => {
    loadWalletData(selectedWallet)
  }

  const loadMoreTrades = useCallback(() => {
    if (trades.length === 0) {
      return
    }

    setAutoLoadEnabled(true)
    setVisibleTradeCount((previous) =>
      Math.min(previous + TRADE_BATCH_INCREMENT, trades.length),
    )
  }, [trades.length])

  useEffect(() => {
    if (!hasMoreTrades || !autoLoadEnabled) {
      return
    }

    const sentinel = loadMoreTriggerRef.current
    if (!sentinel) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            loadMoreTrades()
          }
        })
      },
      { rootMargin: '0px 0px 200px 0px' },
    )

    observer.observe(sentinel)

    return () => {
      observer.disconnect()
    }
  }, [autoLoadEnabled, hasMoreTrades, loadMoreTrades])

  const hasTrades = trades.length > 0

  const handleNotificationPermission = useCallback(async () => {
    if (typeof window === 'undefined') {
      return
    }
    if (!('Notification' in window)) {
      setNotificationStatus('unsupported')
      return
    }
    if (Notification.permission === 'granted') {
      setNotificationStatus('granted')
      return
    }
    setNotificationStatus('requesting')
    try {
      const permission = await Notification.requestPermission()
      setNotificationStatus(permission)
    } catch {
      setNotificationStatus('denied')
    }
  }, [])

  // Show loading or redirect if not authenticated
  if (isAuthenticated === false) {
    return null // Will redirect
  }

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400 mx-auto mb-4" />
          <p className="text-gray-400">Checking authentication...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white">
      <div
        className="px-4 py-6 sm:px-5 sm:py-8 md:px-6 md:py-10 lg:px-8 lg:py-12 container mx-auto space-y-4 sm:space-y-6 md:space-y-10"
        style={{
          paddingTop: 'max(1.5rem, calc(env(safe-area-inset-top, 0px) + 1.5rem))'
        }}
      >
        <div className="space-y-2 sm:space-y-3 md:space-y-4">
          <div className="flex items-center gap-3">
            <WhaleMark className="h-10 w-10 md:h-12 md:w-12 text-cyan-300" />
            <p className="text-4xl md:text-4xl lg:text-5xl font-black uppercase tracking-[0.2em] text-cyan-400/80">
              Polywhaler
            </p>
          </div>
          <p className="text-xs sm:text-sm md:text-base text-gray-300 max-w-3xl">
            Track as many proxy wallets as you want, see their open and closed positions, and monitor PnL plus win/loss records across every timeframe.
          </p>
        </div>
        <div className="space-y-4 sm:space-y-5 md:space-y-6 lg:space-y-8">
          <div className="lg:hidden">
            <SharedPositionsBoard
              positions={aggregatedPositions}
              walletSportEdges={walletSportEdges}
              onRefreshBoard={refreshAllData}
              isRefreshing={isGlobalRefreshing}
            />
          </div>
          <div className="grid gap-4 sm:gap-5 md:gap-6 lg:gap-8 lg:grid-cols-[320px_1fr] items-start">
            <aside className="space-y-4 sm:space-y-5 md:space-y-6">
              <div className="space-y-4 sm:space-y-5 md:space-y-6 lg:sticky lg:top-10">
                <section className="rounded-xl sm:rounded-2xl border border-slate-800/80 bg-slate-950/80 backdrop-blur-sm shadow-lg shadow-black/20 p-3 sm:p-4 md:p-5 space-y-3 sm:space-y-4">
                  <div>
                    <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">
                      Control center
                    </p>
                    <h2 className="text-base sm:text-lg md:text-xl font-semibold">Build your board</h2>
                    <p className="text-xs sm:text-sm text-gray-400">
                      Keep a tight list of proxy wallets for instant reads, then drop into deeper research on the right.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setIsAddWalletModalOpen(true)}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 sm:gap-2 rounded-lg sm:rounded-xl bg-cyan-500 px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-slate-950 hover:bg-cyan-400"
                    >
                      <Plus className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                      Add wallet
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsWalletManagerOpen(true)}
                      className="inline-flex items-center gap-1.5 sm:gap-2 rounded-lg sm:rounded-xl border border-slate-800 px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm text-gray-200 hover:border-cyan-400"
                    >
                      <Wallet className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-cyan-300" />
                      Manage
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleNotificationPermission}
                    disabled={notificationStatus === 'requesting'}
                    className="inline-flex w-full items-center justify-center gap-1.5 sm:gap-2 rounded-lg sm:rounded-xl border border-slate-800 px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm text-gray-200 hover:border-cyan-400 disabled:opacity-50"
                  >
                    <BellRing className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-cyan-300" />
                    {notificationStatus === 'granted'
                      ? 'Push enabled'
                      : notificationStatus === 'denied'
                        ? 'Permission denied'
                        : notificationStatus === 'unsupported'
                          ? 'Push unsupported'
                          : 'Enable push notifications'}
                  </button>
                  {notificationStatus === 'denied' && (
                    <p className="text-[0.65rem] text-rose-300">
                      Re-enable in iOS Settings ▸ Notifications ▸ Polywhaler.
                    </p>
                  )}
                  {notificationStatus === 'unsupported' && (
                    <p className="text-[0.65rem] text-rose-300">
                      This device or browser does not support web push.
                    </p>
                  )}
                  <p className="text-xs text-gray-500">
                    Tracking{' '}
                    <span className="font-semibold text-white">
                      {trackedWallets.length}
                    </span>{' '}
                    wallet{trackedWallets.length === 1 ? '' : 's'} right now.
                  </p>
                </section>
                <WalletSummaryList
                  trackedWallets={trackedWallets}
                  walletStats={walletStats}
                  onSelectWallet={setSelectedWallet}
                  selectedWallet={selectedWallet}
                />
                <AlertCenter
                  watchers={watchers}
                  canEdit={Boolean(userId && selectedWallet)}
                  alertError={alertCenterError}
                  onRunScan={handleAlertScan}
                  isScanning={isScanningAlerts}
                  alertHistory={alertHistory}
                  onTestNotification={handleTestNotification}
                  isTestingNotification={isTestingNotification}
                />
              </div>
            </aside>
            <main className="space-y-4 sm:space-y-5 md:space-y-6 lg:space-y-8">
              <div className="hidden lg:block">
                <SharedPositionsBoard
                  positions={aggregatedPositions}
                  walletSportEdges={walletSportEdges}
                  onRefreshBoard={refreshAllData}
                  isRefreshing={isGlobalRefreshing}
                />
              </div>

              {selectedWallet ? (
                <section className="bg-slate-950/70 border border-slate-800/80 rounded-xl sm:rounded-2xl shadow-lg shadow-black/20 p-3 sm:p-4 md:p-6 space-y-3 sm:space-y-4 md:space-y-6">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">
                        Insights for
                      </p>
                      <h2 className="text-lg sm:text-xl md:text-2xl lg:text-3xl font-semibold">
                        {selectedWalletMeta?.nickname || formatWalletAddress(selectedWallet)}
                      </h2>
                      <p className="text-xs sm:text-sm text-gray-400">{selectedWallet}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-[0.65rem] sm:text-xs text-gray-400">
                      {lastUpdated && (
                        <span className="inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-slate-800 px-2 sm:px-3 py-0.5 sm:py-1">
                          <Clock className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-cyan-300" />
                          Updated {new Date(lastUpdated).toLocaleTimeString()}
                        </span>
                      )}
                      {isAutoRefreshing && (
                        <span className="inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-slate-800 px-2 sm:px-3 py-0.5 sm:py-1 text-cyan-300">
                          <RefreshCw className="h-3.5 w-3.5 sm:h-4 sm:w-4 animate-spin" />
                          Auto-refreshing
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={manualRefresh}
                        className="inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-slate-800 px-2 sm:px-3 py-0.5 sm:py-1 text-[0.65rem] sm:text-xs text-gray-200 hover:border-cyan-400 disabled:opacity-50"
                        disabled={status === 'loading'}
                      >
                        <RefreshCw className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${status === 'loading' ? 'animate-spin' : ''}`} />
                        Refresh now
                      </button>
                    </div>
                  </div>

                  {errorMessage && (
                    <div className="bg-rose-950/40 border border-rose-900 text-rose-200 px-3 sm:px-4 py-2 sm:py-3 rounded-lg sm:rounded-xl text-xs sm:text-sm">
                      {errorMessage}
                    </div>
                  )}

                  {(selectedDiagnostics || selectedWalletAverageSize) && (
                    <div
                      className={`grid gap-2 sm:gap-3 md:gap-4 ${selectedDiagnostics
                          ? selectedWalletAverageSize
                            ? 'md:grid-cols-4'
                            : 'md:grid-cols-3'
                          : 'md:grid-cols-1'
                        }`}
                    >
                      {selectedDiagnostics && (
                        <>
                          <div className="rounded-lg sm:rounded-xl md:rounded-2xl border border-slate-800/80 bg-slate-900/40 backdrop-blur-sm p-2.5 sm:p-3 md:p-4 space-y-1">
                            <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">
                              Closed PnL (7d)
                            </p>
                            <p className="text-base sm:text-lg font-semibold text-white">
                              {selectedDiagnostics.closed.wins}-{selectedDiagnostics.closed.losses}-{selectedDiagnostics.closed.ties}
                            </p>
                            <p
                              className={`text-xs sm:text-sm font-semibold ${selectedDiagnostics.closed.pnlUsd >= 0
                                  ? 'text-emerald-300'
                                  : 'text-rose-300'
                                }`}
                            >
                              {selectedDiagnostics.closed.pnlUsd >= 0 ? '+' : '-'}
                              {formatUsdCompact(Math.abs(selectedDiagnostics.closed.pnlUsd))}
                            </p>
                            <p className="text-[0.65rem] sm:text-xs text-gray-500">
                              {selectedDiagnostics.closed.sampleCount} resolved markets
                            </p>
                          </div>
                          <div className="rounded-lg sm:rounded-xl md:rounded-2xl border border-slate-800/80 bg-slate-900/40 backdrop-blur-sm p-2.5 sm:p-3 md:p-4 space-y-1">
                            <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">
                              Open exposure
                            </p>
                            <p className="text-base sm:text-lg font-semibold text-white">
                              {formatUsdCompact(selectedDiagnostics.open.pnlUsd)}
                            </p>
                            <p className="text-[0.65rem] sm:text-xs text-gray-500">
                              Across {selectedDiagnostics.open.positionCount} positions
                            </p>
                          </div>
                          <div className="rounded-lg sm:rounded-xl md:rounded-2xl border border-slate-800/80 bg-slate-900/40 backdrop-blur-sm p-2.5 sm:p-3 md:p-4 space-y-1">
                            <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">
                              Flow (7d)
                            </p>
                            <p className="text-xs sm:text-sm text-gray-300">
                              Buy {formatUsdCompact(selectedDiagnostics.trades.buyVolume)}
                            </p>
                            <p className="text-xs sm:text-sm text-gray-300">
                              Sell {formatUsdCompact(selectedDiagnostics.trades.sellVolume)}
                            </p>
                          </div>
                        </>
                      )}
                      {selectedWalletAverageSize && (
                        <div className="rounded-lg sm:rounded-xl md:rounded-2xl border border-slate-800/80 bg-slate-900/40 backdrop-blur-sm p-2.5 sm:p-3 md:p-4 space-y-1">
                          <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">
                            Typical unit size
                          </p>
                          <p className="text-base sm:text-lg font-semibold text-white">
                            {formatUsdCompact(selectedWalletAverageSize)}
                          </p>
                          {typeof sizingSampleCount === 'number' && sizingSampleCount > 0 && (
                            <p className="text-[0.65rem] sm:text-xs text-gray-500">
                              Avg of {sizingSampleCount} open position{sizingSampleCount === 1 ? '' : 's'}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 sm:gap-3 md:gap-4">
                    <div>
                      <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">Deep dives</p>
                      <h3 className="text-base sm:text-lg md:text-xl lg:text-2xl font-semibold">More context on this trader</h3>
                    </div>
                    <div className="flex-1" />
                    <div className="flex flex-wrap gap-1.5 sm:gap-2">
                      <button
                        type="button"
                        onClick={() => setInsightTab('closed')}
                        className={`rounded-full border px-2.5 sm:px-3 md:px-4 py-1 sm:py-1.5 text-[0.65rem] sm:text-xs font-semibold transition ${insightTab === 'closed' ? 'border-cyan-400 text-cyan-200 bg-cyan-500/10' : 'border-slate-800 text-gray-400 hover:border-cyan-400/60'}`}
                      >
                        Closed markets
                      </button>
                      <button
                        type="button"
                        onClick={() => setInsightTab('activity')}
                        className={`rounded-full border px-2.5 sm:px-3 md:px-4 py-1 sm:py-1.5 text-[0.65rem] sm:text-xs font-semibold transition ${insightTab === 'activity' ? 'border-cyan-400 text-cyan-200 bg-cyan-500/10' : 'border-slate-800 text-gray-400 hover:border-cyan-400/60'}`}
                      >
                        Live tape
                      </button>
                      <button
                        type="button"
                        onClick={() => setInsightTab('profile')}
                        className={`rounded-full border px-2.5 sm:px-3 md:px-4 py-1 sm:py-1.5 text-[0.65rem] sm:text-xs font-semibold transition ${insightTab === 'profile' ? 'border-cyan-400 text-cyan-200 bg-cyan-500/10' : 'border-slate-800 text-gray-400 hover:border-cyan-400/60'}`}
                      >
                        Profile
                      </button>
                    </div>
                  </div>

                  {insightTab === 'closed' && (
                    <div className="space-y-3 sm:space-y-4">
                      {selectedStats && selectedStats.bySport.length > 0 && (
                        <div className="rounded-lg sm:rounded-xl md:rounded-2xl border border-slate-800/80 bg-slate-900/50 backdrop-blur-sm p-3 sm:p-4 space-y-2 sm:space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">
                                Sports records
                              </p>
                              <h4 className="text-sm sm:text-base md:text-lg font-semibold">League breakdown</h4>
                            </div>
                            <span className="text-[0.65rem] sm:text-xs text-gray-400">
                              {selectedStats.bySport.length} league
                              {selectedStats.bySport.length === 1 ? '' : 's'}
                            </span>
                          </div>
                          <div className="grid gap-2 sm:gap-3 sm:grid-cols-2">
                            {selectedStats.bySport.map((record) => {
                              const label = getSportLabel(record.sport) ?? record.sport.toUpperCase()
                              const pnlPositive = record.pnlUsd >= 0
                              return (
                                <div
                                  key={`${record.sport}-breakdown`}
                                  className="rounded-lg sm:rounded-xl border border-slate-800/80 bg-slate-950/60 p-2 sm:p-3"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="text-xs sm:text-sm font-semibold text-white">{label}</p>
                                    <p className="text-[0.6rem] uppercase tracking-[0.3em] text-gray-500">
                                      Record
                                    </p>
                                  </div>
                                  <p className="text-sm sm:text-base md:text-lg font-semibold text-white">
                                    {record.wins}-{record.losses}-{record.ties}
                                  </p>
                                  <p
                                    className={`text-[0.65rem] sm:text-xs font-semibold ${pnlPositive ? 'text-emerald-300' : 'text-rose-300'
                                      }`}
                                  >
                                    {pnlPositive ? '+' : '-'}
                                    {formatUsdCompact(Math.abs(record.pnlUsd))}
                                  </p>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}
                      {selectedStats && selectedStats.byEdge.length > 0 && (
                        <div className="rounded-lg sm:rounded-xl md:rounded-2xl border border-cyan-500/20 bg-slate-900/50 backdrop-blur-sm p-3 sm:p-4 space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-cyan-300">
                                Edge pockets
                              </p>
                              <h4 className="text-sm sm:text-base md:text-lg font-semibold">
                                Where this wallet crushes
                              </h4>
                            </div>
                            <span className="text-[0.65rem] sm:text-xs text-gray-400">
                              Top {Math.min(4, selectedStats.byEdge.length)} of {selectedStats.byEdge.length}
                            </span>
                          </div>
                          <div className="space-y-2">
                            {selectedStats.byEdge.slice(0, 4).map((edge, index) => {
                              const sportLabel = edge.sport
                                ? getSportLabel(edge.sport) ?? edge.sport.toUpperCase()
                                : 'Any sport'
                              const recordLabel = `${edge.wins}-${edge.losses}-${edge.ties}`
                              const pnlPositive = edge.pnlUsd >= 0
                              return (
                                <div
                                  key={`${edge.sport ?? 'any'}-${edge.betType ?? 'any'}-${edge.horizon ?? 'any'}-${index}`}
                                  className="rounded-lg border border-slate-800/70 bg-slate-950/60 p-2.5 sm:p-3 flex flex-wrap items-center gap-2"
                                >
                                  <div className="flex-1 min-w-[180px]">
                                    <p className="text-xs sm:text-sm font-semibold text-white">{sportLabel}</p>
                                    <p className="text-[0.65rem] sm:text-xs text-gray-400">
                                      {getBetTypeLabel(edge.betType)} · {getHorizonLabel(edge.horizon)} · {edge.sampleSize} plays
                                    </p>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-xs sm:text-sm font-semibold text-white">{recordLabel}</p>
                                    <p
                                      className={`text-[0.65rem] sm:text-xs font-semibold ${pnlPositive ? 'text-emerald-300' : 'text-rose-300'
                                        }`}
                                    >
                                      {pnlPositive ? '+' : '-'}
                                      {formatUsdCompact(Math.abs(edge.pnlUsd))}
                                    </p>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}
                      {selectedResults.length > 0 ? (
                        <ul className="space-y-2 sm:space-y-3 md:space-y-4">
                          {selectedResults.map((result) => {
                            const sportLabel = getSportLabel(result.sportTag)
                            const marketLabel = sportLabel
                              ? `${sportLabel} market`
                              : result.isSports
                                ? 'Sports market'
                                : 'General market'
                            return (
                              <li
                                key={`${result.asset}-${result.resolvedAt}`}
                                className="rounded-lg sm:rounded-xl md:rounded-2xl border border-slate-800/80 bg-slate-900/60 backdrop-blur-sm p-3 sm:p-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between"
                              >
                                <div>
                                  <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">
                                    {result.result.toUpperCase()}
                                  </p>
                                  <h4 className="text-sm sm:text-base md:text-lg font-semibold">
                                    {result.title || result.asset}
                                  </h4>
                                  <p className="text-[0.65rem] sm:text-xs text-gray-500">
                                    Resolved {new Date(result.resolvedAt * 1000).toLocaleDateString()}
                                  </p>
                                </div>
                                <div className="text-right">
                                  <p
                                    className={`text-base sm:text-lg md:text-xl font-semibold ${result.pnlUsd >= 0 ? 'text-emerald-300' : 'text-rose-300'
                                      }`}
                                  >
                                    {result.pnlUsd >= 0 ? '+' : '-'}
                                    {currencyFormatter.format(Math.abs(result.pnlUsd))}
                                  </p>
                                  <p className="text-xs sm:text-sm text-gray-400">{marketLabel}</p>
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      ) : (
                        <p className="text-xs sm:text-sm text-gray-400">
                          No closed markets stored yet. Stats will appear here once positions resolve.
                        </p>
                      )}
                    </div>
                  )}

                  {insightTab === 'profile' && (
                    profile ? (
                      <div className="bg-slate-900/70 border border-slate-800/80 rounded-lg sm:rounded-xl md:rounded-2xl p-4 sm:p-5 md:p-6 flex flex-col md:flex-row gap-4 sm:gap-5 md:gap-6 items-center shadow-lg shadow-black/20">
                        <img
                          src={profile.profileImage || profile.profileImageOptimized || '/tanstack-circle-logo.png'}
                          alt={profile.pseudonym ?? profile.name ?? 'profile'}
                          className="h-16 w-16 sm:h-20 sm:w-20 md:h-24 md:w-24 rounded-lg sm:rounded-xl md:rounded-2xl object-cover border border-slate-700"
                        />
                        <div className="flex-1 w-full space-y-1.5 sm:space-y-2">
                          <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">Trader profile</p>
                          <h2 className="text-lg sm:text-xl md:text-2xl font-semibold">{profile.name || profile.pseudonym || 'Unnamed'}</h2>
                          {profile.pseudonym && (
                            <p className="text-cyan-300 text-xs sm:text-sm">@{profile.pseudonym}</p>
                          )}
                          {profile.bio && (
                            <p className="text-gray-300 text-xs sm:text-sm max-w-3xl">{profile.bio}</p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs sm:text-sm text-gray-400">No Polymarket profile metadata on this wallet.</p>
                    )
                  )}

                  {insightTab === 'activity' && (
                    <div className="bg-slate-950/50 border border-slate-800/80 rounded-lg sm:rounded-xl md:rounded-2xl overflow-hidden shadow-lg shadow-black/20">
                      <div className="flex items-center justify-between px-3 sm:px-4 md:px-6 py-2.5 sm:py-3 md:py-4 border-b border-slate-800/80">
                        <div>
                          <p className="text-[0.65rem] sm:text-xs md:text-sm uppercase tracking-[0.3em] text-gray-500">
                            Live tape
                          </p>
                          <h3 className="text-sm sm:text-base md:text-lg lg:text-xl font-semibold">
                            Recent fills ({trades.length})
                          </h3>
                        </div>
                        {tradeStats.lastTimestamp && (
                          <p className="text-[0.65rem] sm:text-xs text-gray-400">
                            Latest fill {formatTradeTimestamp(tradeStats.lastTimestamp)}
                          </p>
                        )}
                      </div>

                      {!hasTrades && status === 'success' && (
                        <div className="p-4 sm:p-5 md:p-6 text-xs sm:text-sm text-gray-400">
                          No on-chain fills yet for this wallet. Try another proxy address.
                        </div>
                      )}

                      {status === 'loading' && (
                        <div className="p-4 sm:p-5 md:p-6 text-xs sm:text-sm text-gray-400 animate-pulse">
                          Pulling fresh fills from Polymarket…
                        </div>
                      )}

                      {hasTrades && (
                        <>
                          <ul className="divide-y divide-slate-800/80">
                            {displayedTrades.map((trade) => (
                              <li
                                key={`${trade.transactionHash}-${trade.timestamp}-${trade.asset}`}
                                className="px-3 sm:px-4 md:px-6 py-2.5 sm:py-3 md:py-4 flex flex-col gap-2 md:flex-row md:items-center md:gap-6"
                              >
                                <div className="flex items-center gap-2 sm:gap-3 w-full md:w-56">
                                  {trade.icon ? (
                                    <img
                                      src={trade.icon}
                                      alt={trade.title}
                                      className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg border border-slate-800 object-cover"
                                    />
                                  ) : (
                                    <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg border border-slate-800 bg-slate-800" />
                                  )}
                                  <div className="space-y-0.5 sm:space-y-1 pb-1">
                                    <p className="text-xs sm:text-sm text-gray-400">
                                      {formatTradeTimestamp(trade.timestamp)}
                                    </p>
                                    <p
                                      className={`text-[0.65rem] sm:text-xs font-semibold ${trade.side === 'BUY' ? 'text-emerald-300' : 'text-rose-300'}`}
                                    >
                                      {trade.side}
                                    </p>
                                  </div>
                                </div>

                                <div className="flex-1">
                                  <h4 className="text-sm sm:text-base font-semibold">{trade.title}</h4>
                                  <div className="mt-1 flex flex-wrap items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
                                    <span className="text-[0.65rem] uppercase tracking-[0.3em] text-gray-500">
                                      Pick
                                    </span>
                                    <span
                                      className={`inline-flex max-w-full items-center gap-1.5 sm:gap-2 rounded-full border px-2 sm:px-3 py-0.5 sm:py-1 text-[0.65rem] sm:text-xs font-semibold ${trade.side === 'BUY' ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-200' : 'border-rose-500/40 bg-rose-500/5 text-rose-200'}`}
                                    >
                                      <span
                                        className={`h-1.5 w-1.5 rounded-full ${trade.side === 'BUY' ? 'bg-emerald-300' : 'bg-rose-300'}`}
                                      />
                                      <span className="truncate">{trade.outcome || 'Outcome'}</span>
                                    </span>
                                  </div>
                                </div>

                                <div className="flex items-center gap-3 sm:gap-4 md:gap-6 text-xs sm:text-sm text-gray-300">
                                  <div>
                                    <p className="text-[0.65rem] sm:text-xs uppercase tracking-wide text-gray-500">
                                      Size
                                    </p>
                                    <p className="font-semibold">
                                      {numberFormatter.format(trade.size)}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-[0.65rem] sm:text-xs uppercase tracking-wide text-gray-500">
                                      Price
                                    </p>
                                    <p className="font-semibold">
                                      {numberFormatter.format(trade.price)}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-[0.65rem] sm:text-xs uppercase tracking-wide text-gray-500">
                                      Notional
                                    </p>
                                    <p className="font-semibold">
                                      {currencyFormatter.format(trade.size * trade.price)}
                                    </p>
                                  </div>
                                </div>

                                {trade.transactionHash && (
                                  <a
                                    href={`https://polygonscan.com/tx/${trade.transactionHash}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-cyan-400 text-xs sm:text-sm hover:underline"
                                  >
                                    View tx →
                                  </a>
                                )}
                              </li>
                            ))}
                          </ul>

                          {hasMoreTrades && (
                            <>
                              <div className="px-3 sm:px-4 md:px-6 py-2.5 sm:py-3 md:py-4 border-t border-slate-800/80 flex flex-col items-center gap-1.5 sm:gap-2">
                                <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">
                                  Showing {displayedTrades.length} of {trades.length} fills
                                </p>
                                <button
                                  type="button"
                                  onClick={loadMoreTrades}
                                  className="text-xs sm:text-sm text-cyan-300 hover:text-cyan-200 transition-colors"
                                >
                                  Load more fills
                                </button>
                              </div>
                              <div
                                ref={loadMoreTriggerRef}
                                aria-hidden="true"
                                className="h-6 sm:h-8"
                              />
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </section>
              ) : (
                <section className="bg-slate-950/70 border border-slate-800/80 rounded-lg sm:rounded-xl md:rounded-2xl p-4 sm:p-6 md:p-8 text-center space-y-2 sm:space-y-3 shadow-lg shadow-black/20">
                  <h2 className="text-lg sm:text-xl md:text-2xl font-semibold">Add a wallet to start tracking</h2>
                  <p className="text-xs sm:text-sm md:text-base text-gray-400">
                    Use the form on the left to add a Polymarket proxy wallet. Once it's tracked, you'll see every open and closed market here.
                  </p>
                </section>
              )}
            </main>
          </div>
        </div>
        {isAddWalletModalOpen && (
          <AddWalletModal
            trackingForm={trackingForm}
            onTrackingFormChange={setTrackingForm}
            onSubmit={handleAddTrackedWallet}
            isAdding={isAddingWallet}
            error={trackingError}
            onClose={() => setIsAddWalletModalOpen(false)}
          />
        )}
        {isWalletManagerOpen && (
          <ManageWalletsModal
            trackedWallets={trackedWallets}
            selectedWallet={selectedWallet}
            onSelectWallet={setSelectedWallet}
            walletStats={walletStats}
            onDeleteWatcher={handleWatcherDelete}
            onOpenAddWallet={() => setIsAddWalletModalOpen(true)}
            onClose={() => setIsWalletManagerOpen(false)}
          />
        )}
      </div>
    </div>
  )
}

function ManageWalletsModal({
  trackedWallets,
  selectedWallet,
  onSelectWallet,
  walletStats,
  onDeleteWatcher,
  onOpenAddWallet,
  onClose,
}: {
  trackedWallets: TrackedWalletRow[]
  selectedWallet: string | null
  onSelectWallet: (wallet: string) => void
  walletStats: Record<string, WalletStatsSummary>
  onDeleteWatcher: (watcherId: string, walletAddress?: string) => void
  onOpenAddWallet: () => void
  onClose: () => void
}) {
  const normalizedSelection = selectedWallet?.toLowerCase()
  const topWalletKey = useMemo(
    () => getTopWalletKey(trackedWallets, walletStats),
    [trackedWallets, walletStats],
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-3 sm:px-4 py-4 sm:py-8">
      <div className="w-full max-w-3xl rounded-xl sm:rounded-2xl md:rounded-3xl border border-slate-800/80 bg-slate-950/95 p-4 sm:p-5 md:p-6 shadow-2xl shadow-cyan-500/20">
        <div className="flex items-center justify-between gap-2 sm:gap-3">
          <div>
            <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">Tracked wallets</p>
            <h2 className="text-lg sm:text-xl md:text-2xl font-semibold">Manage the board</h2>
            <p className="text-xs sm:text-sm text-gray-400">
              Tap a wallet to inspect it, or remove entries you no longer want to monitor.
            </p>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={() => {
                onClose()
                onOpenAddWallet()
              }}
              className="inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-slate-800 px-2 sm:px-3 py-1 text-[0.65rem] sm:text-xs font-semibold text-gray-200 hover:border-cyan-400"
            >
              <Plus className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              Add
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-slate-800 p-1.5 sm:p-2 text-gray-400 hover:border-cyan-400 hover:text-cyan-200"
              aria-label="Close wallet manager"
            >
              X
            </button>
          </div>
        </div>

        <div className="mt-4 sm:mt-5 md:mt-6 space-y-2 sm:space-y-3 max-h-[65vh] overflow-y-auto pr-1">
          {trackedWallets.length === 0 ? (
            <p className="text-xs sm:text-sm text-gray-400">
              No wallets yet. Use the add button to bring your first trader onto the board.
            </p>
          ) : (
            trackedWallets.map((wallet) => {
              const key = wallet.walletAddress.toLowerCase()
              const stats = walletStats[key] ?? EMPTY_WALLET_STATS
              const isActive = normalizedSelection === key
              const highlight = pickWalletHighlight(stats, {
                isTopPerformer: topWalletKey === key,
              })
              return (
                <button
                  type="button"
                  key={wallet.walletAddress}
                  onClick={() => {
                    onSelectWallet(wallet.walletAddress)
                    onClose()
                  }}
                  className={`w-full rounded-lg sm:rounded-xl md:rounded-2xl border px-3 sm:px-4 py-2 sm:py-3 text-left transition ${isActive
                      ? 'border-cyan-400 bg-cyan-500/10'
                      : 'border-slate-800/80 bg-slate-900/60 hover:border-cyan-400/60'
                    }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm sm:text-base font-semibold text-white flex items-center gap-1.5">
                        <span>
                          {wallet.nickname || formatWalletAddress(wallet.walletAddress)}
                        </span>
                        {highlight && <WalletHighlightBadge highlight={highlight} />}
                      </p>
                      <p className="text-[0.65rem] sm:text-xs text-gray-500">
                        {wallet.nickname ? formatWalletAddress(wallet.walletAddress) : 'Tracked wallet'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onDeleteWatcher(wallet.watcherId, wallet.walletAddress)
                      }}
                      className="rounded-full border border-transparent p-1 text-gray-500 hover:border-rose-400 hover:text-rose-300"
                      aria-label="Remove wallet"
                    >
                      <Trash2 className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                    </button>
                  </div>
                  <div className="mt-2 sm:mt-3 flex items-center justify-between text-[0.65rem] sm:text-xs text-gray-400">
                    <span>
                      Record {`${stats.allTime.wins}-${stats.allTime.losses}-${stats.allTime.ties}`}
                    </span>
                    <span>{formatUsdCompact(stats.allTime.pnlUsd)}</span>
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
const DEFAULT_ALERT_THRESHOLD_COPY = formatUsdCompact(50_000)

function AlertCenter({
  watchers,
  canEdit,
  alertError,
  onRunScan,
  isScanning,
  alertHistory,
  onTestNotification,
  isTestingNotification,
}: {
  watchers: WatcherRule[]
  canEdit: boolean
  alertError: string | null
  onRunScan: () => void
  isScanning: boolean
  alertHistory: AlertEventRecord[]
  onTestNotification: () => void
  isTestingNotification: boolean
}) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const latestAlert = alertHistory[0]

  return (
    <section className="rounded-lg sm:rounded-xl md:rounded-2xl border border-slate-800/80 bg-slate-950/80 backdrop-blur-sm shadow-lg shadow-black/20 p-3 sm:p-4 md:p-5 space-y-3 sm:space-y-4 md:space-y-5">
      <div className="flex flex-col gap-2 sm:gap-3">
        <div>
          <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">Alert center</p>
          <h2 className="text-base sm:text-lg md:text-xl font-semibold">Push alerts for big swings</h2>
          <p className="text-xs sm:text-sm text-gray-400">
            Every tracked wallet auto-pings once its open exposure crosses {DEFAULT_ALERT_THRESHOLD_COPY}.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={onRunScan}
            disabled={!canEdit || isScanning || watchers.length === 0}
            className="inline-flex items-center justify-center gap-1.5 sm:gap-2 rounded-lg sm:rounded-xl border border-slate-800 px-2.5 sm:px-3 md:px-4 py-1.5 sm:py-2 text-xs sm:text-sm text-gray-200 hover:border-cyan-400 disabled:opacity-50"
          >
            <BellRing className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${isScanning ? 'animate-pulse' : ''}`} />
            {isScanning ? 'Scanning…' : 'Manual scan'}
          </button>
          <button
            type="button"
            onClick={onTestNotification}
            disabled={isTestingNotification}
            className="inline-flex items-center justify-center gap-1.5 sm:gap-2 rounded-lg sm:rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-2.5 sm:px-3 md:px-4 py-1.5 sm:py-2 text-xs sm:text-sm text-cyan-200 hover:border-cyan-400 hover:bg-cyan-500/20 disabled:opacity-50"
          >
            {isTestingNotification ? (
              <>
                <Loader2 className="h-3.5 w-3.5 sm:h-4 sm:w-4 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <BellRing className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                Test notification
              </>
            )}
          </button>
        </div>
      </div>

      <div className="rounded-lg sm:rounded-xl border border-slate-800/80 bg-slate-950/50 px-3 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-gray-300">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>
            Tracking{' '}
            <span className="font-semibold text-white">{watchers.length}</span>{' '}
            wallet{watchers.length === 1 ? '' : 's'} for alerts.
          </p>
          <div className="flex items-center gap-1.5 sm:gap-2 text-[0.65rem] sm:text-xs uppercase tracking-[0.2em] text-gray-500">
            <Settings className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
            Automatic
          </div>
        </div>
        {!canEdit && (
          <p className="mt-1 text-[0.65rem] sm:text-xs text-gray-500">
            Select a wallet to enable manual scans from this device.
          </p>
        )}
      </div>

      {alertError && (
        <div className="rounded-xl border border-rose-800 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
          {alertError}
        </div>
      )}

      {latestAlert ? (
        <div className="space-y-1.5 sm:space-y-2 rounded-lg sm:rounded-xl border border-slate-800/80 bg-slate-950/60 p-2.5 sm:p-3 md:p-4">
          <div className="flex items-center justify-between gap-2 sm:gap-3">
            <div>
              <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">Latest alert</p>
              <p className="text-xs sm:text-sm font-semibold text-white">
                {latestAlert.nickname || formatWalletAddress(latestAlert.walletAddress)}
              </p>
            </div>
            <span className="text-[0.65rem] sm:text-xs text-gray-500">
              {new Date(latestAlert.triggeredAt * 1000).toLocaleString()}
            </span>
          </div>
          <p className="text-xs sm:text-sm text-gray-300">
            {latestAlert.triggerType === 'single'
              ? 'Position threshold'
              : latestAlert.triggerType === 'position_step'
                ? 'Position step'
                : 'Rolling window'}{' '}
            · {formatUsdCompact(latestAlert.triggerValue)} · {latestAlert.tradeCount} trade
            {latestAlert.tradeCount === 1 ? '' : 's'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg sm:rounded-xl border border-dashed border-slate-800/80 bg-slate-950/50 px-3 sm:px-4 py-2 sm:py-3 text-[0.65rem] sm:text-xs text-gray-400">
          No alerts sent yet. Once a tracked wallet crosses the threshold we&apos;ll ping you automatically.
        </div>
      )}

      {alertHistory.length > 0 && (
        <button
          type="button"
          onClick={() => setHistoryOpen((previous) => !previous)}
          className="text-xs font-semibold text-cyan-300 hover:text-cyan-200"
        >
          {historyOpen ? 'Hide alert history' : `View alert history (${alertHistory.length})`}
        </button>
      )}
      {historyOpen && <AlertHistoryList alertHistory={alertHistory} />}
    </section>
  )
}

function AlertHistoryList({ alertHistory }: { alertHistory: AlertEventRecord[] }) {
  if (alertHistory.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-900/70 bg-slate-950/40 px-4 py-3 text-xs text-gray-400">
        No alerts triggered yet. Once a tracked wallet trips the threshold we&apos;ll log it here and fire a Pusher event automatically.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[0.65rem] uppercase tracking-[0.3em] text-gray-500">
        <Clock className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
        Recent alerts
      </div>
      <ul className="divide-y divide-slate-800/80 rounded-lg sm:rounded-xl md:rounded-2xl border border-slate-800/80 bg-slate-950/50">
        {alertHistory.map((alert) => {
          const pricedTrades = alert.trades.filter(
            (trade) => (trade.size ?? 0) * (trade.price ?? 0) > 0,
          )
          return (
            <li key={alert.id} className="p-3 sm:p-4 text-xs sm:text-sm text-gray-300 space-y-1.5 sm:space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[0.65rem] sm:text-xs tracking-wide text-gray-500">
                    {alert.nickname || formatWalletAddress(alert.walletAddress)}
                  </p>
                  <p className="text-xs sm:text-sm font-semibold text-white capitalize">
                    {alert.triggerType === 'single'
                      ? 'Position threshold'
                      : alert.triggerType === 'position_step'
                        ? 'Position step'
                        : 'Rolling window'}{' '}
                    · {formatUsdCompact(alert.triggerValue)}
                  </p>
                </div>
                <span className="text-[0.65rem] sm:text-xs text-gray-500">
                  {new Date(alert.triggeredAt * 1000).toLocaleString()}
                </span>
              </div>
              <div className="text-[0.65rem] sm:text-xs text-gray-400">
                {alert.tradeCount} trade{alert.tradeCount === 1 ? '' : 's'} in payload.
              </div>
              {pricedTrades.length > 0 && (
                <div className="rounded-lg border border-slate-800/80 bg-slate-950/40 p-2 text-[0.65rem] sm:text-[0.7rem] uppercase tracking-[0.2em] text-gray-500">
                  {pricedTrades.slice(0, 3).map((trade, index) => (
                    <p key={`${alert.id}-${trade.transactionHash ?? index}`}>
                      {trade.title ?? 'Market'}
                    </p>
                  ))}
                  {pricedTrades.length > 3 && (
                    <p className="text-cyan-400">
                      +{pricedTrades.length - 3} more fills
                    </p>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function WalletHighlightBadge({ highlight }: { highlight: WalletHighlight }) {
  const { Icon, badgeClass, label, detail } = highlight
  return (
    <span
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[0.65rem] ${badgeClass}`}
      title={`${label}: ${detail}`}
      aria-label={`${label}: ${detail}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  )
}

function SportEdgeBadge({ edge }: { edge: WalletSportEdge }) {
  const detail = `${edge.label} edge · ${edge.wins}-${edge.losses}-${edge.ties} · ${Math.round(edge.winRate * 100)}% WR · ${formatUsdCompact(edge.pnlUsd)}`
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-emerald-400/60 bg-emerald-500/10 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-emerald-200"
      title={detail}
    >
      <Target className="h-3 w-3" aria-hidden="true" />
      {edge.label} edge
    </span>
  )
}

function SportEdgeIndicator({
  edge,
  align = 'left',
}: {
  edge: WalletSportEdge
  align?: 'left' | 'right'
}) {
  const detail = `${edge.wins}-${edge.losses}-${edge.ties} · ${Math.round(
    edge.winRate * 100,
  )}% WR · ${formatUsdCompact(edge.pnlUsd)}`
  return (
    <div className={`mt-1.5 ${align === 'right' ? 'text-right' : ''}`}>
      <SportEdgeBadge edge={edge} />
      <p className="mt-0.5 text-[0.55rem] text-emerald-100 tracking-wide">{detail}</p>
    </div>
  )
}

function ConfidenceMeter({ confidence }: { confidence: WalletPositionConfidence }) {
  const meta = CONFIDENCE_META[confidence.level]
  const pct = Math.round(confidence.score * 100)
  return (
    <div className="mt-1.5">
      <div className={`flex items-center justify-between text-[0.6rem] uppercase tracking-[0.2em] ${meta.textClass}`}>
        <span className="font-semibold">{meta.label}</span>
        <span>{pct}%</span>
      </div>
      <div className="mt-0.5 h-1.5 md:h-1 w-full rounded-full bg-slate-900/60">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${meta.barClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {confidence.reasons.length > 0 && (
        <p className="mt-0.5 text-[0.6rem] text-gray-500">
          {confidence.reasons[0]}
        </p>
      )}
    </div>
  )
}

function WhaleMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 32"
      className={className}
      role="img"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="whaleBody" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="50%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#818cf8" />
        </linearGradient>
      </defs>
      <path
        d="M6 18c0-6 5-11 13-11h16c9 0 17 6 17 13s-8 12-17 12H22C13 32 6 27 6 21v-3z"
        fill="url(#whaleBody)"
        opacity="0.85"
      />
      <path
        d="M52 12c4 0 6-2 10-2-2 4-2 8 0 12-4 0-6-2-10-2"
        fill="url(#whaleBody)"
        opacity="0.85"
      />
      <path
        d="M24 9c0-2 2-4 4-4-1 1-1 3 1 4"
        stroke="#a5f3fc"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="23" cy="18" r="1" fill="#0f172a" />
      <path
        d="M18 22c3 3 10 4 16 1"
        stroke="#0f172a"
        strokeOpacity="0.35"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function SizingBadge({
  initialValue,
  averageSize,
}: {
  initialValue: number
  averageSize?: number
}) {
  const sizing = getSizingSignal(initialValue, averageSize)
  if (!sizing) {
    return null
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.55rem] font-semibold uppercase tracking-[0.2em] ${sizing.badgeClass}`}
      title={`${sizing.label} · ${sizing.detail}`}
    >
      <Target className="h-3 w-3" aria-hidden="true" />
      <span>{sizing.label}</span>
      <span className="tracking-[0.15em] text-white/80">{sizing.detail}</span>
    </span>
  )
}

function WalletSummaryList({
  trackedWallets,
  walletStats,
  onSelectWallet,
  selectedWallet,
}: {
  trackedWallets: TrackedWalletRow[]
  walletStats: Record<string, WalletStatsSummary>
  onSelectWallet: (wallet: string) => void
  selectedWallet: string | null
}) {
  const [collapsed, setCollapsed] = useState(() => {
    // Collapse by default on mobile (below sm breakpoint which is 640px)
    if (typeof window !== 'undefined') {
      return window.innerWidth < 640
    }
    return false
  })
  const topWalletKey = useMemo(
    () => getTopWalletKey(trackedWallets, walletStats),
    [trackedWallets, walletStats],
  )

  if (trackedWallets.length === 0) {
    return (
      <section className="rounded-lg sm:rounded-xl md:rounded-2xl border border-dashed border-slate-800/80 bg-slate-950/60 p-4 sm:p-5 md:p-6 text-center text-xs sm:text-sm text-gray-400">
        No wallets yet. Use the add button above to start building the board.
      </section>
    )
  }

  const sortedWallets = [...trackedWallets].sort((a, b) => {
    const aKey = a.walletAddress.toLowerCase()
    const bKey = b.walletAddress.toLowerCase()
    const aPnl = walletStats[aKey]?.allTime.pnlUsd ?? 0
    const bPnl = walletStats[bKey]?.allTime.pnlUsd ?? 0
    return bPnl - aPnl
  })
  const glanceBuckets: Array<{ key: WalletStatsBucketKey; label: string }> = [
    { key: 'daily', label: 'Daily' },
    { key: 'weekly', label: 'Weekly' },
    { key: 'monthly', label: 'Monthly' },
  ]

  return (
    <section className="rounded-lg sm:rounded-xl md:rounded-2xl border border-slate-800/80 bg-slate-950/80 backdrop-blur-sm shadow-lg shadow-black/20 overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800/80 px-3 sm:px-4 md:px-5 py-2.5 sm:py-3 md:py-4">
        <div>
          <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">Performance board</p>
          <h2 className="text-base sm:text-lg md:text-xl font-semibold">Tracked wallets</h2>
          <p className="text-[0.65rem] sm:text-xs text-gray-500">Tap a wallet to load the deep-dive pane.</p>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((previous) => !previous)}
          className="text-[0.65rem] sm:text-xs font-semibold text-gray-400 hover:text-cyan-200"
        >
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </div>
      {!collapsed && (
        <ul className="divide-y divide-slate-800/80">
          {sortedWallets.map((wallet, index) => {
            const key = wallet.walletAddress.toLowerCase()
            const stats = walletStats[key] ?? EMPTY_WALLET_STATS
            const isSelected =
              selectedWallet?.toLowerCase() === wallet.walletAddress.toLowerCase()
            const allTimePnl = stats.allTime.pnlUsd
            const pnlPositive = allTimePnl >= 0
            const record = `${stats.allTime.wins}-${stats.allTime.losses}-${stats.allTime.ties}`
            const highlight = pickWalletHighlight(stats, {
              isTopPerformer: topWalletKey === key,
            })

            return (
              <li key={wallet.watcherId}>
                <button
                  type="button"
                  onClick={() => onSelectWallet(wallet.walletAddress)}
                  className={`w-full px-3 sm:px-4 md:px-5 py-2.5 sm:py-3 md:py-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${isSelected
                      ? 'bg-cyan-500/8 ring-1 ring-cyan-400/50'
                      : 'hover:bg-slate-900/50'
                    }`}
                >
                  <div className="flex items-center justify-between gap-2 sm:gap-3">
                    <div className="flex items-center gap-2 sm:gap-3">
                      <span className="text-[0.6rem] uppercase tracking-[0.3em] text-gray-500">
                        #{index + 1}
                      </span>
                      <div>
                        <p className="text-xs sm:text-sm font-semibold text-white flex items-center gap-1.5">
                          <span>
                            {wallet.nickname || formatWalletAddress(wallet.walletAddress)}
                          </span>
                          {highlight && <WalletHighlightBadge highlight={highlight} />}
                        </p>
                        <p className="text-[0.65rem] sm:text-xs text-gray-500">
                          {wallet.nickname
                            ? formatWalletAddress(wallet.walletAddress)
                            : 'Tracked wallet'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">All-time</p>
                      <p className="text-[0.65rem] sm:text-xs text-gray-400">{record}</p>
                      <p
                        className={`text-xs sm:text-sm font-semibold ${pnlPositive ? 'text-emerald-300' : 'text-rose-300'
                          }`}
                      >
                        {pnlPositive ? '+' : '-'}
                        {formatUsdCompact(Math.abs(allTimePnl))}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 sm:mt-3 flex flex-col gap-1 sm:gap-1.5">
                    {glanceBuckets.map(({ key: bucketKey, label }) => {
                      const bucket = stats[bucketKey]
                      const bucketPositive = bucket.pnlUsd >= 0
                      return (
                        <div
                          key={`${wallet.walletAddress}-${bucketKey}`}
                          className={`flex items-center gap-1.5 text-[0.65rem] sm:text-xs ${bucketPositive
                              ? 'text-emerald-200'
                              : 'text-rose-200'
                            }`}
                        >
                          <span className="uppercase tracking-[0.2em] text-gray-500">{label}:</span>
                          <span className="font-semibold">
                            {bucketPositive ? '+' : '-'}
                            {formatUsdCompact(Math.abs(bucket.pnlUsd))}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function buildPolymarketUrl(eventSlug?: string, slug?: string): string | null {
  if (!eventSlug && !slug) {
    return null
  }
  // If we have both, use the full path: /event/{eventSlug}/{slug}
  if (eventSlug && slug) {
    return `https://polymarket.com/event/${eventSlug}/${slug}`
  }
  // If we only have eventSlug, link to the event page
  if (eventSlug) {
    return `https://polymarket.com/event/${eventSlug}`
  }
  // If we only have slug, try to construct a link (less common)
  if (slug) {
    return `https://polymarket.com/event/${slug}`
  }
  return null
}

function calculateOppositionBalance(
  outcomes: Array<{
    outcome: string
    visibleTotalInitialValue: number
    visibleWallets: AggregatedWalletPosition[]
  }>,
): OppositionBalanceSnapshot | null {
  const totals = outcomes
    .map((outcome) => ({
      label: outcome.outcome,
      amount: Math.max(outcome.visibleTotalInitialValue, 0),
      wallets: outcome.visibleWallets,
    }))
    .filter((entry) => entry.amount > 0)

  if (totals.length < 2) {
    return null
  }

  const totalAmount = totals.reduce((sum, entry) => sum + entry.amount, 0)
  if (totalAmount <= 0) {
    return null
  }

  const primary = totals[0]
  const restAmount = Math.max(totalAmount - primary.amount, 0)
  const hasOnlyTwoSides = totals.length === 2
  const secondaryAmount = hasOnlyTwoSides ? totals[1].amount : restAmount
  const secondaryLabel = hasOnlyTwoSides ? totals[1].label : 'Others'
  const secondaryWallets = hasOnlyTwoSides ? totals[1].wallets : totals.slice(1).flatMap((entry) => entry.wallets)

  const aggregateSide = (wallets: AggregatedWalletPosition[]) => {
    let unitSum = 0
    let confidenceSum = 0
    let maxClipCount = 0
    wallets.forEach((wallet) => {
      if (wallet.averageSize && wallet.averageSize > 0) {
        const ratio = wallet.initialValue / wallet.averageSize
        if (Number.isFinite(ratio)) {
          unitSum += ratio
          if (ratio >= 2.5) {
            maxClipCount += 1
          }
        }
      }
      if (wallet.confidence) {
        confidenceSum += wallet.confidence.score
      }
    })
    return {
      unitSum,
      confidenceAverage: wallets.length > 0 ? confidenceSum / wallets.length : 0,
      maxClipCount,
    }
  }

  const primaryAgg = aggregateSide(primary.wallets)
  const secondaryAgg = aggregateSide(secondaryWallets)
  const totalUnits = primaryAgg.unitSum + secondaryAgg.unitSum
  const primaryUnitShare = totalUnits > 0 ? primaryAgg.unitSum / totalUnits : 0
  const secondaryUnitShare = totalUnits > 0 ? secondaryAgg.unitSum / totalUnits : 0
  const primaryShare = Math.round((primary.amount / totalAmount) * 100) / 100
  const secondaryShare = Math.round((secondaryAmount / totalAmount) * 100) / 100
  const moneyEdge = primaryShare - secondaryShare
  const unitEdge = primaryUnitShare - secondaryUnitShare
  const confidenceEdge = primaryAgg.confidenceAverage - secondaryAgg.confidenceAverage

  let callout: OppositionBalanceSnapshot['callout'] = 'mixed'
  if (moneyEdge >= 0.15 && unitEdge >= 0.1 && confidenceEdge >= 0.1) {
    callout = 'money'
  } else if (unitEdge >= 0.15 && moneyEdge < 0.1) {
    callout = 'units'
  } else if (confidenceEdge >= 0.1 && moneyEdge < 0.1) {
    callout = 'conviction'
  } else if (moneyEdge >= 0.15) {
    callout = 'money'
  }

  return {
    primaryLabel: primary.label,
    secondaryLabel,
    primaryAmount: primary.amount,
    secondaryAmount,
    primaryShare,
    secondaryShare,
    totalAmount,
    callout,
    primaryUnitShare,
    secondaryUnitShare,
    primaryConfidence: primaryAgg.confidenceAverage,
    secondaryConfidence: secondaryAgg.confidenceAverage,
    primaryMaxClipCount: primaryAgg.maxClipCount,
    secondaryMaxClipCount: secondaryAgg.maxClipCount,
  }
}

/**
 * Get styling for holder based on rank and amount
 */
function getHolderStyle(rank: number, amount: number): {
  rowClass: string
  amountClass: string
  rankBadge: { emoji: string; class: string } | null
} {
  // Rank badges for top 3
  const rankBadges: Record<number, { emoji: string; class: string }> = {
    0: { emoji: '🥇', class: 'bg-amber-500/20 border-amber-400/50' },
    1: { emoji: '🥈', class: 'bg-slate-400/20 border-slate-300/50' },
    2: { emoji: '🥉', class: 'bg-orange-600/20 border-orange-400/50' },
  }

  // Amount-based color coding
  let amountClass = 'text-gray-400' // Default
  if (amount >= 100_000) {
    amountClass = 'text-cyan-300 font-bold'
  } else if (amount >= 50_000) {
    amountClass = 'text-emerald-300 font-bold'
  } else if (amount >= 25_000) {
    amountClass = 'text-amber-300 font-semibold'
  } else if (amount >= 10_000) {
    amountClass = 'text-gray-200 font-semibold'
  }

  // Row highlight for top holders
  let rowClass = 'hover:bg-slate-800/40'
  if (rank === 0) {
    rowClass = 'bg-amber-500/10 hover:bg-amber-500/15 border border-amber-400/30'
  } else if (rank === 1) {
    rowClass = 'bg-slate-400/10 hover:bg-slate-400/15 border border-slate-400/20'
  } else if (rank === 2) {
    rowClass = 'bg-orange-500/10 hover:bg-orange-500/15 border border-orange-400/20'
  } else if (amount >= 100_000) {
    rowClass = 'bg-cyan-500/5 hover:bg-cyan-500/10'
  } else if (amount >= 50_000) {
    rowClass = 'bg-emerald-500/5 hover:bg-emerald-500/10'
  }

  return {
    rowClass,
    amountClass,
    rankBadge: rankBadges[rank] ?? null,
  }
}

/**
 * Get sizing context for a holder's position relative to their trading volume
 * Volume is a much better baseline than PnL since PnL can be near zero for active traders
 */
function getHolderSizingContext(
  positionAmount: number,
  volume: number | undefined,
): {
  volumePercent: number
  totalVolume: number
  conviction: 'whale' | 'high' | 'medium' | 'notable' | null
} | null {
  if (!positionAmount || positionAmount <= 0) return null
  if (!volume || volume <= 0) return null

  const volumePercent = (positionAmount / volume) * 100

  // Conviction based on % of all-time volume
  // Higher % = this is a bigger bet relative to their typical activity
  let conviction: 'whale' | 'high' | 'medium' | 'notable' | null = null
  if (volumePercent >= 15) {
    conviction = 'whale' // Massive position for them
  } else if (volumePercent >= 8) {
    conviction = 'high' // Very significant bet
  } else if (volumePercent >= 4) {
    conviction = 'medium' // Notable bet
  } else if (volumePercent >= 2) {
    conviction = 'notable' // Worth noting
  }

  return {
    volumePercent,
    totalVolume: volume,
    conviction,
  }
}

/**
 * Component to display top holders for a market
 */
function TopHoldersDisplay({
  holders,
  isLoading,
  outcomes,
}: {
  holders: MarketHoldersResponse[] | undefined
  isLoading: boolean
  outcomes: string[]
}) {
  const [holderPnl, setHolderPnl] = useState<Record<string, UserPnlStats>>({})
  const [loadingPnl, setLoadingPnl] = useState(false)
  const fetchedPnlRef = useRef<Set<string>>(new Set())

  // Group holders by outcome index
  const holdersByOutcome = useMemo(() => {
    if (!holders || holders.length === 0) return new Map<number, MarketHolder[]>()
    
    const grouped = new Map<number, MarketHolder[]>()
    for (const tokenData of holders) {
      for (const holder of tokenData.holders) {
        const outcomeIdx = holder.outcomeIndex ?? 0
        if (!grouped.has(outcomeIdx)) {
          grouped.set(outcomeIdx, [])
        }
        grouped.get(outcomeIdx)!.push(holder)
      }
    }
    // Sort holders by amount descending within each outcome
    grouped.forEach((holderList) => {
      holderList.sort((a, b) => b.amount - a.amount)
    })
    return grouped
  }, [holders])

  // Fetch PnL for top 5 holders on each side
  useEffect(() => {
    if (!holders || holders.length === 0 || loadingPnl) return

    // Get top 5 wallet addresses from each side
    const walletsToFetch: string[] = []
    holdersByOutcome.forEach((holderList) => {
      const top5 = holderList.slice(0, 5)
      for (const holder of top5) {
        if (!fetchedPnlRef.current.has(holder.proxyWallet)) {
          walletsToFetch.push(holder.proxyWallet)
          fetchedPnlRef.current.add(holder.proxyWallet)
        }
      }
    })

    if (walletsToFetch.length === 0) return

    setLoadingPnl(true)
    fetchBatchUserPnlFn({ data: { walletAddresses: walletsToFetch } })
      .then((response) => {
        if (response.results) {
          setHolderPnl((prev) => ({ ...prev, ...response.results }))
        }
      })
      .catch((error) => {
        console.warn('Failed to fetch holder PnL:', error)
      })
      .finally(() => {
        setLoadingPnl(false)
      })
  }, [holders, holdersByOutcome, loadingPnl])

  if (isLoading) {
    return (
      <div className="mt-4 flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
        <span className="ml-2 text-sm text-gray-400">Loading holders...</span>
      </div>
    )
  }

  if (!holders || holders.length === 0) {
    return (
      <div className="mt-4 text-center py-4 text-sm text-gray-500">
        No holder data available for this market.
      </div>
    )
  }

  // Map outcome indices to labels - try to match with market outcomes
  const getOutcomeLabel = (index: number): string => {
    // Polymarket mapping: outcomeIndex 0 = Yes (first outcome), 1 = No (second outcome)
    if (outcomes.length > 0) {
      if (index === 0) {
        return outcomes.find((o) => o.toLowerCase() === 'yes') ?? outcomes[0] ?? 'Yes'
      }
      if (index === 1) {
        return outcomes.find((o) => o.toLowerCase() === 'no') ?? outcomes[1] ?? 'No'
      }
    }
    return index === 0 ? 'Yes' : 'No'
  }

  const outcomeIndices = Array.from(holdersByOutcome.keys()).sort()

  return (
    <div className="mt-4 grid gap-3 sm:gap-4 md:grid-cols-2">
      {outcomeIndices.map((outcomeIdx) => {
        const outcomeHolders = holdersByOutcome.get(outcomeIdx) ?? []
        const outcomeLabel = getOutcomeLabel(outcomeIdx)
        const totalValue = outcomeHolders.reduce((sum, h) => sum + h.amount, 0)

        return (
          <div
            key={outcomeIdx}
            className="rounded-lg sm:rounded-xl border border-slate-800/50 bg-slate-900/30 p-3 sm:p-4"
          >
            <div className="mb-3 pb-2 border-b border-slate-800/40">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-300">{outcomeLabel} Holders</p>
                <p className="text-xs font-semibold text-cyan-400">{formatUsdCompact(totalValue)}</p>
              </div>
              <p className="text-xs text-gray-500">
                Top {Math.min(outcomeHolders.length, 10)} holders
                {loadingPnl && <span className="ml-2 text-cyan-400">• Loading stats...</span>}
              </p>
            </div>
            <ul className="space-y-1.5">
              {outcomeHolders.slice(0, 10).map((holder, idx) => {
                const style = getHolderStyle(idx, holder.amount)
                const pnlData = holderPnl[holder.proxyWallet]
                const showPnl = idx < 5 // Only show PnL for top 5
                const hasPnl = showPnl && pnlData?.pnl !== null && pnlData?.pnl !== undefined
                const pnlValue = pnlData?.pnl ?? 0
                const isProfitable = pnlValue >= 0
                const sizingContext = showPnl ? getHolderSizingContext(holder.amount, pnlData?.volume) : null

                return (
                  <li
                    key={`${holder.proxyWallet}-${idx}`}
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${style.rowClass}`}
                  >
                    {/* Rank badge or profile image */}
                    {style.rankBadge ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm">{style.rankBadge.emoji}</span>
                        {holder.profileImageOptimized || holder.profileImage ? (
                          <img
                            src={holder.profileImageOptimized || holder.profileImage}
                            alt=""
                            className={`h-6 w-6 rounded-full object-cover flex-shrink-0 border ${style.rankBadge.class}`}
                          />
                        ) : (
                          <div className={`h-6 w-6 rounded-full flex items-center justify-center flex-shrink-0 border ${style.rankBadge.class}`}>
                            <User className="h-3 w-3 text-gray-300" />
                          </div>
                        )}
                      </div>
                    ) : (
                      holder.profileImageOptimized || holder.profileImage ? (
                        <img
                          src={holder.profileImageOptimized || holder.profileImage}
                          alt=""
                          className="h-6 w-6 rounded-full object-cover flex-shrink-0 border border-slate-700"
                        />
                      ) : (
                        <div className="h-6 w-6 rounded-full bg-slate-700 flex items-center justify-center flex-shrink-0">
                          <User className="h-3 w-3 text-gray-400" />
                        </div>
                      )
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-gray-200 truncate">
                        {(() => {
                          const displayName = holder.displayUsernamePublic && holder.name
                            ? holder.name
                            : holder.pseudonym || holder.name
                          if (!displayName || displayName.startsWith('0x')) {
                            return formatWalletAddress(holder.proxyWallet)
                          }
                          return displayName
                        })()}
                      </p>
                      {/* Show PnL and sizing context for top 5 */}
                      {showPnl && (
                        <div className="mt-0.5 flex flex-wrap items-center gap-1">
                          {hasPnl ? (
                            <span
                              className={`inline-flex items-center gap-0.5 text-[0.6rem] font-semibold px-1.5 py-0.5 rounded ${
                                isProfitable
                                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                  : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                              }`}
                            >
                              {isProfitable ? '↑' : '↓'} {isProfitable ? '+' : ''}{formatUsdCompact(pnlValue)}
                            </span>
                          ) : loadingPnl ? (
                            <span className="inline-flex items-center gap-1 text-[0.6rem] text-gray-500">
                              <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            </span>
                          ) : (
                            <span className="text-[0.6rem] text-gray-600">No PnL data</span>
                          )}
                          {/* Sizing context - position relative to their total volume */}
                          {sizingContext?.conviction && (
                            <span
                              className={`inline-flex items-center text-[0.55rem] font-medium px-1.5 py-0.5 rounded ${
                                sizingContext.conviction === 'whale'
                                  ? 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30'
                                  : sizingContext.conviction === 'high'
                                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                                  : sizingContext.conviction === 'medium'
                                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                                  : 'bg-slate-500/20 text-slate-300 border border-slate-500/30'
                              }`}
                              title={`${sizingContext.volumePercent.toFixed(1)}% of ${formatUsdCompact(sizingContext.totalVolume)} total volume`}
                            >
                              {sizingContext.conviction === 'whale' && '🐋 '}
                              {sizingContext.volumePercent >= 10
                                ? `${Math.round(sizingContext.volumePercent)}%`
                                : `${sizingContext.volumePercent.toFixed(1)}%`}
                              {' of '}
                              {formatUsdCompact(sizingContext.totalVolume)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <span className={`text-xs flex-shrink-0 ${style.amountClass}`}>
                      {formatUsdCompact(holder.amount)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function SharedPositionsBoard({
  positions,
  walletSportEdges,
  onRefreshBoard,
  isRefreshing,
}: {
  positions: AggregatedMarketEntry[]
  walletSportEdges: WalletSportEdgeMap
  onRefreshBoard?: () => void
  isRefreshing?: boolean
}) {
  const [showRedeemable, setShowRedeemable] = useState(false)
  const [showSmallBets, setShowSmallBets] = useState(false)
  const SMALL_BET_THRESHOLD = 50_000

  // State for top holders feature
  const [expandedHolders, setExpandedHolders] = useState<Set<string>>(new Set())
  const [holdersCache, setHoldersCache] = useState<Map<string, MarketHoldersResponse[]>>(new Map())
  const [loadingHolders, setLoadingHolders] = useState<Set<string>>(new Set())

  const toggleHolders = useCallback(async (marketId: string, conditionId: string | undefined) => {
    if (!conditionId) return

    setExpandedHolders((prev) => {
      const next = new Set(prev)
      if (next.has(marketId)) {
        next.delete(marketId)
      } else {
        next.add(marketId)
      }
      return next
    })

    // Fetch holders if not cached and we're expanding
    if (!holdersCache.has(marketId) && !loadingHolders.has(marketId)) {
      setLoadingHolders((prev) => new Set(prev).add(marketId))
      try {
        const response = await fetchMarketHoldersFn({ data: { conditionId, limit: 20 } })
        if (response.holders) {
          setHoldersCache((prev) => new Map(prev).set(marketId, response.holders!))
        }
      } catch (error) {
        console.warn('Failed to fetch holders for market:', marketId, error)
      } finally {
        setLoadingHolders((prev) => {
          const next = new Set(prev)
          next.delete(marketId)
          return next
        })
      }
    }
  }, [holdersCache, loadingHolders])

  if (positions.length === 0) {
    return (
      <section className="rounded-lg sm:rounded-xl md:rounded-2xl border border-dashed border-slate-800/80 bg-slate-950/60 p-4 sm:p-5 md:p-6 text-center text-xs sm:text-sm text-gray-400">
        No overlapping exposure yet. Once tracked wallets enter the same markets, we&apos;ll summarize the risk here.
      </section>
    )
  }

  return (
    <section className="rounded-lg sm:rounded-xl md:rounded-2xl border border-slate-800/80 bg-slate-950/70 backdrop-blur-sm shadow-lg shadow-black/20 p-3 sm:p-4 md:p-6 space-y-4 sm:space-y-5 md:space-y-6">
      <div className="flex flex-col gap-2 sm:gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1 flex-1">
            <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">Shared exposure</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowRedeemable((prev) => !prev)}
              className="inline-flex items-center gap-1.5 sm:gap-2 rounded-lg sm:rounded-xl border border-slate-800/80 px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm text-gray-300 hover:border-cyan-400/60 hover:text-cyan-200 transition-colors flex-shrink-0"
              aria-label={showRedeemable ? 'Hide redeemable positions' : 'Show redeemable positions'}
            >
              {showRedeemable ? (
                <>
                  <EyeOff className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span>Hide redeemable</span>
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span>Show redeemable</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => setShowSmallBets((prev) => !prev)}
              className="inline-flex items-center gap-1.5 sm:gap-2 rounded-lg sm:rounded-xl border border-slate-800/80 px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm text-gray-300 hover:border-cyan-400/60 hover:text-cyan-200 transition-colors flex-shrink-0"
              aria-label={showSmallBets ? 'Hide small bets' : 'Show small bets'}
            >
              {showSmallBets ? (
                <>
                  <EyeOff className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span>Hide &lt; $50k</span>
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span>Show &lt; $50k</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
      <div className="space-y-4 sm:space-y-5">
        {positions
          .map((market) => {
            // Filter outcomes to only show those with visible wallets
            const visibleOutcomes = market.outcomes
              .map((outcome) => {
                const visibleWallets = outcome.wallets.filter(
                  (wallet) => showRedeemable || !wallet.redeemable,
                )
                return {
                  ...outcome,
                  visibleWallets,
                  visibleTotalValue: visibleWallets.reduce((sum, wallet) => sum + wallet.value, 0),
                  visibleTotalInitialValue: visibleWallets.reduce((sum, wallet) => sum + wallet.initialValue, 0),
                }
              })
              .filter((outcome) => outcome.visibleWallets.length > 0)

            // Only show market if it has at least one visible outcome
            if (visibleOutcomes.length === 0) {
              return null
            }

            const hasOpposition = visibleOutcomes.length > 1
            const visibleMarketTotal = visibleOutcomes.reduce(
              (sum, outcome) => sum + outcome.visibleTotalValue,
              0,
            )
            // Calculate total original bet amount for filtering and display
            const originalBetTotal = visibleOutcomes.reduce(
              (sum, outcome) => sum + outcome.visibleTotalInitialValue,
              0,
            )

            // Filter out small bets if toggle is off (use original bet amount for filtering)
            if (!showSmallBets && originalBetTotal < SMALL_BET_THRESHOLD) {
              return null
            }

            // Sort outcomes by initial value descending to ensure consistent order
            // This ensures the balance indicator aligns with the grid below
            const sortedVisibleOutcomes = [...visibleOutcomes].sort(
              (a, b) => b.visibleTotalInitialValue - a.visibleTotalInitialValue
            )

            return { market, visibleOutcomes: sortedVisibleOutcomes, hasOpposition, visibleMarketTotal, originalBetTotal }
          })
          .filter((item): item is { market: AggregatedMarketEntry; visibleOutcomes: Array<AggregatedOutcomeEntry & { visibleWallets: AggregatedWalletPosition[]; visibleTotalValue: number; visibleTotalInitialValue: number }>; hasOpposition: boolean; visibleMarketTotal: number; originalBetTotal: number } => item !== null)
          .map(({ market, visibleOutcomes, hasOpposition, originalBetTotal }) => {
            const oppositionBalance = hasOpposition
              ? calculateOppositionBalance(
                visibleOutcomes.map((outcome) => ({
                  outcome: outcome.outcome,
                  visibleTotalInitialValue: outcome.visibleTotalInitialValue,
                  visibleWallets: outcome.visibleWallets,
                })),
              )
              : null
            return (
              <div
                key={market.id}
                className={`rounded-lg sm:rounded-xl md:rounded-2xl border px-4 py-4 sm:px-5 sm:py-5 md:px-6 md:py-6 shadow-md shadow-black/10 transition-all ${hasOpposition
                    ? 'border-rose-400/50 bg-rose-400/5'
                    : 'border-slate-800/80 bg-slate-950/70 hover:border-slate-700/80'
                  }`}
              >
                {market.slug ? (
                  <div className="mb-4 sm:mb-5 pb-4 sm:pb-5 border-b border-slate-800/60">
                    {/* @ts-ignore - Polymarket web component */}
                    <polymarket-market-embed
                      market={market.slug}
                      volume="true"
                      chart="false"
                      theme="dark"
                      style={{ width: '100%', minHeight: '180px' }}
                    />
                  </div>
                ) : (
                  // Fallback header if no slug available
                  <div className="flex items-start gap-3 sm:gap-4 mb-4 sm:mb-5 pb-4 sm:pb-5 border-b border-slate-800/60">
                    {market.icon ? (
                      <img
                        src={market.icon}
                        alt={market.title}
                        className="h-10 w-10 sm:h-12 sm:w-12 md:h-14 md:w-14 rounded-lg border border-slate-800 object-cover flex-shrink-0"
                      />
                    ) : (
                      <div
                        className={`flex-shrink-0 p-2 rounded-lg ${hasOpposition
                            ? 'bg-rose-400/20 text-rose-300'
                            : 'bg-cyan-500/10 text-cyan-400'
                          }`}
                      >
                        {hasOpposition ? (
                          <AlertTriangle className="h-4 w-4 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                        ) : (
                          <TrendingUp className="h-4 w-4 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                        )}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base sm:text-lg md:text-xl font-semibold text-white leading-tight">
                        {market.title}
                      </h3>
                      {market.sportTag && (
                        <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-slate-800/70 bg-slate-900/70 px-2 py-0.5 text-[0.6rem] uppercase tracking-[0.2em] text-gray-300">
                          {getSportLabel(market.sportTag) ?? market.sportTag.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      {(() => {
                        const polymarketUrl = buildPolymarketUrl(market.eventSlug, market.slug)
                        return polymarketUrl ? (
                          <a
                            href={polymarketUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 rounded-md hover:bg-slate-800/60 transition-colors text-gray-400 hover:text-white"
                            aria-label="Open on Polymarket"
                          >
                            <ExternalLink className="h-4 w-4 sm:h-5 sm:w-5" />
                          </a>
                        ) : null
                      })()}
                    </div>
                  </div>
                )}
                {/* Show our wallet's total bet amount */}
                <div className="mb-4 sm:mb-5 pb-4 sm:pb-5 border-b border-slate-800/60 flex items-center justify-between">
                  <div>
                    <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500 mb-0.5">
                      Your Total Position
                    </p>
                    <p className="text-base sm:text-lg md:text-xl font-semibold text-white">
                      {formatUsdCompact(originalBetTotal)}
                    </p>
                  </div>
                  {onRefreshBoard && (
                    <button
                      type="button"
                      onClick={onRefreshBoard}
                      className="inline-flex items-center gap-1 rounded-full border border-slate-700 px-2 py-0.5 text-[0.6rem] uppercase tracking-[0.2em] text-gray-300 hover:border-cyan-400 hover:text-cyan-200"
                      disabled={isRefreshing}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                      {isRefreshing ? 'Refreshing' : 'Refresh'}
                    </button>
                  )}
                </div>
                {oppositionBalance && (
                  <div className="mb-4 sm:mb-5">
                    <OppositionBalanceIndicator balance={oppositionBalance} />
                  </div>
                )}

                <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
                  {visibleOutcomes.map((outcome) => {
                    const hasMultipleWallets = outcome.visibleWallets.length >= 2
                    const aggregateTotal = hasMultipleWallets
                      ? outcome.visibleWallets.reduce((sum, wallet) => sum + wallet.initialValue, 0)
                      : 0
                    return (
                      <div
                        key={`${market.id}-${outcome.outcome}`}
                        className="rounded-lg sm:rounded-xl border border-slate-800/70 bg-slate-950/60 p-3 sm:p-4 hover:border-slate-700/70 transition-colors"
                      >
                        <div className="mb-3 pb-2 border-b border-slate-800/50 flex items-center justify-between gap-2">
                          <p className="text-sm sm:text-base font-semibold text-white">{outcome.outcome}</p>
                          {hasMultipleWallets && (
                            <p className="text-xs sm:text-sm font-semibold text-gray-300">
                              {formatUsdCompact(aggregateTotal)}
                            </p>
                          )}
                        </div>
                        <ul className="space-y-2">
                          {outcome.visibleWallets.map((wallet) => {
                            const pnlPositive = wallet.pnl >= 0
                            const normalizedWalletAddress = wallet.walletAddress.toLowerCase()
                            const sportEdge =
                              market.sportTag
                                ? walletSportEdges
                                  .get(normalizedWalletAddress)
                                  ?.get(market.sportTag)
                                : undefined
                            return (
                              <li
                                key={`${wallet.walletAddress}-${market.id}-${outcome.outcome}`}
                                className="flex items-center justify-between gap-3 rounded-lg border border-slate-800/60 bg-slate-950/70 px-2.5 py-2 sm:px-3 sm:py-2.5 hover:border-slate-700/60 hover:bg-slate-950/80 transition-colors"
                              >
                                <div className="flex items-center gap-2 flex-1 min-w-0">
                                  <div
                                    className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${pnlPositive ? 'bg-emerald-400/60' : 'bg-rose-400/60'
                                      }`}
                                  />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs sm:text-sm font-semibold text-white truncate flex items-center gap-1.5">
                                      <span className="truncate">{wallet.label}</span>
                                      {wallet.highlight && (
                                        <WalletHighlightBadge highlight={wallet.highlight} />
                                      )}
                                    </p>
                                    {wallet.averageSize && (
                                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                        <span className="inline-flex items-center gap-1 rounded-full border border-slate-800/70 bg-slate-900/70 px-1.5 py-0.5 text-[0.55rem] font-semibold uppercase tracking-[0.2em] text-gray-300">
                                          Avg {formatUsdCompact(wallet.averageSize)}
                                        </span>
                                        <SizingBadge
                                          initialValue={wallet.initialValue}
                                          averageSize={wallet.averageSize}
                                        />
                                      </div>
                                    )}
                                    {wallet.redeemable && (
                                      <span className="inline-flex items-center gap-1 mt-1 rounded-full border border-amber-400/60 bg-amber-500/10 px-1.5 py-0.5 text-[0.6rem] uppercase tracking-[0.2em] text-amber-200">
                                        Redeemable
                                      </span>
                                    )}
                                    {sportEdge && (
                                      <SportEdgeIndicator edge={sportEdge} />
                                    )}
                                    {wallet.confidence && (
                                      <ConfidenceMeter confidence={wallet.confidence} />
                                    )}
                                  </div>
                                </div>
                                <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                                  <span className="text-xs sm:text-sm font-semibold text-gray-200">
                                    {formatUsdCompact(wallet.initialValue)}
                                  </span>
                                  <span
                                    className={`text-[0.65rem] sm:text-xs font-semibold ${pnlPositive ? 'text-emerald-300' : 'text-rose-300'
                                      }`}
                                  >
                                    {pnlPositive ? '+' : '-'}
                                    {formatUsdCompact(Math.abs(wallet.pnl))}
                                  </span>
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )
                  })}
                </div>

                {/* Top Holders Section */}
                {market.conditionId && (
                  <div className="mt-4 sm:mt-5 pt-4 sm:pt-5 border-t border-slate-800/60">
                    <button
                      type="button"
                      onClick={() => toggleHolders(market.id, market.conditionId)}
                      className="w-full flex items-center justify-between gap-2 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-cyan-400" />
                        <span className="text-sm font-semibold text-gray-200">Top Holders</span>
                        {loadingHolders.has(market.id) && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" />
                        )}
                      </div>
                      <ChevronDown
                        className={`h-4 w-4 text-gray-400 transition-transform ${expandedHolders.has(market.id) ? 'rotate-180' : ''
                          }`}
                      />
                    </button>

                    {expandedHolders.has(market.id) && (
                      <TopHoldersDisplay
                        holders={holdersCache.get(market.id)}
                        isLoading={loadingHolders.has(market.id)}
                        outcomes={market.outcomes.map((o) => o.outcome)}
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })}
      </div>
    </section>
  )
}

const OPPOSITION_SEVERITY_STYLES: Record<
  OppositionBalanceSnapshot['callout'],
  { label: string; containerClass: string }
> = {
  money: {
    label: 'Bankroll favors primary',
    containerClass: 'border-cyan-400/40 bg-cyan-500/5 text-cyan-200',
  },
  units: {
    label: 'Unit sizing favors primary',
    containerClass: 'border-amber-400/40 bg-amber-500/5 text-amber-200',
  },
  conviction: {
    label: 'Conviction favors primary',
    containerClass: 'border-emerald-400/40 bg-emerald-500/5 text-emerald-200',
  },
  mixed: {
    label: 'Mixed signals',
    containerClass: 'border-slate-700/70 bg-slate-900/60 text-gray-200',
  },
}

function OppositionBalanceIndicator({ balance }: { balance: OppositionBalanceSnapshot }) {
  const severityMeta = OPPOSITION_SEVERITY_STYLES[balance.callout]
  return (
    <div className={`w-full rounded-lg border px-2.5 py-2 space-y-2 ${severityMeta.containerClass}`}>
      <div className="flex items-center justify-between text-[0.6rem] sm:text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-gray-100">
        <span className="inline-flex items-center gap-1">
          <Scale className="h-3 w-3 sm:h-3.5 sm:w-3.5" aria-hidden="true" />
          {severityMeta.label}
        </span>
        <span className="tracking-[0.15em]">
          {formatPercent(balance.primaryShare)} · {formatPercent(balance.secondaryShare)}
        </span>
      </div>
      <div className="text-[0.55rem] sm:text-[0.6rem] tracking-[0.15em] text-white/80 flex items-center justify-between">
        <span className="truncate">{balance.primaryLabel}</span>
        <span className="truncate text-right">{balance.secondaryLabel}</span>
      </div>
      <div className="space-y-1.5">
        <BalanceBar
          label="Bankroll"
          primaryShare={balance.primaryShare}
          secondaryShare={balance.secondaryShare}
          primaryAmount={balance.primaryAmount}
          secondaryAmount={balance.secondaryAmount}
          barClass="bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-500"
        />
        <BalanceBar
          label="Unit sizing"
          primaryShare={balance.primaryUnitShare}
          secondaryShare={balance.secondaryUnitShare}
          primaryAmount={balance.primaryUnitShare}
          secondaryAmount={balance.secondaryUnitShare}
          barClass="bg-gradient-to-r from-amber-300 via-amber-400 to-amber-500"
          isRatio
        />
        <ConfidenceBar
          label="Conviction"
          primaryScore={balance.primaryConfidence}
          secondaryScore={balance.secondaryConfidence}
          primaryClips={balance.primaryMaxClipCount}
          secondaryClips={balance.secondaryMaxClipCount}
        />
      </div>
    </div>
  )
}

function BalanceBar({
  label,
  primaryShare,
  secondaryShare,
  primaryAmount,
  secondaryAmount,
  barClass,
  isRatio,
}: {
  label: string
  primaryShare: number
  secondaryShare: number
  primaryAmount: number
  secondaryAmount: number
  barClass: string
  isRatio?: boolean
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-[0.55rem] sm:text-[0.6rem] uppercase tracking-[0.2em] text-gray-300">
        <span>{label}</span>
        {!isRatio && (
          <span>
            {formatUsdCompact(primaryAmount)} · {formatUsdCompact(secondaryAmount)}
          </span>
        )}
        {isRatio && (
          <span>
            {formatPercent(primaryShare)} · {formatPercent(secondaryShare)}
          </span>
        )}
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-slate-950/70 overflow-hidden border border-white/5">
        <div
          className={`h-full ${barClass}`}
          style={{ width: `${Math.min(primaryShare, 1) * 100}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}

function ConfidenceBar({
  label,
  primaryScore,
  secondaryScore,
  primaryClips,
  secondaryClips,
}: {
  label: string
  primaryScore: number
  secondaryScore: number
  primaryClips: number
  secondaryClips: number
}) {
  const primaryMeta = confidenceMeta(primaryScore)
  const secondaryMeta = confidenceMeta(secondaryScore)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[0.55rem] sm:text-[0.6rem] uppercase tracking-[0.2em] text-gray-300">
        <span>{label}</span>
        <span>
          Max clip {primaryClips} · {secondaryClips}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <div className={`rounded-full px-2 py-0.5 text-center text-[0.55rem] ${primaryMeta.textClass}`}>
          {Math.round(primaryScore * 100)}%
        </div>
        <div className={`rounded-full px-2 py-0.5 text-center text-[0.55rem] ${secondaryMeta.textClass}`}>
          {Math.round(secondaryScore * 100)}%
        </div>
      </div>
    </div>
  )
}

function confidenceMeta(score: number) {
  if (score >= 0.75) {
    return CONFIDENCE_META.high
  }
  if (score >= 0.5) {
    return CONFIDENCE_META.medium
  }
  return CONFIDENCE_META.low
}

function AddWalletModal({
  trackingForm,
  onTrackingFormChange,
  onSubmit,
  isAdding,
  error,
  onClose,
}: {
  trackingForm: AddWalletFormState
  onTrackingFormChange: React.Dispatch<React.SetStateAction<AddWalletFormState>>
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  isAdding: boolean
  error: string | null
  onClose: () => void
}) {
  const walletInputId = useId()
  const nicknameInputId = useId()
  const handleChange =
    (field: keyof AddWalletFormState) =>
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value
        onTrackingFormChange((previous) => ({ ...previous, [field]: value }))
      }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-3 sm:px-4 py-4 sm:py-8">
      <div className="w-full max-w-lg rounded-xl sm:rounded-2xl md:rounded-3xl border border-slate-800/80 bg-slate-950/90 p-4 sm:p-5 md:p-6 shadow-2xl shadow-cyan-500/20">
        <div className="flex items-start justify-between gap-3 sm:gap-4">
          <div>
            <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">Track wallet</p>
            <h2 className="text-lg sm:text-xl md:text-2xl font-semibold">Add a Polymarket proxy</h2>
            <p className="text-xs sm:text-sm text-gray-400">
              Paste any proxy address and optionally add a nickname for quick scanning.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-800 p-1.5 sm:p-2 text-gray-400 hover:border-cyan-400 hover:text-cyan-200"
            aria-label="Close"
          >
            X
          </button>
        </div>

        <form onSubmit={onSubmit} className="mt-4 sm:mt-5 md:mt-6 space-y-3 sm:space-y-4">
          <div className="space-y-1.5 sm:space-y-2">
            <label
              className="text-xs sm:text-sm font-semibold text-gray-300 flex items-center gap-1.5 sm:gap-2"
              htmlFor={walletInputId}
            >
              <Wallet className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-cyan-300" />
              Wallet address
            </label>
            <input
              id={walletInputId}
              className="w-full rounded-lg sm:rounded-xl border border-slate-800 bg-slate-950/50 px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm focus:border-cyan-400 focus:outline-none"
              placeholder="0x..."
              value={trackingForm.walletAddress}
              onChange={handleChange('walletAddress')}
            />
          </div>
          <div className="space-y-1.5 sm:space-y-2">
            <label
              className="text-xs sm:text-sm font-semibold text-gray-300 flex items-center gap-1.5 sm:gap-2"
              htmlFor={nicknameInputId}
            >
              <User className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-cyan-300" />
              Nickname (optional)
            </label>
            <input
              id={nicknameInputId}
              className="w-full rounded-lg sm:rounded-xl border border-slate-800 bg-slate-950/50 px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm focus:border-cyan-400 focus:outline-none"
              placeholder="Sharp, Syndicate, ..."
              value={trackingForm.nickname}
              onChange={handleChange('nickname')}
            />
          </div>
          {error && (
            <div className="bg-rose-950/40 border border-rose-900 text-rose-200 px-3 sm:px-4 py-2 sm:py-3 rounded-lg sm:rounded-xl text-xs sm:text-sm">
              {error}
            </div>
          )}
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              type="submit"
              className="flex-1 inline-flex items-center justify-center gap-1.5 sm:gap-2 rounded-lg sm:rounded-xl bg-cyan-500 px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-slate-900 hover:bg-cyan-400 disabled:opacity-50"
              disabled={isAdding}
            >
              {isAdding ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 sm:h-4 sm:w-4 animate-spin" />
                  Adding…
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  Add to dashboard
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg sm:rounded-xl border border-slate-800 px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm text-gray-300 hover:border-cyan-400"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function formatTradeTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString()
}
