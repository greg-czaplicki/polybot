import { createFileRoute } from '@tanstack/react-router'
import {
  Activity,
  BellRing,
  Clock,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  User,
  Wallet,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AlertEventRecord, WatcherRule } from '@/lib/alerts/types'
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
  upsertWatcherFn,
} from '../server/api/watchers'
import { getWalletStatsFn, listWalletResultsFn } from '../server/api/wallet-stats'

const REFRESH_INTERVAL_MS = 30_000
const INITIAL_TRADE_BATCH_SIZE = 20
const TRADE_BATCH_INCREMENT = 20
const ALERT_CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

interface AlertFormState {
  nickname: string
  singleTradeThresholdUsd: string
}

const DEFAULT_ALERT_FORM: AlertFormState = {
  nickname: '',
  singleTradeThresholdUsd: '25000',
}

interface WalletStatsBucket {
  wins: number
  losses: number
  ties: number
  pnlUsd: number
}

interface WalletStatsSummary {
  allTime: WalletStatsBucket
  daily: WalletStatsBucket
  weekly: WalletStatsBucket
  monthly: WalletStatsBucket
}

interface WalletResultSummary {
  asset: string
  title?: string
  eventSlug?: string
  resolvedAt: number
  pnlUsd: number
  result: 'win' | 'loss' | 'tie'
  isSports: boolean
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

function parsePositiveInt(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10)
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  return fallback
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

export const Route = createFileRoute('/')({ component: App })

function App() {
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null)
  const [trackingForm, setTrackingForm] = useState<AddWalletFormState>(
    DEFAULT_ADD_WALLET_FORM,
  )
  const [isAddingWallet, setIsAddingWallet] = useState(false)
  const [trackingError, setTrackingError] = useState<string | null>(null)
  const [insightTab, setInsightTab] = useState<'closed' | 'activity' | 'profile'>('closed')
  const [isAddWalletModalOpen, setIsAddWalletModalOpen] = useState(false)
  const [isWalletManagerOpen, setIsWalletManagerOpen] = useState(false)
  const [trades, setTrades] = useState<PolymarketTrade[]>([])
  const [positions, setPositions] = useState<PolymarketPosition[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false)
  const [visibleTradeCount, setVisibleTradeCount] = useState(INITIAL_TRADE_BATCH_SIZE)
  const [autoLoadEnabled, setAutoLoadEnabled] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [watchers, setWatchers] = useState<WatcherRule[]>([])
  const [alertHistory, setAlertHistory] = useState<AlertEventRecord[]>([])
  const [alertForm, setAlertForm] = useState<AlertFormState>(DEFAULT_ALERT_FORM)
  const [alertCenterError, setAlertCenterError] = useState<string | null>(null)
  const [isSavingWatcher, setIsSavingWatcher] = useState(false)
  const [isScanningAlerts, setIsScanningAlerts] = useState(false)
  const [walletStats, setWalletStats] = useState<Record<string, WalletStatsSummary>>({})
  const [walletResults, setWalletResults] = useState<
    Record<string, WalletResultSummary[]>
  >({})
  const [walletPositions, setWalletPositions] = useState<Record<string, PolymarketPosition[]>>({})
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
  const selectedStats = selectedWalletKey ? walletStats[selectedWalletKey] : undefined
  const selectedResults = selectedWalletKey ? walletResults[selectedWalletKey] ?? [] : []

