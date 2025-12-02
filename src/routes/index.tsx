import { createFileRoute } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import {
  AlertTriangle,
  BellRing,
  Clock,
  Eye,
  EyeOff,
  Flame,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  TrendingUp,
  Trash2,
  Trophy,
  User,
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
import { getSportLabel, isEsportsMarket, isSportsMarket } from '@/lib/sports'
import {
  fetchPositionsForUser,
  fetchTradesForUser,
  type PolymarketPosition,
  type PolymarketTrade,
} from '../lib/polymarket'
import {
  deleteWatcherFn,
  ensureUserFn,
  listAlertHistoryFn,
  listWatchersFn,
  runAlertScanFn,
  testPushNotificationFn,
  upsertWatcherFn,
} from '../server/api/watchers'
import { getWalletStatsFn, listWalletResultsFn } from '../server/api/wallet-stats'
import { getWalletDiagnosticsFn } from '../server/api/diagnostics'

const REFRESH_INTERVAL_MS = 30_000
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

interface WalletStatsSummary {
  allTime: WalletStatsBucket
  daily: WalletStatsBucket
  weekly: WalletStatsBucket
  monthly: WalletStatsBucket
  bySport: WalletSportRecord[]
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
}

const WEEKLY_HOT_PNL_THRESHOLD = 500_000
const WEEKLY_HOT_WIN_DELTA = 5
const DAILY_HOT_PNL_THRESHOLD = 100_000

type WalletHighlightKind = 'top' | 'weekly' | 'daily'

interface WalletHighlight {
  kind: WalletHighlightKind
  label: string
  detail: string
  badgeClass: string
  Icon: LucideIcon
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
}

function pickWalletHighlight(
  stats: WalletStatsSummary,
  options?: { isTopPerformer?: boolean },
): WalletHighlight | null {
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

  const weeklyEdge = stats.weekly.wins - stats.weekly.losses
  if (
    stats.weekly.pnlUsd >= WEEKLY_HOT_PNL_THRESHOLD &&
    weeklyEdge >= WEEKLY_HOT_WIN_DELTA
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

function formatWalletAddress(address: string) {
  if (address.length <= 10) {
    return address
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function isFutureWillQuestion(title?: string | null): boolean {
  if (!title) {
    return false
  }
  const trimmed = title.trim()
  // Check if it starts with "Will" (case insensitive)
  if (!/^will\b/i.test(trimmed)) {
    return false
  }
  
  // Allow "Will" questions with specific dates (e.g., "Will Arsenal win on 2025-12-03?")
  // These are current/upcoming game bets, not future championship bets
  // Check for date patterns: YYYY-MM-DD or YYYY/MM/DD or MM/DD/YYYY
  const hasSpecificDate = /\d{4}[-\/]\d{2}[-\/]\d{2}|\d{2}[-\/]\d{2}[-\/]\d{4}/.test(trimmed)
  if (hasSpecificDate) {
    return false
  }
  
  // Filter out championship/season questions with years
  // These include: "Will X be the 2025 Drivers Champion?", "Will Chiefs win Super Bowl 2026?", etc.
  const hasYear = /\b(20\d{2})\b/.test(trimmed)
  const hasChampionshipKeywords = /\b(champion|championship|champions|winner|super bowl|world series|stanley cup|nba finals|drivers champion|constructors|playoffs|season|title)\b/i.test(trimmed)
  
  // If it has a year and championship/winner keywords, it's a future championship bet
  if (hasYear && hasChampionshipKeywords) {
    return true
  }
  
  // Also filter if it's just a year far in the future (2026+) without a date
  // This catches things like "Will X win in 2026?" but allows "Will X win on 2025-12-03?"
  const hasFutureYear = /\b(202[6-9]|20[3-9]\d)\b/.test(trimmed)
  if (hasFutureYear && !hasSpecificDate) {
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
  const [walletStats, setWalletStats] = useState<Record<string, WalletStatsSummary>>({})
  const [walletResults, setWalletResults] = useState<
    Record<string, WalletResultSummary[]>
  >({})
  const [walletDiagnostics, setWalletDiagnostics] = useState<
    Record<string, WalletDiagnosticsSummary>
  >({})
  const [walletPositions, setWalletPositions] = useState<Record<string, PolymarketPosition[]>>({})
  const [notificationStatus, setNotificationStatus] = useState<
    'idle' | 'requesting' | NotificationPermission | 'unsupported'
  >('idle')
  const abortControllerRef = useRef<AbortController | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setInterval>>()
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
          if (isFutureWillQuestion(position.title)) {
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
        let market = markets.get(marketKey)
        if (!market) {
          market = {
            id: marketKey,
            title: position.title ?? position.slug ?? 'Unknown market',
            totalValue: 0,
            icon: position.icon,
            outcomes: [],
          }
          markets.set(marketKey, market)
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
        outcome.wallets.push({
          walletAddress: originalAddress,
          label,
          value: position.currentValue,
          initialValue: position.initialValue,
          pnl: position.cashPnl,
          redeemable: Boolean(position.redeemable),
        })
      })
    })

    return Array.from(markets.values())
      .map((market) => ({
        ...market,
        outcomes: market.outcomes
          .map((outcome) => ({
            ...outcome,
            wallets: outcome.wallets.sort((a, b) => b.value - a.value),
          }))
          .sort((a, b) => b.totalValue - a.totalValue),
      }))
      .sort((a, b) => b.totalValue - a.totalValue)
  }, [walletPositions, walletLabelMap])

  const loadPositionsForWallet = useCallback(async (walletAddress: string) => {
    try {
        const response = await fetchPositionsForUser(walletAddress)
        const filtered = response.filter((position) => {
          if (position.currentValue <= 0) {
            return false
          }
          // Filter out future "Will" questions
          if (isFutureWillQuestion(position.title)) {
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
          data: { walletAddress, sportsOnly: false },
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
        data: { walletAddress, sportsOnly: false, limit: 25 },
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

  const loadAlertHistory = useCallback(async (id: string) => {
    try {
      const response = await listAlertHistoryFn({ data: { userId: id } })
      setAlertHistory(response.alerts)
    } catch (error) {
      console.error('Unable to load alert history', error)
    }
  }, [])

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
    if (!walletPositions[key]) {
      loadPositionsForWallet(wallet.walletAddress)
    }
  })
}, [loadPositionsForWallet, trackedWallets, walletPositions])

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

  useEffect(() => {
    if (!selectedWallet) {
      return
    }

    refreshTimerRef.current && clearInterval(refreshTimerRef.current)

    refreshTimerRef.current = setInterval(() => {
      loadWalletData(selectedWallet, { silent: true })
    }, REFRESH_INTERVAL_MS)

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current)
      }
    }
  }, [loadWalletData, selectedWallet])

  useEffect(
    () => () => {
      abortControllerRef.current?.abort()
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current)
      }
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
        className="px-4 py-6 sm:px-5 sm:py-8 md:px-6 md:py-10 lg:px-8 lg:py-12 max-w-6xl mx-auto space-y-4 sm:space-y-6 md:space-y-10"
        style={{ 
          paddingTop: 'max(1.5rem, calc(env(safe-area-inset-top, 0px) + 1.5rem))' 
        }}
      >
        <div className="space-y-2 sm:space-y-3 md:space-y-4">
          <p className="text-xl sm:text-2xl md:text-3xl lg:text-4xl font-black uppercase tracking-[0.3em] text-cyan-400/80">
            Polywhaler
          </p>
          <p className="text-xs sm:text-sm md:text-base text-gray-300 max-w-3xl">
            Track as many proxy wallets as you want, see their open and closed positions, and monitor PnL plus win/loss records across every timeframe.
          </p>
        </div>
        <div className="space-y-4 sm:space-y-5 md:space-y-6 lg:space-y-8">
          <div className="lg:hidden">
            <SharedPositionsBoard positions={aggregatedPositions} />
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
                <SharedPositionsBoard positions={aggregatedPositions} />
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

                {selectedDiagnostics && (
                  <div className="grid gap-2 sm:gap-3 md:gap-4 md:grid-cols-3">
                    <div className="rounded-lg sm:rounded-xl md:rounded-2xl border border-slate-800/80 bg-slate-900/40 backdrop-blur-sm p-2.5 sm:p-3 md:p-4 space-y-1">
                      <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500">
                        Closed PnL (7d)
                      </p>
                      <p className="text-base sm:text-lg font-semibold text-white">
                        {selectedDiagnostics.closed.wins}-{selectedDiagnostics.closed.losses}-{selectedDiagnostics.closed.ties}
                      </p>
                      <p
                        className={`text-xs sm:text-sm font-semibold ${
                          selectedDiagnostics.closed.pnlUsd >= 0
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
                                  className={`text-[0.65rem] sm:text-xs font-semibold ${
                                    pnlPositive ? 'text-emerald-300' : 'text-rose-300'
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
                                  className={`text-base sm:text-lg md:text-xl font-semibold ${
                                    result.pnlUsd >= 0 ? 'text-emerald-300' : 'text-rose-300'
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
                  className={`w-full rounded-lg sm:rounded-xl md:rounded-2xl border px-3 sm:px-4 py-2 sm:py-3 text-left transition ${
                    isActive
                      ? 'border-cyan-400 bg-cyan-500/10'
                      : 'border-slate-800/80 bg-slate-900/60 hover:border-cyan-400/60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm sm:text-base font-semibold text-white">
                        {wallet.nickname || formatWalletAddress(wallet.walletAddress)}
                      </p>
                      <p className="text-[0.65rem] sm:text-xs text-gray-500">
                        {wallet.nickname ? formatWalletAddress(wallet.walletAddress) : 'Tracked wallet'}
                      </p>
                      {highlight && (
                        <div className="mt-1.5 sm:mt-2">
                          <WalletHighlightBadge highlight={highlight} />
                        </div>
                      )}
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
                ? 'Legacy position step'
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
                        ? 'Legacy position step'
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
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.2em] ${badgeClass}`}
      title={detail}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
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
  const [collapsed, setCollapsed] = useState(false)
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
                  className={`w-full px-3 sm:px-4 md:px-5 py-2.5 sm:py-3 md:py-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
                    isSelected
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
                        <p className="text-xs sm:text-sm font-semibold text-white">
                          {wallet.nickname || formatWalletAddress(wallet.walletAddress)}
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
                        className={`text-xs sm:text-sm font-semibold ${
                          pnlPositive ? 'text-emerald-300' : 'text-rose-300'
                        }`}
                      >
                        {pnlPositive ? '+' : '-'}
                        {formatUsdCompact(Math.abs(allTimePnl))}
                      </p>
                    </div>
                  </div>
                  {highlight && (
                    <div className="mt-1.5 sm:mt-2">
                      <WalletHighlightBadge highlight={highlight} />
                    </div>
                  )}
                  <div className="mt-2 sm:mt-3 flex flex-col gap-1 sm:gap-1.5">
                    {glanceBuckets.map(({ key: bucketKey, label }) => {
                      const bucket = stats[bucketKey]
                      const bucketPositive = bucket.pnlUsd >= 0
                      return (
                        <div
                          key={`${wallet.walletAddress}-${bucketKey}`}
                          className={`flex items-center gap-1.5 text-[0.65rem] sm:text-xs ${
                            bucketPositive
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

function SharedPositionsBoard({
  positions,
}: {
  positions: AggregatedMarketEntry[]
}) {
  const [showRedeemable, setShowRedeemable] = useState(false)
  const [showSmallBets, setShowSmallBets] = useState(false)
  const SMALL_BET_THRESHOLD = 50_000

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
            <h2 className="text-lg sm:text-xl md:text-2xl font-semibold text-balance">Where tracked wallets overlap</h2>
            <p className="text-xs sm:text-sm text-gray-400">
              Top markets sorted by combined current value. Opposing sides are flagged automatically.
            </p>
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
                  <span className="hidden sm:inline">Hide redeemable</span>
                  <span className="sm:hidden">Hide</span>
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Show redeemable</span>
                  <span className="sm:hidden">Show</span>
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
                  <span className="hidden sm:inline">Hide &lt; $50k</span>
                  <span className="sm:hidden">Hide</span>
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Show &lt; $50k</span>
                  <span className="sm:hidden">Show</span>
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

            return { market, visibleOutcomes, hasOpposition, visibleMarketTotal, originalBetTotal }
          })
          .filter((item): item is { market: AggregatedMarketEntry; visibleOutcomes: Array<AggregatedOutcomeEntry & { visibleWallets: AggregatedWalletPosition[]; visibleTotalValue: number; visibleTotalInitialValue: number }>; hasOpposition: boolean; visibleMarketTotal: number; originalBetTotal: number } => item !== null)
          .map(({ market, visibleOutcomes, hasOpposition, originalBetTotal }) => (
            <div
              key={market.id}
              className={`rounded-lg sm:rounded-xl md:rounded-2xl border px-4 py-4 sm:px-5 sm:py-5 md:px-6 md:py-6 shadow-md shadow-black/10 transition-all ${
                hasOpposition
                  ? 'border-rose-400/50 bg-rose-400/8'
                  : 'border-slate-800/80 bg-slate-950/70 hover:border-slate-700/80'
              }`}
            >
              <div className="flex items-start gap-3 sm:gap-4 mb-4 sm:mb-5 pb-4 sm:pb-5 border-b border-slate-800/60">
                {market.icon ? (
                  <img
                    src={market.icon}
                    alt={market.title}
                    className="h-10 w-10 sm:h-12 sm:w-12 md:h-14 md:w-14 rounded-lg border border-slate-800 object-cover flex-shrink-0"
                  />
                ) : (
                  <div className={`flex-shrink-0 p-2 rounded-lg ${
                    hasOpposition 
                      ? 'bg-rose-400/20 text-rose-300' 
                      : 'bg-cyan-500/10 text-cyan-400'
                  }`}>
                    {hasOpposition ? (
                      <AlertTriangle className="h-4 w-4 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                    ) : (
                      <TrendingUp className="h-4 w-4 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                    )}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    {hasOpposition && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[0.65rem] sm:text-xs font-semibold bg-rose-400/20 text-rose-300 border border-rose-400/30">
                        <AlertTriangle className="h-3 w-3" />
                        Opposing action
                      </span>
                    )}
                  </div>
                  <h3 className="text-base sm:text-lg md:text-xl font-semibold text-white leading-tight mb-1">
                    {market.title}
                  </h3>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-[0.65rem] sm:text-xs uppercase tracking-[0.3em] text-gray-500 mb-0.5">
                    Total
                  </p>
                  <p className="text-base sm:text-lg md:text-xl font-semibold text-white">
                    {formatUsdCompact(originalBetTotal)}
                  </p>
                </div>
              </div>

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
                        return (
                          <li
                            key={`${wallet.walletAddress}-${market.id}-${outcome.outcome}`}
                            className="flex items-center justify-between gap-3 rounded-lg border border-slate-800/60 bg-slate-950/70 px-2.5 py-2 sm:px-3 sm:py-2.5 hover:border-slate-700/60 hover:bg-slate-950/80 transition-colors"
                          >
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <div className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${
                                pnlPositive ? 'bg-emerald-400/60' : 'bg-rose-400/60'
                              }`} />
                              <div className="flex-1 min-w-0">
                                <p className="text-xs sm:text-sm font-semibold text-white truncate">
                                  {wallet.label}
                                </p>
                                {wallet.redeemable && (
                                  <span className="inline-flex items-center gap-1 mt-1 rounded-full border border-amber-400/60 bg-amber-500/10 px-1.5 py-0.5 text-[0.6rem] uppercase tracking-[0.2em] text-amber-200">
                                    Redeemable
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                              <span className="text-xs sm:text-sm font-semibold text-gray-200">
                                {formatUsdCompact(wallet.initialValue)}
                              </span>
                              <span className="text-[0.65rem] text-gray-500">
                                Now: {formatUsdCompact(wallet.value)}
                              </span>
                              <span
                                className={`text-[0.65rem] sm:text-xs font-semibold ${
                                  pnlPositive ? 'text-emerald-300' : 'text-rose-300'
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
            </div>
          ))}
      </div>
    </section>
  )
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