  const loadWalletData = useCallback(
    async (wallet?: string | null, options?: { silent?: boolean }) => {
      const trimmedWallet = wallet?.trim() ?? ''

      if (!trimmedWallet) {
        setTrades([])
        setPositions([])
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
        const [tradesData, positionsData] = await Promise.all([
          fetchTradesForUser(trimmedWallet, controller.signal),
          fetchPositionsForUser(trimmedWallet, controller.signal),
        ])
        setTrades(tradesData)
        const filteredPositions = positionsData.filter((position) => position.currentValue > 0)
        setPositions(filteredPositions)
        setWalletPositions((previous) => ({
          ...previous,
          [trimmedWallet.toLowerCase()]: filteredPositions,
        }))
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
    [],
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

  const loadPositionsForWallet = useCallback(async (walletAddress: string) => {
    try {
      const response = await fetchPositionsForUser(walletAddress)
      const filtered = response.filter((position) => position.currentValue > 0)
      setWalletPositions((previous) => ({
        ...previous,
        [walletAddress.toLowerCase()]: filtered,
      }))
    } catch (error) {
      console.error('Unable to load positions for overview', walletAddress, error)
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

  const handleAlertFormSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()

      if (!userId) {
        setAlertCenterError('Still preparing your alert workspace. Try again in a moment.')
        return
      }

      const wallet = selectedWallet?.trim()
      if (!wallet) {
        setAlertCenterError('Select a wallet from your dashboard before saving an alert rule.')
        return
      }

      setIsSavingWatcher(true)
      try {
        const payload = {
          walletAddress: wallet,
          nickname: alertForm.nickname.trim() || undefined,
          singleTradeThresholdUsd: parsePositiveNumber(
            alertForm.singleTradeThresholdUsd,
          ),
          notifyChannels: ['web_push'] as const,
        }

        if (!payload.singleTradeThresholdUsd) {
          setAlertCenterError('Add a position value step before saving.')
          return
        }

        await upsertWatcherFn({ data: { userId, watcher: payload } })
        setAlertCenterError(null)
        setAlertForm((previous) => ({ ...previous, nickname: '' }))
        await loadWatchersForUser(userId)
      } catch (error) {
        console.error('Unable to save alert rule', error)
        setAlertCenterError(
          error instanceof Error ? error.message : 'Unable to save alert rule.',
        )
      } finally {
        setIsSavingWatcher(false)
      }
    },
    [alertForm, loadWatchersForUser, selectedWallet, userId],
  )

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
              notifyChannels: ['web_push'] as const,
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

  const handleAlertRuleDisable = useCallback(
    async (watcher: WatcherRule) => {
      if (!userId) {
        setAlertCenterError('Still preparing your workspace. Try again in a moment.')
        return
      }

      try {
        await upsertWatcherFn({
          data: {
            userId,
            watcher: {
              id: watcher.id,
              walletAddress: watcher.walletAddress,
              nickname: watcher.nickname,
              singleTradeThresholdUsd: null,
              accumulationThresholdUsd: null,
              accumulationWindowSeconds: watcher.accumulationWindowSeconds,
              minTrades: watcher.minTrades,
              notifyChannels: [],
            },
          },
        })
        setAlertCenterError(null)
        await loadWatchersForUser(userId)
      } catch (error) {
        console.error('Unable to disable alert rule', error)
        setAlertCenterError(
          error instanceof Error ? error.message : 'Unable to remove alert rule.',
        )
      }
    },
    [loadWatchersForUser, userId],
  )

  useEffect(() => {
    if (trades.length === 0) {
      setVisibleTradeCount(0)
      return
    }
    setVisibleTradeCount(Math.min(INITIAL_TRADE_BATCH_SIZE, trades.length))
  }, [trades])

  useEffect(() => {
    if (!selectedWallet) {
      return
    }
    const normalized = selectedWallet.toLowerCase()
    const watcher = watchers.find(
      (candidate) => candidate.walletAddress.toLowerCase() === normalized,
    )
    if (!watcher) {
      setAlertForm(DEFAULT_ALERT_FORM)
      return
    }
    setAlertForm((previous) => ({
      ...previous,
      nickname: watcher.nickname ?? '',
      singleTradeThresholdUsd: watcher.singleTradeThresholdUsd
        ? String(watcher.singleTradeThresholdUsd)
        : '',
    }))
  }, [selectedWallet, watchers])

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
    const markets = new Set<string>()
    let buyVolume = 0
    let sellVolume = 0
    let totalSize = 0
    let lastTimestamp: number | null = null

    trades.forEach((trade) => {
      const notional = trade.size * trade.price
      if (trade.side === 'BUY') {
        buyVolume += notional
      } else {
        sellVolume += notional
      }
      totalSize += trade.size
      markets.add(trade.slug ?? trade.title ?? trade.asset)
      lastTimestamp =
        lastTimestamp !== null
          ? Math.max(lastTimestamp, trade.timestamp)
          : trade.timestamp
    })

    return {
      buyVolume,
      sellVolume,
      totalSize,
      markets: markets.size,
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
  const visiblePositions = useMemo(
    () =>
      positions.filter(
        (position) =>
          position.currentValue > 0 && !/^will\s/i.test(position.title ?? ''),
      ),
    [positions],
  )
  const hasPositions = visiblePositions.length > 0

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white">
      <div className="px-6 py-10 max-w-6xl mx-auto space-y-10">
        <div className="space-y-4">
          <p className="text-sm uppercase tracking-[0.3em] text-cyan-400/80">
            Polywhaler
          </p>
          <h1 className="text-3xl md:text-5xl font-black">
            Polymarket dashboard
          </h1>
          <p className="text-gray-300 max-w-3xl">
            Track as many proxy wallets as you want, see their open and closed positions, and monitor PnL plus win/loss records across every timeframe.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setIsWalletManagerOpen(true)}
              className="inline-flex items-center gap-2 rounded-full border border-slate-800 px-4 py-2 text-sm text-gray-200 hover:border-cyan-400"
            >
              <Wallet className="h-4 w-4 text-cyan-300" />
              Manage tracked wallets
            </button>
          </div>
        </div>
        <div className="space-y-8">
          <PortfolioOverview
            trackedWallets={trackedWallets}
            walletStats={walletStats}
            walletPositions={walletPositions}
          />

          <main className="space-y-8">
            <WalletSummaryList
              trackedWallets={trackedWallets}
              walletStats={walletStats}
              walletPositions={walletPositions}
              onSelectWallet={setSelectedWallet}
              selectedWallet={selectedWallet}
            />

            {selectedWallet ? (
              <>
                <section className="bg-slate-950/60 border border-slate-900 rounded-2xl p-6 space-y-6">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-[0.3em] text-gray-500">Active wallet</p>
                      <h2 className="text-3xl font-semibold">
                        {selectedWalletMeta?.nickname || formatWalletAddress(selectedWallet)}
                      </h2>
                      <p className="text-sm text-gray-400">{selectedWallet}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
                      {lastUpdated && (
                        <span className="inline-flex items-center gap-2 rounded-full border border-slate-800 px-3 py-1">
                          <Clock className="h-4 w-4 text-cyan-300" />
                          Updated {new Date(lastUpdated).toLocaleTimeString()}
                        </span>
                      )}
                      {isAutoRefreshing && (
                        <span className="inline-flex items-center gap-2 rounded-full border border-slate-800 px-3 py-1 text-cyan-300">
                          <RefreshCw className="h-4 w-4 animate-spin" />
                          Auto-refreshing
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={manualRefresh}
                        className="inline-flex items-center gap-2 rounded-full border border-slate-800 px-3 py-1 text-xs text-gray-200 hover:border-cyan-400 disabled:opacity-50"
                        disabled={status === 'loading'}
                      >
                        <RefreshCw className={`h-4 w-4 ${status === 'loading' ? 'animate-spin' : ''}`} />
                        Refresh now
                      </button>
                    </div>
                  </div>

                  {errorMessage && (
                    <div className="bg-rose-950/40 border border-rose-900 text-rose-200 px-4 py-3 rounded-xl">
                      {errorMessage}
                    </div>
                  )}

                  {selectedStats ? (
                    <div className="grid gap-4 md:grid-cols-2">
                      <PerformanceCard label="Daily" bucket={selectedStats.daily} />
                      <PerformanceCard label="Weekly" bucket={selectedStats.weekly} />
                      <PerformanceCard label="Monthly" bucket={selectedStats.monthly} />
                      <PerformanceCard label="All-time" bucket={selectedStats.allTime} />
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400">
                      No closed-market stats yet. Once the cron sees resolved markets for this wallet, the grid will populate automatically.
                    </p>
                  )}
                </section>

                <section className="bg-slate-950/60 border border-slate-900 rounded-2xl p-6 space-y-6">
                  <div className="flex flex-wrap items-center gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.3em] text-gray-500">Open positions</p>
                      <h3 className="text-2xl font-semibold">
                        {hasPositions ? `${visiblePositions.length} active markets` : 'No active markets'}
                      </h3>
                    </div>
                    <div className="flex-1" />
                    <div className="flex flex-wrap gap-3 text-xs text-gray-400">
                      <span className="inline-flex items-center gap-1 rounded-full border border-slate-800 px-3 py-1">
                        <Activity className="h-4 w-4 text-cyan-300" />
                        {tradeStats.markets} markets watched
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-slate-800 px-3 py-1">
                        <Wallet className="h-4 w-4 text-cyan-300" />
                        {currencyFormatter.format(visiblePositions.reduce((total, position) => total + position.currentValue, 0))}
                        total value
                      </span>
                    </div>
                  </div>

                  {status === 'loading' && (
                    <div className="text-gray-400">Pulling fresh /positions from Polymarket…</div>
                  )}

                  {hasPositions ? (
                    <ul className="space-y-4">
                      {visiblePositions.map((position) => (
                        <li key={position.asset}>
                          <PositionCard
                            position={position}
                            numberFormatter={numberFormatter}
                            currencyFormatter={currencyFormatter}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    status === 'success' && (
                      <p className="text-gray-400">This wallet does not hold any active markets right now.</p>
                    )
                  )}
                </section>

                <section className="bg-slate-950/60 border border-slate-900 rounded-2xl p-6 space-y-6">
                  <div className="flex flex-wrap items-center gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.3em] text-gray-500">Deep dives</p>
                      <h3 className="text-2xl font-semibold">More context on this trader</h3>
                    </div>
                    <div className="flex-1" />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setInsightTab('closed')}
                        className={`rounded-full border px-4 py-1.5 text-xs font-semibold transition ${insightTab === 'closed' ? 'border-cyan-400 text-cyan-200 bg-cyan-500/10' : 'border-slate-800 text-gray-400 hover:border-cyan-400/60'}`}
                      >
                        Closed markets
                      </button>
                      <button
                        type="button"
                        onClick={() => setInsightTab('activity')}
                        className={`rounded-full border px-4 py-1.5 text-xs font-semibold transition ${insightTab === 'activity' ? 'border-cyan-400 text-cyan-200 bg-cyan-500/10' : 'border-slate-800 text-gray-400 hover:border-cyan-400/60'}`}
                      >
                        Live tape
                      </button>
                      <button
                        type="button"
                        onClick={() => setInsightTab('profile')}
                        className={`rounded-full border px-4 py-1.5 text-xs font-semibold transition ${insightTab === 'profile' ? 'border-cyan-400 text-cyan-200 bg-cyan-500/10' : 'border-slate-800 text-gray-400 hover:border-cyan-400/60'}`}
                      >
                        Profile
                      </button>
                    </div>
                  </div>

                  {insightTab === 'closed' && (
                    selectedResults.length > 0 ? (
                      <ul className="space-y-4">
                        {selectedResults.map((result) => (
                          <li
                            key={`${result.asset}-${result.resolvedAt}`}
                            className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between"
                          >
                            <div>
                              <p className="text-xs uppercase tracking-[0.3em] text-gray-500">
                                {result.result.toUpperCase()}
                              </p>
                              <h4 className="text-lg font-semibold">{result.title || result.asset}</h4>
                              <p className="text-xs text-gray-500">
                                Resolved {new Date(result.resolvedAt * 1000).toLocaleDateString()}
                              </p>
                            </div>
                            <div className="text-right">
                              <p
                                className={`text-xl font-semibold ${result.pnlUsd >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}
                              >
                                {result.pnlUsd >= 0 ? '+' : '-'}
                                {currencyFormatter.format(Math.abs(result.pnlUsd))}
                              </p>
                              <p className="text-sm text-gray-400">
                                {result.isSports ? 'Sports market' : 'General market'}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-gray-400">
                        No closed markets stored yet. Stats will appear here once positions resolve.
                      </p>
                    )
                  )}

                  {insightTab === 'profile' && (
                    profile ? (
                      <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 flex flex-col md:flex-row gap-6 items-center">
                        <img
                          src={profile.profileImage || profile.profileImageOptimized || '/tanstack-circle-logo.png'}
                          alt={profile.pseudonym ?? profile.name ?? 'profile'}
                          className="h-24 w-24 rounded-2xl object-cover border border-slate-700"
                        />
                        <div className="flex-1 w-full space-y-2">
                          <p className="text-xs uppercase tracking-[0.3em] text-gray-500">Trader profile</p>
                          <h2 className="text-2xl font-semibold">{profile.name || profile.pseudonym || 'Unnamed'}</h2>
                          {profile.pseudonym && (
                            <p className="text-cyan-300 text-sm">@{profile.pseudonym}</p>
                          )}
                          {profile.bio && (
                            <p className="text-gray-300 text-sm max-w-3xl">{profile.bio}</p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="text-gray-400">No Polymarket profile metadata on this wallet.</p>
                    )
                  )}

                  {insightTab === 'activity' && (
                    <div className="bg-slate-950/40 border border-slate-900 rounded-2xl overflow-hidden">
                      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-900/70">
                        <div>
                          <p className="text-sm uppercase tracking-[0.3em] text-gray-500">
                            Live tape
                          </p>
                          <h3 className="text-xl font-semibold">
                            Recent fills ({trades.length})
                          </h3>
                        </div>
                        {tradeStats.lastTimestamp && (
                          <p className="text-xs text-gray-400">
                            Latest fill {formatTradeTimestamp(tradeStats.lastTimestamp)}
                          </p>
                        )}
                      </div>

                      {!hasTrades && status === 'success' && (
                        <div className="p-6 text-gray-400">
                          No on-chain fills yet for this wallet. Try another proxy address.
                        </div>
                      )}

                      {status === 'loading' && (
                        <div className="p-6 text-gray-400 animate-pulse">
                          Pulling fresh fills from Polymarket…
                        </div>
                      )}

                      {hasTrades && (
                        <>
                          <ul className="divide-y divide-slate-900/70">
                            {displayedTrades.map((trade) => (
                              <li
                                key={`${trade.transactionHash}-${trade.timestamp}-${trade.asset}`}
                                className="px-6 py-4 flex flex-col gap-2 md:flex-row md:items-center md:gap-6"
                              >
                                <div className="flex items-center gap-3 w-full md:w-56">
                                  {trade.icon ? (
                                    <img
                                      src={trade.icon}
                                      alt={trade.title}
                                      className="h-10 w-10 rounded-lg border border-slate-800 object-cover"
                                    />
                                  ) : (
                                    <div className="h-10 w-10 rounded-lg border border-slate-800 bg-slate-800" />
                                  )}
                                  <div className="space-y-1 pb-1">
                                    <p className="text-sm text-gray-400">
                                      {formatTradeTimestamp(trade.timestamp)}
                                    </p>
                                    <p
                                      className={`text-xs font-semibold ${trade.side === 'BUY' ? 'text-emerald-300' : 'text-rose-300'}`}
                                    >
                                      {trade.side}
                                    </p>
                                  </div>
                                </div>

                                <div className="flex-1">
                                  <h4 className="font-semibold">{trade.title}</h4>
                                  <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                                    <span className="text-[0.65rem] uppercase tracking-[0.3em] text-gray-500">
                                      Pick
                                    </span>
                                    <span
                                      className={`inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${trade.side === 'BUY' ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-200' : 'border-rose-500/40 bg-rose-500/5 text-rose-200'}`}
                                    >
                                      <span
                                        className={`h-1.5 w-1.5 rounded-full ${trade.side === 'BUY' ? 'bg-emerald-300' : 'bg-rose-300'}`}
                                      />
                                      <span className="truncate">{trade.outcome || 'Outcome'}</span>
                                    </span>
                                  </div>
                                </div>

                                <div className="flex items-center gap-6 text-sm text-gray-300">
                                  <div>
                                    <p className="text-xs uppercase tracking-wide text-gray-500">
                                      Size
                                    </p>
                                    <p className="font-semibold">
                                      {numberFormatter.format(trade.size)}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-xs uppercase tracking-wide text-gray-500">
                                      Price
                                    </p>
                                    <p className="font-semibold">
                                      {numberFormatter.format(trade.price)}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-xs uppercase tracking-wide text-gray-500">
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
                                    className="text-cyan-400 text-sm hover:underline"
                                  >
                                    View tx →
                                  </a>
                                )}
                              </li>
                            ))}
                          </ul>

                          {hasMoreTrades && (
                            <>
                              <div className="px-6 py-4 border-t border-slate-900/70 flex flex-col items-center gap-2">
                                <p className="text-xs uppercase tracking-[0.3em] text-gray-500">
                                  Showing {displayedTrades.length} of {trades.length} fills
                                </p>
                                <button
                                  type="button"
                                  onClick={loadMoreTrades}
                                  className="text-sm text-cyan-300 hover:text-cyan-200 transition-colors"
                                >
                                  Load more fills
                                </button>
                              </div>
                              <div
                                ref={loadMoreTriggerRef}
                                aria-hidden="true"
                                className="h-8"
                              />
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </section>
              </>
            ) : (
              <section className="bg-slate-950/60 border border-slate-900 rounded-2xl p-8 text-center space-y-3">
                <h2 className="text-2xl font-semibold">Add a wallet to start tracking</h2>
                <p className="text-gray-400">
                  Use the form on the left to add a Polymarket proxy wallet. Once it's tracked, you'll see every open and closed market here.
                </p>
              </section>
            )}

            <AlertCenter
              alertForm={alertForm}
              onFormChange={setAlertForm}
              onSubmit={handleAlertFormSubmit}
              watchers={watchers}
              onDisableAlert={handleAlertRuleDisable}
              isSaving={isSavingWatcher}
              canEdit={Boolean(userId && selectedWallet)}
              alertError={alertCenterError}
              onRunScan={handleAlertScan}
              isScanning={isScanningAlerts}
              alertHistory={alertHistory}
              walletAddress={selectedWallet ?? ''}
            />
          </main>
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 py-8">
      <div className="w-full max-w-3xl rounded-3xl border border-slate-800 bg-slate-950/95 p-6 shadow-2xl shadow-cyan-500/20">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-gray-500">Tracked wallets</p>
            <h2 className="text-2xl font-semibold">Manage the board</h2>
            <p className="text-sm text-gray-400">
              Tap a wallet to inspect it, or remove entries you no longer want to monitor.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onClose()
                onOpenAddWallet()
              }}
              className="inline-flex items-center gap-2 rounded-full border border-slate-800 px-3 py-1 text-xs font-semibold text-gray-200 hover:border-cyan-400"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-slate-800 p-2 text-gray-400 hover:border-cyan-400 hover:text-cyan-200"
              aria-label="Close wallet manager"
            >
              X
            </button>
          </div>
        </div>

        <div className="mt-6 space-y-3 max-h-[65vh] overflow-y-auto pr-1">
          {trackedWallets.length === 0 ? (
            <p className="text-sm text-gray-400">
              No wallets yet. Use the add button to bring your first trader onto the board.
            </p>
          ) : (
            trackedWallets.map((wallet) => {
              const key = wallet.walletAddress.toLowerCase()
              const stats = walletStats[key] ?? EMPTY_WALLET_STATS
              const isActive = normalizedSelection === key
              return (
                <button
                  type="button"
                  key={wallet.walletAddress}
                  onClick={() => {
                    onSelectWallet(wallet.walletAddress)
                    onClose()
                  }}
                  className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                    isActive
                      ? 'border-cyan-400 bg-cyan-500/10'
                      : 'border-slate-800 bg-slate-900/50 hover:border-cyan-400/60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-base font-semibold text-white">
                        {wallet.nickname || formatWalletAddress(wallet.walletAddress)}
                      </p>
                      <p className="text-xs text-gray-500">
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
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
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
function AlertCenter({
  alertForm,
  onFormChange,
  onSubmit,
  watchers,
  onDisableAlert,
  isSaving,
  canEdit,
  alertError,
  onRunScan,
  isScanning,
  alertHistory,
  walletAddress,
}: {
  alertForm: AlertFormState
  onFormChange: React.Dispatch<React.SetStateAction<AlertFormState>>
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  watchers: WatcherRule[]
  onDisableAlert: (watcher: WatcherRule) => void
  isSaving: boolean
  canEdit: boolean
  alertError: string | null
  onRunScan: () => void
  isScanning: boolean
  alertHistory: AlertEventRecord[]
  walletAddress: string
}) {
  const handleChange = (field: keyof AlertFormState) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value
      onFormChange((previous) => ({ ...previous, [field]: value }))
    }

  return (
    <section className="bg-slate-950/60 border border-slate-900 rounded-2xl p-6 space-y-6">
      <div className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-[0.3em] text-gray-500">Alert center</p>
        <h2 className="text-2xl font-semibold">Ping me when the tape gets spicy</h2>
        <p className="text-gray-400 max-w-2xl">
          Persist wallets you care about, define position value steps per wallet, and trigger a manual scan whenever you want an immediate read.
        </p>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="text-sm text-gray-400">
          Tracking <span className="text-white font-semibold">{watchers.length}</span>{' '}
          wallet{watchers.length === 1 ? '' : 's'} for alerts.
        </div>
        <button
          type="button"
          onClick={onRunScan}
          disabled={!canEdit || isScanning || watchers.length === 0}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-800 px-4 py-2 text-sm text-gray-200 hover:border-cyan-400 disabled:opacity-50"
        >
          <BellRing className={`h-4 w-4 ${isScanning ? 'animate-pulse' : ''}`} />
          {isScanning ? 'Scanning…' : 'Manual scan now'}
        </button>
      </div>

      {alertError && (
        <div className="bg-rose-950/40 border border-rose-800 text-rose-200 px-4 py-3 rounded-xl">
          {alertError}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-2xl border border-slate-900 bg-slate-950/60 p-4"
        >
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-gray-500">
            <Settings className="h-4 w-4" />
            Rule for {walletAddress.trim() ? formatWalletAddress(walletAddress) : '—'}
          </div>
          <div className="grid gap-3">
            <label className="text-sm text-gray-300" htmlFor="alert-nickname">
              Nickname
            </label>
            <input
              id="alert-nickname"
              className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
              placeholder="Optional label"
              value={alertForm.nickname}
              onChange={handleChange('nickname')}
            />
          </div>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <label className="text-sm text-gray-300" htmlFor="alert-single">
                Position value step (USD)
              </label>
              <input
                id="alert-single"
                type="number"
                min="0"
                inputMode="decimal"
                className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                placeholder="25000"
                value={alertForm.singleTradeThresholdUsd}
                onChange={handleChange('singleTradeThresholdUsd')}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={!canEdit || isSaving}
            className="w-full rounded-xl bg-cyan-500 px-4 py-3 text-sm font-semibold text-slate-900 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? 'Saving…' : 'Save alert rule'}
          </button>
        </form>

        <div className="space-y-6">
          <WatchersList watchers={watchers} onDisableAlert={onDisableAlert} />
          <AlertHistoryList alertHistory={alertHistory} />
        </div>
      </div>
    </section>
  )
}

function WatchersList({
  watchers,
  onDisableAlert,
}: {
  watchers: WatcherRule[]
  onDisableAlert: (watcher: WatcherRule) => void
}) {
  const activeWatchers = watchers.filter(
    (watcher) =>
      !!watcher.singleTradeThresholdUsd ||
      !!watcher.accumulationThresholdUsd ||
      watcher.notifyChannels.length > 0,
  )

  if (activeWatchers.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-800 p-4 text-sm text-gray-400">
        No alert rules yet. Configure a threshold on the left and Polywhaler will watch that wallet even when this tab is closed.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {activeWatchers.map((watcher) => (
        <div
          key={watcher.id}
          className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-gray-300"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-gray-500">
                {watcher.nickname || 'Wallet'}
              </p>
              <p className="text-lg font-semibold text-white">
                {formatWalletAddress(watcher.walletAddress)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onDisableAlert(watcher)}
              className="text-gray-500 hover:text-rose-300"
              aria-label="Disable alert"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <p className="text-xs uppercase tracking-[0.3em] text-gray-500">
              Position value step (USD)
            </p>
            <p className="text-base font-semibold text-white">
              {formatUsdCompact(watcher.singleTradeThresholdUsd)}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

function AlertHistoryList({ alertHistory }: { alertHistory: AlertEventRecord[] }) {
  if (alertHistory.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-800 p-4 text-sm text-gray-400">
        No alerts triggered yet. When a rule hits we will stash it here and fan it out via web push/email next.
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-gray-500">
        <Clock className="h-4 w-4" />
        Recent alerts
      </div>
      <ul className="space-y-3">
        {alertHistory.map((alert) => {
          const pricedTrades = alert.trades.filter(
            (trade) => (trade.size ?? 0) * (trade.price ?? 0) > 0,
          )
          return (
            <li key={alert.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs tracking-wide text-gray-500">
                  {alert.nickname || formatWalletAddress(alert.walletAddress)}
                </p>
                <p className="text-base font-semibold text-white capitalize">
                  {alert.triggerType === 'position_step'
                    ? 'Position value step'
                    : alert.triggerType === 'single'
                      ? 'Single fill'
                      : 'Rolling'} · {formatUsdCompact(alert.triggerValue)}
                </p>
              </div>
              <span className="text-xs text-gray-400">
                {new Date(alert.triggeredAt * 1000).toLocaleString()}
              </span>
            </div>
            <div className="mt-1 space-y-2 text-xs text-gray-400">
              <p>
                {alert.tradeCount} trade{alert.tradeCount === 1 ? '' : 's'} in payload.
              </p>
              {pricedTrades.length > 0 && (
                <div className="rounded-lg border border-slate-800/70 bg-slate-950/30 p-2 space-y-1 text-[0.7rem] uppercase tracking-[0.2em] text-gray-500">
                  {pricedTrades.slice(0, 3).map((trade, index) => (
                      <p key={`${alert.id}-${trade.transactionHash ?? index}`}>
                        {trade.title ?? 'Market'} · {trade.outcome ?? 'Outcome'}
                      </p>
                    ))}
                  {pricedTrades.length > 3 && (
                    <p className="text-cyan-400">
                      +{pricedTrades.length - 3} more fills
                    </p>
                  )}
                </div>
              )}
            </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function PortfolioOverview({
  trackedWallets,
  walletStats,
  walletPositions,
}: {
  trackedWallets: TrackedWalletRow[]
  walletStats: Record<string, WalletStatsSummary>
  walletPositions: Record<string, PolymarketPosition[]>
}) {
  if (trackedWallets.length === 0) {
    return null
  }

  const totalOpenMarkets = trackedWallets.reduce((sum, wallet) => {
    const positions = walletPositions[wallet.walletAddress.toLowerCase()] ?? []
    return sum + positions.length
  }, 0)

  const totalValue = trackedWallets.reduce((sum, wallet) => {
    const positions = walletPositions[wallet.walletAddress.toLowerCase()] ?? []
    return sum + positions.reduce((acc, position) => acc + position.currentValue, 0)
  }, 0)

  const totalPnl = trackedWallets.reduce((sum, wallet) => {
    const stats = walletStats[wallet.walletAddress.toLowerCase()]
    return sum + (stats?.allTime.pnlUsd ?? 0)
  }, 0)

  return (
    <section className="rounded-2xl border border-slate-900 bg-slate-950/60 p-6 space-y-4">
      <div className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-[0.3em] text-gray-500">Portfolio overview</p>
        <h2 className="text-2xl font-semibold text-balance">What&apos;s the board doing?</h2>
        <p className="text-sm text-gray-400">
          High-level snapshot of every wallet you&apos;re monitoring.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Tracked wallets" value={trackedWallets.length.toString()} />
        <StatCard title="Open markets" value={totalOpenMarkets.toString()} />
        <StatCard title="Live exposure" value={formatUsdCompact(totalValue)} />
        <StatCard title="All-time PnL" value={formatUsdCompact(totalPnl)} />
      </div>
    </section>
  )
}

function WalletSummaryList({
  trackedWallets,
  walletStats,
  walletPositions,
  onSelectWallet,
  selectedWallet,
}: {
  trackedWallets: TrackedWalletRow[]
  walletStats: Record<string, WalletStatsSummary>
  walletPositions: Record<string, PolymarketPosition[]>
  onSelectWallet: (wallet: string) => void
  selectedWallet: string | null
}) {
  if (trackedWallets.length === 0) {
    return (
      <section className="rounded-2xl border border-dashed border-slate-900 bg-slate-950/50 p-6 text-center text-sm text-gray-400">
        No wallets yet. Add a proxy on the left to start building your board.
      </section>
    )
  }

  return (
    <section className="rounded-2xl border border-slate-900 bg-slate-950/60 p-6 space-y-4">
      <div className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-[0.3em] text-gray-500">Tracked traders</p>
        <h2 className="text-2xl font-semibold">Active positions by wallet</h2>
      </div>
      <div className="space-y-4">
        {trackedWallets.map((wallet) => {
          const key = wallet.walletAddress.toLowerCase()
          const stats = walletStats[key] ?? EMPTY_WALLET_STATS
          const positions = walletPositions[key]
          const sortedPositions =
            positions
              ?.filter((position) => !/^will\s/i.test(position.title ?? ''))
              .sort((a, b) => b.currentValue - a.currentValue) ?? []
          const isSelected =
            selectedWallet?.toLowerCase() === wallet.walletAddress.toLowerCase()

          return (
            <button
              type="button"
              key={wallet.watcherId}
              onClick={() => onSelectWallet(wallet.walletAddress)}
              className={`w-full rounded-2xl border p-5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
                isSelected
                  ? 'border-cyan-400 bg-cyan-500/10'
                  : 'border-slate-900 bg-slate-950/60 hover:border-cyan-400/60'
              }`}
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-lg font-semibold text-white">
                    {wallet.nickname || formatWalletAddress(wallet.walletAddress)}
                  </p>
                  <p className="text-sm text-gray-500">
                    {wallet.nickname ? formatWalletAddress(wallet.walletAddress) : 'Tracked wallet'}
                  </p>
                  <p className="text-sm text-gray-500">
                    {stats ? 'Active positions' : 'Compiling stats…'}
                  </p>
                </div>
              </div>

              <div className="mt-4">
                {sortedPositions.length === 0 ? (
                  <p className="text-xs text-gray-500">No open risk right now.</p>
                ) : (
                  <div className="space-y-2 rounded-2xl border border-slate-900/70 bg-slate-950/40 p-3">
                    {sortedPositions.map((position) => (
                      <div
                        key={position.asset}
                        className="flex flex-col gap-1 rounded-xl border border-slate-900 bg-slate-950/60 px-4 py-3 text-sm text-gray-300"
                      >
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <p className="font-semibold text-white break-words">
                            {position.title}
                          </p>
                          <span
                            className="inline-flex items-center justify-center rounded-full border border-cyan-500/40 bg-cyan-500/10 px-4 py-1 text-base font-semibold text-cyan-100 sm:text-sm"
                            title="Current value"
                          >
                            {formatUsdCompact(position.currentValue)}
                          </span>
                        </div>
                        <p
                          className={`text-sm ${
                            position.cashPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'
                          }`}
                        >
                          {formatOutcomeLabel(position)} · {formatUsdCompact(position.cashPnl)} (
                          {position.percentPnl.toFixed(1)}%)
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </button>
          )
        })}
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
  const handleChange =
    (field: keyof AddWalletFormState) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value
      onTrackingFormChange((previous) => ({ ...previous, [field]: value }))
    }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 py-8">
      <div className="w-full max-w-lg rounded-3xl border border-slate-800 bg-slate-950/90 p-6 shadow-2xl shadow-cyan-500/20">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-gray-500">Track wallet</p>
            <h2 className="text-2xl font-semibold">Add a Polymarket proxy</h2>
            <p className="text-sm text-gray-400">
              Paste any proxy address and optionally add a nickname for quick scanning.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-800 p-2 text-gray-400 hover:border-cyan-400 hover:text-cyan-200"
            aria-label="Close"
          >
            X
          </button>
        </div>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-gray-300 flex items-center gap-2">
              <Wallet className="h-4 w-4 text-cyan-300" />
              Wallet address
            </label>
            <input
              className="w-full rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm focus:border-cyan-400 focus:outline-none"
              placeholder="0x..."
              value={trackingForm.walletAddress}
              onChange={handleChange('walletAddress')}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-semibold text-gray-300 flex items-center gap-2">
              <User className="h-4 w-4 text-cyan-300" />
              Nickname (optional)
            </label>
            <input
              className="w-full rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm focus:border-cyan-400 focus:outline-none"
              placeholder="Sharp, Syndicate, ..."
              value={trackingForm.nickname}
              onChange={handleChange('nickname')}
            />
          </div>
          {error && (
            <div className="bg-rose-950/40 border border-rose-900 text-rose-200 px-4 py-3 rounded-xl text-sm">
              {error}
            </div>
          )}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-cyan-400 disabled:opacity-50"
              disabled={isAdding}
            >
              {isAdding ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Adding…
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" />
                  Add to dashboard
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-gray-300 hover:border-cyan-400"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function PerformanceCard({ label, bucket }: { label: string; bucket: WalletStatsBucket }) {
  const pnlPositive = bucket.pnlUsd >= 0
  return (
    <div className="rounded-2xl border border-slate-900 bg-slate-900/50 p-4 space-y-1">
      <p className="text-xs uppercase tracking-[0.3em] text-gray-500">{label}</p>
      <p className="text-2xl font-semibold">
        {bucket.wins}-{bucket.losses}-{bucket.ties}
      </p>
      <p className={`text-sm font-semibold ${pnlPositive ? 'text-emerald-300' : 'text-rose-300'}`}>
        {pnlPositive ? '+' : '-'}
        {formatUsdCompact(Math.abs(bucket.pnlUsd))}
        <span className="text-gray-400 font-normal"> PnL</span>
      </p>
    </div>
  )
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-900 bg-slate-900/50 p-4 min-w-[160px]">
      <p className="text-xs uppercase tracking-[0.3em] text-gray-500">{title}</p>
      <p className="mt-2 text-2xl font-semibold text-white whitespace-nowrap">{value}</p>
    </div>
  )
}

function formatTradeTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString()
}

function PositionCard({
  position,
  numberFormatter,
  currencyFormatter,
}: {
  position: PolymarketPosition
  numberFormatter: Intl.NumberFormat
  currencyFormatter: Intl.NumberFormat
}) {
  const formatOutcomeLabel = (pos: PolymarketPosition) => {
    if (pos.title?.toLowerCase().startsWith('spread:') && pos.outcome) {
      return `${pos.outcome} ${pos.title
        .split('(')[1]
        ?.replace(')', '')
        ?.replace(/^[+-]?/, (sign) => (sign === '-' ? '+' : '-')) ?? pos.outcome}`
    }
    return pos.outcome ?? 'Outcome'
  }

  const formatPrice = (price: number) =>
    `${numberFormatter.format(price * 100).replace(/\.00$/, '')}¢`
  const pnlPositive = position.cashPnl >= 0
  const pnlClass = pnlPositive ? 'text-emerald-300' : 'text-rose-300'
  const percentLabel = `${pnlPositive ? '+' : ''}${position.percentPnl.toFixed(2)}%`

  return (
    <div className="border border-slate-800 rounded-2xl p-4 bg-slate-900/60 flex flex-col gap-4 md:flex-row md:items-center">
      <div className="flex items-center gap-4 flex-1">
        {position.icon ? (
          <img
            src={position.icon}
            alt={position.title}
            className="h-14 w-14 rounded-xl border border-slate-800 object-cover"
          />
        ) : (
          <div className="h-14 w-14 rounded-xl border border-slate-800 bg-slate-800" />
        )}
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-gray-500">Market</p>
          <h3 className="text-lg font-semibold">{position.title}</h3>
          <p className="text-sm text-cyan-300">{formatOutcomeLabel(position)}</p>
          <p className="text-sm text-gray-400">
            {numberFormatter.format(position.size)} shares at {formatPrice(position.avgPrice)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap md:flex-nowrap gap-6 text-sm text-gray-300">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">Avg</p>
          <p className="text-base font-semibold">{formatPrice(position.avgPrice)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">Current</p>
          <p className="text-base font-semibold">{formatPrice(position.curPrice)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">Value</p>
          <p className="text-base font-semibold">
            {currencyFormatter.format(position.currentValue)}
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">P&amp;L</p>
          <p className={`text-base font-semibold ${pnlClass}`}>
            {pnlPositive ? '+' : '-'}
            {currencyFormatter.format(Math.abs(position.cashPnl))}{' '}
            <span className="text-gray-400">({percentLabel})</span>
          </p>
        </div>
      </div>
    </div>
  )
}
