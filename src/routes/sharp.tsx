import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  RefreshCw,
  Target,
  TrendingUp,
  TrendingDown,
  Trophy,
  Trash2,
  User,
  Wallet,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  getSharpMoneyCacheFn,
  getSharpMoneyCacheStatsFn,
  refreshMarketSharpnessFn,
  fetchTrendingSportsMarketsFn,
  clearSharpMoneyCacheFn,
  fetchBatchMultiPeriodPnlFn,
  type SharpMoneyCacheEntry,
} from '../server/api/sharp-money'

export const Route = createFileRoute('/sharp')({
  component: SharpMoneyPage,
})

// Sport filter options
const SPORT_FILTERS = [
  { value: 'all', label: 'All Sports' },
  { value: '10187', label: 'NFL' },
  { value: '10345', label: 'NBA' },
  { value: '10210', label: 'College Football' },
  { value: '10470', label: 'College Basketball' },
  { value: '10426', label: 'MLB' },
  { value: '10346', label: 'NHL' },
  { value: '10188', label: 'Premier League' },
]

const SERIES_LABELS: Record<number, string> = {
  10187: 'NFL',
  10345: 'NBA',
  10210: 'College Football',
  10470: 'College Basketball',
  10426: 'MLB',
  10346: 'NHL',
  10188: 'Premier League',
}

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const USD_COMPACT_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})

const UNIT_FORMATTER = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '$0'
  }
  if (Math.abs(value) >= 1000) {
    return USD_COMPACT_FORMATTER.format(value)
  }
  return USD_FORMATTER.format(value)
}

function formatUnits(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  return UNIT_FORMATTER.format(value)
}

function formatAmericanOdds(price?: number | null): string | null {
  if (!price || !Number.isFinite(price) || price <= 0 || price >= 1) {
    return null
  }
  if (price >= 0.5) {
    const odds = Math.round((price / (1 - price)) * 100)
    return `-${odds}`
  }
  const odds = Math.round(((1 - price) / price) * 100)
  return `+${odds}`
}

function describeUnitScale(pnlUnits: number): 'small' | 'avg' | 'large' {
  const magnitude = Math.abs(pnlUnits)
  if (magnitude >= 20) return 'large'
  if (magnitude >= 5) return 'avg'
  return 'small'
}

function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestamp

  if (diff < 60) return 'Just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function truncateWalletName(name: string | null | undefined, maxLength: number = 20): string {
  if (!name) return ''
  if (name.length <= maxLength) return name
  return name.slice(0, maxLength) + '...'
}

function parseEventTime(isoDate?: string): Date | null {
  if (!isoDate) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return new Date(`${isoDate}T23:59:59Z`)
  }
  const parsed = new Date(isoDate)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function formatEventTime(isoDate?: string): string | null {
  if (!isoDate) return null

  try {
    const date = parseEventTime(isoDate)
    if (!date) return null
    const now = new Date()

    // Check if it's today
    const isToday = date.toDateString() === now.toDateString()

    // Check if it's tomorrow
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const isTomorrow = date.toDateString() === tomorrow.toDateString()

    // Format time
    const timeStr = date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })

    if (isToday) {
      return `Today ${timeStr}`
    }
    if (isTomorrow) {
      return `Tomorrow ${timeStr}`
    }

    // Format as day of week + time for this week
    const daysUntil = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    if (daysUntil <= 7 && daysUntil > 0) {
      const dayName = date.toLocaleDateString('en-US', { weekday: 'short' })
      return `${dayName} ${timeStr}`
    }

    // Otherwise format as date
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return null
  }
}

function getSeriesLabel(seriesId?: number): string | null {
  if (!seriesId) return null
  return SERIES_LABELS[seriesId] ?? `Series ${seriesId}`
}

function buildPolymarketUrl(eventSlug?: string, slug?: string): string | null {
  if (eventSlug && slug) {
    return `https://polymarket.com/event/${eventSlug}/${slug}`
  }
  if (eventSlug) {
    return `https://polymarket.com/event/${eventSlug}`
  }
  return null
}

function buildPolymarketProfileUrl(walletAddress: string): string {
  return `https://polymarket.com/profile/${walletAddress}`
}

function SharpMoneyPage() {
  const [entries, setEntries] = useState<SharpMoneyCacheEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null)
  const [refreshProgress, setRefreshProgress] = useState<{ current: number; total: number } | null>(null)
  const [refreshLog, setRefreshLog] = useState<string[]>([])
  const [selectedSeriesId, setSelectedSeriesId] = useState('all')
  const [expandedMarkets, setExpandedMarkets] = useState<Set<string>>(new Set())
  const [showAllEntries, setShowAllEntries] = useState(false)
  const [cacheStats, setCacheStats] = useState<{
    totalEntries: number
    newestEntry?: number
  } | null>(null)

  // Load cached data
  const loadCache = useCallback(async () => {
    setIsLoading(true)
    try {
      const limit = showAllEntries ? 200 : 50
      const [cacheResult, statsResult] = await Promise.all([
        getSharpMoneyCacheFn({
          data: {
            sportSeriesId: selectedSeriesId === 'all' ? undefined : Number(selectedSeriesId),
            limit,
          },
        }),
        getSharpMoneyCacheStatsFn({ data: {} }),
      ])

      setEntries(cacheResult.entries ?? [])
      setCacheStats(statsResult.stats ?? null)
    } catch (error) {
      console.error('Failed to load sharp money cache:', error)
    } finally {
      setIsLoading(false)
    }
  }, [selectedSeriesId, showAllEntries])

  // Initial load
  useEffect(() => {
    loadCache()
  }, [loadCache])

  // Manual refresh - behavior depends on cache state:
  // - If cache is empty: full refresh - fetch and analyze all markets
  // - If cache has data: partial refresh - only re-fetch data for imminent cached events
  const handleRefresh = async () => {
    setIsRefreshing(true)
    setRefreshStatus('Preparing refresh...')
    setRefreshProgress(null)
    setRefreshLog([])
    try {
      const isFullRefresh = entries.length === 0
      
      if (isFullRefresh) {
        // Cache is empty - do a full refresh of all markets
        console.log('[sharp] Cache empty - doing full refresh')
        setRefreshStatus('Fetching markets...')
        const { markets } = await fetchTrendingSportsMarketsFn({
          data: {
            limit: 200,
            seriesIds: selectedSeriesId === 'all' ? undefined : [Number(selectedSeriesId)],
            includeAllMarkets: true,
          },
        })

        if (markets && markets.length > 0) {
          // Analyze all fetched markets (no arbitrary limit)
          console.log(`[sharp] Analyzing ${markets.length} markets...`)
          setRefreshStatus(`Analyzing ${markets.length} markets...`)
          setRefreshProgress({ current: 0, total: markets.length })
          
          for (let i = 0; i < markets.length; i += 1) {
            const market = markets[i]
            setRefreshProgress({ current: i + 1, total: markets.length })
            setRefreshLog((prev) => [...prev.slice(-30), `Analyzing ${market.title}`])
            try {
              const result = await refreshMarketSharpnessFn({
                data: {
                  conditionId: market.conditionId,
                  marketTitle: market.title,
                  marketSlug: market.slug,
                  eventSlug: market.eventSlug,
                  sportSeriesId: market.sportSeriesId ?? undefined,
                  outcomes: market.outcomes,
                  endDate: market.endDate,
                },
              })

              // Fetch PnL for all wallets (each call has its own 50 subrequest budget)
              if (result?.allWalletAddresses && result.allWalletAddresses.length > 0) {
                const wallets = result.allWalletAddresses
                const walletsPerCall = 10 // Each call fetches 10 wallets (40 subrequests)
                const totalBatches = Math.ceil(wallets.length / walletsPerCall)
                
                // Fetch PnL in batches (each batch is a separate server function call)
                for (let i = 0; i < wallets.length; i += walletsPerCall) {
                  const batch = wallets.slice(i, i + walletsPerCall)
                  try {
                    const batchIndex = Math.floor(i / walletsPerCall) + 1
                    setRefreshStatus(`Fetching PnL batch ${batchIndex}/${totalBatches}...`)
                    await fetchBatchMultiPeriodPnlFn({ data: { walletAddresses: batch } })
                  } catch (error) {
                    console.error('Failed to fetch PnL batch:', error)
                  }
                  // Small delay between batches
                  if (i + walletsPerCall < wallets.length) {
                    await new Promise((resolve) => setTimeout(resolve, 100))
                  }
                }

                // Re-run analysis now that all PnL data is cached
                setRefreshStatus(`Analyzing ${market.title}...`)
                await refreshMarketSharpnessFn({
                  data: {
                    conditionId: market.conditionId,
                    marketTitle: market.title,
                    marketSlug: market.slug,
                    eventSlug: market.eventSlug,
                  sportSeriesId: market.sportSeriesId ?? undefined,
                    outcomes: market.outcomes,
                    endDate: market.endDate,
                  },
                })
              }
            } catch (error) {
              console.error('Failed to refresh market:', market.title, error)
            }
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        }
      } else {
        // Cache has data - partial refresh: ONLY update existing imminent/live events (no new discovery)
        const now = new Date()
        const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000)
        
        const imminentCachedEntries = entries.filter((entry) => {
          const eventDate = parseEventTime(entry.eventTime)
          if (!eventDate) return false
          // Include if: already started (live) OR starting within 1 hour
          return eventDate <= oneHourFromNow
        })
        
        if (imminentCachedEntries.length === 0) {
          console.log('[sharp] No imminent events to refresh')
          setRefreshStatus('No imminent events to refresh.')
        } else {
          console.log(`[sharp] Partial refresh: updating ${imminentCachedEntries.length} imminent/live events`)
          setRefreshStatus(`Refreshing ${imminentCachedEntries.length} live markets...`)
          setRefreshProgress({ current: 0, total: imminentCachedEntries.length })
          
          for (let i = 0; i < imminentCachedEntries.length; i += 1) {
            const entry = imminentCachedEntries[i]
            setRefreshProgress({ current: i + 1, total: imminentCachedEntries.length })
            setRefreshLog((prev) => [...prev.slice(-30), `Refreshing ${entry.marketTitle}`])
            try {
              await refreshMarketSharpnessFn({
                data: {
                  conditionId: entry.conditionId,
                  marketTitle: entry.marketTitle,
                  marketSlug: entry.marketSlug,
                  eventSlug: entry.eventSlug,
                  sportSeriesId: entry.sportSeriesId ?? undefined,
                  endDate: entry.eventTime,
                },
              })
            } catch (error) {
              console.error('Failed to refresh:', entry.marketTitle, error)
            }
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        }
      }

      // Reload cache
      setRefreshStatus('Refreshing cache view...')
      await loadCache()
    } catch (error) {
      console.error('Failed to refresh:', error)
    } finally {
      setIsRefreshing(false)
      setRefreshStatus(null)
      setRefreshProgress(null)
    }
  }

  // Clear cache handler
  const handleClearCache = async () => {
    if (!confirm('Reset all stored sharp data?')) return
    try {
      await clearSharpMoneyCacheFn({ data: {} })
      setEntries([])
      setCacheStats(null)
    } catch (error) {
      console.error('Failed to clear cache:', error)
    }
  }

  // Toggle market expansion
  const toggleMarket = (id: string) => {
    setExpandedMarkets((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // Filter entries by sport, minimum edge rating, and hide started games
  const MIN_EDGE_RATING = 65
  const filteredEntries = useMemo(() => {
    const now = new Date()
    const cutoff = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    let filtered = entries.filter((e) => {
      if (showAllEntries) return true
      // Must meet minimum edge rating
      if (e.edgeRating < MIN_EDGE_RATING) return false
      // Hide games that have already started
      const gameTime = parseEventTime(e.eventTime)
      if (gameTime) {
        if (gameTime < now) return false
        if (gameTime > cutoff) return false
      }
      return true
    })
    if (selectedSeriesId !== 'all') {
      filtered = filtered.filter((e) => e.sportSeriesId === Number(selectedSeriesId))
    }
    return filtered
  }, [entries, selectedSeriesId, showAllEntries])

  // Calculate max volume for scale
  const maxVolume = useMemo(() => {
    if (filteredEntries.length === 0) return 1
    return Math.max(
      ...filteredEntries.map(e => e.sideA.totalValue + e.sideB.totalValue),
      1
    )
  }, [filteredEntries])

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Header */}
      <header 
        className="sticky top-0 z-50 border-b border-slate-800/50 bg-slate-950/80 backdrop-blur-sm"
        style={{ paddingTop: 'max(1rem, env(safe-area-inset-top, 0px) + 1rem)' }}
      >
        <div className="mx-auto max-w-7xl px-4 py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
              <Link
                to="/?view=wallets"
                className="flex items-center gap-1 sm:gap-2 text-gray-400 hover:text-white transition-colors flex-shrink-0"
                title="Go to Wallet Tracking"
              >
                <Wallet className="h-5 w-5" />
                <span className="text-sm hidden sm:inline">Wallets</span>
              </Link>
              <div className="flex items-center gap-2 min-w-0">
                <Target className="h-5 w-5 sm:h-6 sm:w-6 text-cyan-400 flex-shrink-0" />
                <h1 className="text-lg sm:text-xl font-bold text-white truncate">Sharp Money</h1>
              </div>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
              {cacheStats?.newestEntry && (
                <span className="text-xs text-gray-500 hidden sm:inline">
                  Updated {formatRelativeTime(cacheStats.newestEntry)}
                </span>
              )}
              <button
                onClick={handleClearCache}
                className="flex items-center gap-1 sm:gap-2 rounded-lg bg-red-500/10 px-2 py-2 sm:px-3 text-sm font-medium text-red-400 hover:bg-red-500/20 transition-colors"
                title="Reset stored data"
              >
                <Trash2 className="h-4 w-4" />
                <span className="hidden sm:inline">Reset Data</span>
              </button>
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="flex items-center gap-1 sm:gap-2 rounded-lg bg-cyan-500/10 px-2 py-2 sm:px-3 text-sm font-medium text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-50 transition-colors"
                title={entries.length === 0 ? "Discover and analyze all new markets" : "Update existing events only (no new discovery)"}
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">{isRefreshing ? 'Refreshing...' : entries.length === 0 ? 'Refresh All' : 'Refresh View'}</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-4 py-6">
        {isRefreshing && (
          <div className="mb-6 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
            <p className="font-semibold">Refreshing data (this can take a while...)</p>
            {refreshStatus && <p className="text-cyan-100/80">{refreshStatus}</p>}
            {refreshProgress && refreshProgress.total > 0 && (
              <div className="mt-2">
                <div className="h-2 w-full rounded-full bg-cyan-500/20">
                  <div
                    className="h-2 rounded-full bg-cyan-400 transition-[width] duration-300"
                    style={{ width: `${Math.min(100, (refreshProgress.current / refreshProgress.total) * 100)}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-cyan-100/80">
                  {refreshProgress.current} / {refreshProgress.total} markets
                </p>
              </div>
            )}
          </div>
        )}
        {/* Sport Filter */}
        <div className="mb-6">
          <div className="sm:hidden">
            <label className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              Sport filter
            </label>
            <select
              value={selectedSeriesId}
              onChange={(event) => setSelectedSeriesId(event.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            >
              {SPORT_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
          </div>
          <div className="hidden flex-wrap gap-2 sm:flex">
            {SPORT_FILTERS.map((filter) => (
              <button
                key={filter.value}
                onClick={() => setSelectedSeriesId(filter.value)}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  selectedSeriesId === filter.value
                    ? 'bg-cyan-500 text-white'
                    : 'bg-slate-800/50 text-gray-400 hover:bg-slate-800 hover:text-white'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {/* Loading State */}
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          </div>
        )}

        {/* Empty State */}
        {!isLoading && filteredEntries.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Target className="h-12 w-12 text-gray-600 mb-4" />
            <h2 className="text-lg font-semibold text-white mb-2">No Sharp Money Data</h2>
            <p className="text-gray-400 mb-4 max-w-md">
              {entries.length > 0 
                ? `No bets with Edge Rating ≥ ${MIN_EDGE_RATING}. Lower quality signals are hidden.`
                : 'Click the Refresh button to analyze top sports markets and identify where the sharp money is flowing.'}
            </p>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              Analyze Markets
            </button>
          </div>
        )}

        {/* Market Cards */}
        {!isLoading && filteredEntries.length > 0 && (
          <div className="space-y-4">
            {/* Show count of hidden entries */}
            {(entries.length > filteredEntries.length || showAllEntries) && (
              <div className="flex items-center justify-end gap-2 text-xs text-gray-500">
                <span>
                  Showing {filteredEntries.length} of {entries.length} • {entries.length - filteredEntries.length} hidden (started or Edge &lt; {MIN_EDGE_RATING})
                </span>
                <button
                  type="button"
                  onClick={() => setShowAllEntries((prev) => !prev)}
                  className="flex items-center gap-1 rounded-md border border-slate-700/60 px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-300 hover:bg-slate-800/60"
                  title={showAllEntries ? 'Hide filtered entries' : 'Show filtered entries'}
                >
                  {showAllEntries ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  {showAllEntries ? 'Filtered' : 'Show All'}
                </button>
              </div>
            )}
            {filteredEntries.map((entry) => (
              <SharpMoneyCard
                key={entry.id}
                entry={entry}
                isExpanded={expandedMarkets.has(entry.id)}
                onToggle={() => toggleMarket(entry.id)}
                maxVolume={maxVolume}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

function SharpMoneyCard({
  entry,
  isExpanded,
  onToggle,
  maxVolume,
}: {
  entry: SharpMoneyCacheEntry
  isExpanded: boolean
  onToggle: () => void
  maxVolume: number
}) {
  const polymarketUrl = buildPolymarketUrl(entry.eventSlug, entry.marketSlug)
  const sideAOdds = formatAmericanOdds(entry.sideA.price)
  const sideBOdds = formatAmericanOdds(entry.sideB.price)
  const oddsLine = sideAOdds && sideBOdds
    ? {
        sideA: `${entry.sideA.label} ${sideAOdds}`,
        sideB: `${entry.sideB.label} ${sideBOdds}`,
      }
    : null

  // Determine which side is "sharp"
  const sharpSideData = entry.sharpSide === 'A' ? entry.sideA : entry.sideB
  const squareSideData = entry.sharpSide === 'A' ? entry.sideB : entry.sideA
  const minHolderCount = Math.min(entry.sideA.holderCount, entry.sideB.holderCount)
  const hasLowHolderCount = minHolderCount < 15
  const hasLowConviction = (entry.sharpSideValueRatio ?? 0.5) < 0.35
  const sharpSideTopHolders = sharpSideData.topHolders.slice().sort((a, b) => b.amount - a.amount)
  const sharpTop1 = sharpSideTopHolders[0]?.amount ?? 0
  const sharpTop3 = sharpSideTopHolders.slice(0, 3).reduce((sum, holder) => sum + holder.amount, 0)
  const sharpSideTotal = sharpSideData.totalValue
  const hasHighConcentration = sharpSideTotal > 0 && (sharpTop1 / sharpSideTotal >= 0.6 || sharpTop3 / sharpSideTotal >= 0.8)

  // Calculate volume percentage and get heat map color
  const totalVolume = entry.sideA.totalValue + entry.sideB.totalValue
  const volumePercent = Math.min((totalVolume / maxVolume) * 100, 100)
  const getVolumeColor = (percent: number) => {
    if (percent >= 80) return 'bg-gradient-to-r from-red-500 to-orange-500' // Hot - high volume
    if (percent >= 60) return 'bg-gradient-to-r from-orange-500 to-amber-500' // Warm - medium-high
    if (percent >= 40) return 'bg-gradient-to-r from-amber-500 to-yellow-500' // Medium
    if (percent >= 20) return 'bg-gradient-to-r from-cyan-500 to-blue-500' // Cool - medium-low
    return 'bg-gradient-to-r from-blue-500 to-indigo-500' // Cold - low volume
  }

  // Convert Edge Rating to letter grade
  const getBetGrade = (edgeRating: number): { grade: string; color: string; bgColor: string; borderColor: string } => {
    if (edgeRating >= 90) {
      return { grade: 'A+', color: 'text-emerald-400', bgColor: 'bg-emerald-500/20', borderColor: 'border-emerald-500/50' }
    }
    if (edgeRating >= 80) {
      return { grade: 'A', color: 'text-emerald-400', bgColor: 'bg-emerald-500/15', borderColor: 'border-emerald-500/40' }
    }
    if (edgeRating >= 70) {
      return { grade: 'B', color: 'text-cyan-400', bgColor: 'bg-cyan-500/15', borderColor: 'border-cyan-500/40' }
    }
    if (edgeRating >= 65) {
      return { grade: 'C', color: 'text-amber-400', bgColor: 'bg-amber-500/15', borderColor: 'border-amber-500/40' }
    }
    return { grade: 'D', color: 'text-gray-400', bgColor: 'bg-slate-800/50', borderColor: 'border-slate-700' }
  }
  
  const betGrade = getBetGrade(entry.edgeRating)

  return (
    <div className="rounded-xl border border-slate-800/60 bg-slate-900/50 overflow-hidden">
      {/* Card Header */}
      <div
        className="cursor-pointer hover:bg-slate-800/30 transition-colors"
        onClick={onToggle}
      >
        {/* Mobile: Stacked layout */}
        <div className="block sm:hidden">
          {/* Top Row - League, Time, Actions */}
          <div className="flex items-center justify-between p-3 pb-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              {entry.sportSeriesId && (
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-gray-500 bg-slate-800/50 px-1.5 py-0.5 rounded">
                  {getSeriesLabel(entry.sportSeriesId)}
                </span>
              )}
              {entry.eventTime && (
                <span className="text-[0.65rem] font-medium text-cyan-400/80 bg-cyan-900/30 px-1.5 py-0.5 rounded">
                  {formatEventTime(entry.eventTime)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {polymarketUrl && (
                <a
                  href={polymarketUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1.5 text-gray-400 hover:text-cyan-400 transition-colors flex-shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
              {isExpanded ? (
                <ChevronUp className="h-5 w-5 text-gray-400 flex-shrink-0" />
              ) : (
                <ChevronDown className="h-5 w-5 text-gray-400 flex-shrink-0" />
              )}
            </div>
          </div>

          {/* Title and Sharp Indicator */}
          <div className="px-3 pb-2">
            <h3 className="text-base font-semibold text-white leading-tight mb-1">
              {entry.marketTitle}
            </h3>
            {entry.sharpSide !== 'EVEN' && (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/40">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span className="text-sm font-bold text-emerald-400 uppercase tracking-wide">
                    Bet: {sharpSideData.label}
                  </span>
                </div>
                {hasLowHolderCount && (
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
                    <span className="text-[0.65rem] font-semibold text-amber-300 uppercase tracking-wide">
                      Low holders ({minHolderCount})
                    </span>
                  </div>
                )}
                {hasLowConviction && (
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
                    <span className="text-[0.65rem] font-semibold text-amber-300 uppercase tracking-wide">
                      Low conviction
                    </span>
                  </div>
                )}
                {hasHighConcentration && (
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
                    <span className="text-[0.65rem] font-semibold text-amber-300 uppercase tracking-wide">
                      Concentrated
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Metrics Row - Mobile */}
          <div className="px-3 pb-3 flex items-center gap-2">
            {/* Bet Grade - Single value indicator (most prominent) */}
            <div className={`flex flex-col items-center justify-center px-2.5 py-1.5 rounded-lg border-2 ${betGrade.bgColor} ${betGrade.borderColor} flex-shrink-0 h-[56px] w-[50px]`}>
              <span className={`text-xl font-black ${betGrade.color}`}>
                {betGrade.grade}
              </span>
              <span className="text-[0.55rem] font-semibold text-gray-400 uppercase tracking-wider mt-0.5">Bet</span>
            </div>
            
            {/* Edge Rating - PRIMARY */}
            <div className="flex flex-col items-center justify-center flex-shrink-0 h-[56px] w-[44px]">
              <span className={`text-lg font-bold ${
                entry.edgeRating >= 90 ? 'text-emerald-400' :
                entry.edgeRating >= 75 ? 'text-cyan-400' :
                entry.edgeRating >= 65 ? 'text-amber-400' :
                entry.edgeRating >= 50 ? 'text-gray-300' :
                'text-gray-500'
              }`}>
                {entry.edgeRating}
              </span>
              <span className="text-[0.6rem] text-gray-500 uppercase tracking-wider">Edge</span>
            </div>
            {entry.sharpSide !== 'EVEN' && (
              <>
                {/* Diff - Secondary */}
                <div className="flex flex-col items-center justify-center flex-shrink-0 h-[56px] w-[44px]">
                  <span className={`text-lg font-bold ${
                    entry.scoreDifferential >= 40 ? 'text-emerald-400' :
                    entry.scoreDifferential >= 30 ? 'text-emerald-400' :
                    entry.scoreDifferential >= 20 ? 'text-amber-400' :
                    'text-gray-400'
                  }`}>
                    {entry.scoreDifferential.toFixed(0)}
                  </span>
                  <span className="text-[0.6rem] text-gray-500 uppercase tracking-wider">Diff</span>
                </div>
                {/* Volume - Tertiary */}
                <div className="flex flex-col items-center justify-center flex-shrink-0 h-[56px] w-[56px]">
                  <span className="text-lg font-bold text-gray-400 mb-1">
                    {formatUsdCompact(totalVolume)}
                  </span>
                  <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden mb-0.5">
                    <div
                      className={`h-full ${getVolumeColor(volumePercent)} rounded-full transition-all`}
                      style={{
                        width: `${volumePercent}%`
                      }}
                    />
                  </div>
                  <span className="text-[0.6rem] text-gray-500 uppercase tracking-wider">Volume</span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Desktop: Original horizontal layout */}
        <div className="hidden sm:grid sm:grid-cols-[1fr_auto] items-start gap-4 p-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {entry.sportSeriesId && (
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-gray-500 bg-slate-800/50 px-2 py-0.5 rounded">
                  {getSeriesLabel(entry.sportSeriesId)}
                </span>
              )}
              {entry.eventTime && (
                <span className="text-[0.65rem] font-medium text-cyan-400/80 bg-cyan-900/30 px-2 py-0.5 rounded">
                  {formatEventTime(entry.eventTime)}
                </span>
              )}
            </div>
            <h3 className="text-base font-semibold text-white truncate pr-4">
              {entry.marketTitle}
            </h3>
            {entry.sharpSide !== 'EVEN' && (
              <div className="flex items-center gap-2 mt-2">
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/40">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span className="text-sm font-bold text-emerald-400 uppercase tracking-wide">
                    Bet: {sharpSideData.label}
                  </span>
                </div>
                {hasLowHolderCount && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
                    <span className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
                      Low holders ({minHolderCount})
                    </span>
                  </div>
                )}
                {hasLowConviction && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
                    <span className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
                      Low conviction
                    </span>
                  </div>
                )}
                {hasHighConcentration && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
                    <span className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
                      Concentrated
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            {/* Bet Grade - Single value indicator (most prominent) */}
            <div className={`flex flex-col items-center justify-center px-3 py-2 rounded-xl border-2 ${betGrade.bgColor} ${betGrade.borderColor} flex-shrink-0 h-[60px] w-[56px]`}>
              <span className={`text-2xl font-black ${betGrade.color}`}>
                {betGrade.grade}
              </span>
              <span className="text-[0.6rem] font-semibold text-gray-400 uppercase tracking-wider mt-0.5">Bet</span>
            </div>
            
            {/* Edge Rating - PRIMARY ranking indicator */}
            <div className="flex flex-col items-center justify-center flex-shrink-0 h-[60px] w-[48px]">
              <span className={`text-xl font-bold ${
                entry.edgeRating >= 90 ? 'text-emerald-400' :
                entry.edgeRating >= 75 ? 'text-cyan-400' :
                entry.edgeRating >= 65 ? 'text-amber-400' :
                entry.edgeRating >= 50 ? 'text-gray-300' :
                'text-gray-500'
              }`}>
                {entry.edgeRating}
              </span>
              <span className="text-[0.6rem] text-gray-500 uppercase tracking-wider">Edge</span>
            </div>
            
            {/* Score Differential - Secondary context (signal strength) */}
            {entry.sharpSide !== 'EVEN' ? (
              <div className="flex flex-col items-center justify-center flex-shrink-0 h-[60px] w-[48px]">
                <span className={`text-xl font-bold ${
                  entry.scoreDifferential >= 40 ? 'text-emerald-400' :
                  entry.scoreDifferential >= 30 ? 'text-emerald-400' :
                  entry.scoreDifferential >= 20 ? 'text-amber-400' :
                  'text-gray-400'
                }`}>
                  {entry.scoreDifferential.toFixed(0)}
                </span>
                <span className="text-[0.6rem] text-gray-500 uppercase tracking-wider">Diff</span>
              </div>
            ) : (
              <div className="w-[48px] flex-shrink-0" /> // Spacer to maintain alignment
            )}
            
            {/* Volume indicator - Tertiary (validation) */}
            {entry.sharpSide !== 'EVEN' ? (
              <div className="flex flex-col items-center justify-center flex-shrink-0 h-[60px] w-[60px]">
                <span className="text-xl font-bold text-gray-400 mb-1">
                  {formatUsdCompact(totalVolume)}
                </span>
                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mb-0.5">
                  <div
                    className={`h-full ${getVolumeColor(volumePercent)} rounded-full transition-all`}
                    style={{
                      width: `${volumePercent}%`
                    }}
                  />
                </div>
                <span className="text-[0.6rem] text-gray-500 uppercase tracking-wider">Volume</span>
              </div>
            ) : (
              <div className="w-[60px] flex-shrink-0" /> // Spacer to maintain alignment
            )}
            
            {polymarketUrl && (
              <a
                href={polymarketUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 text-gray-400 hover:text-cyan-400 transition-colors flex-shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
            {isExpanded ? (
              <ChevronUp className="h-5 w-5 text-gray-400 flex-shrink-0" />
            ) : (
              <ChevronDown className="h-5 w-5 text-gray-400 flex-shrink-0" />
            )}
          </div>
        </div>
      </div>

      {/* Odds + Unified Edge Bar */}
      <div className="px-4 pb-4">
        {oddsLine && (
          <div className="mb-2">
            <span className="inline-flex items-center gap-3 rounded-full bg-slate-800/60 px-3 py-1 text-xs font-semibold text-slate-200">
              <span className={entry.sharpSide === 'A' ? 'text-emerald-300' : 'text-slate-200'}>
                {oddsLine.sideA}
              </span>
              <span className="text-slate-500">|</span>
              <span className={entry.sharpSide === 'B' ? 'text-emerald-300' : 'text-slate-200'}>
                {oddsLine.sideB}
              </span>
            </span>
          </div>
        )}
        <UnifiedEdgeBar 
          sideA={entry.sideA} 
          sideB={entry.sideB} 
          sharpSide={entry.sharpSide}
          scoreDifferential={entry.scoreDifferential}
        />
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t border-slate-800/60 p-4">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Side A */}
            <SideDetails
              side={entry.sideA}
              isSharp={entry.sharpSide === 'A'}
              scoreDiff={entry.scoreDifferential}
            />
            {/* Side B */}
            <SideDetails
              side={entry.sideB}
              isSharp={entry.sharpSide === 'B'}
              scoreDiff={entry.scoreDifferential}
            />
          </div>
          <div className="mt-4 text-xs text-gray-500 text-center">
            Updated {formatRelativeTime(entry.updatedAt)}
          </div>
        </div>
      )}
    </div>
  )
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const config = {
    HIGH: {
      bg: 'bg-emerald-500/20',
      text: 'text-emerald-400',
      border: 'border-emerald-500/30',
    },
    MEDIUM: {
      bg: 'bg-amber-500/20',
      text: 'text-amber-400',
      border: 'border-amber-500/30',
    },
    LOW: {
      bg: 'bg-slate-500/20',
      text: 'text-gray-400',
      border: 'border-slate-500/30',
    },
  }[confidence] ?? { bg: 'bg-slate-500/20', text: 'text-gray-400', border: 'border-slate-500/30' }

  return (
    <span
      className={`inline-flex items-center text-[0.65rem] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${config.bg} ${config.text} ${config.border}`}
    >
      {confidence}
    </span>
  )
}

function UnifiedEdgeBar({
  sideA,
  sideB,
  sharpSide,
  scoreDifferential,
}: {
  sideA: SharpMoneyCacheEntry['sideA']
  sideB: SharpMoneyCacheEntry['sideB']
  sharpSide: 'A' | 'B' | 'EVEN'
  scoreDifferential?: number
}) {
  // Calculate money split (what % of total dollars is on each side)
  const totalValue = sideA.totalValue + sideB.totalValue
  const sideAMoneyPercent = totalValue > 0 ? (sideA.totalValue / totalValue) * 100 : 50
  const sideBMoneyPercent = 100 - sideAMoneyPercent
  
  const isSharpA = sharpSide === 'A'
  const scoreDiff = scoreDifferential ?? Math.abs(sideA.sharpScore - sideB.sharpScore)

  // For EVEN, show balanced bar
  if (sharpSide === 'EVEN') {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <div>
            <span className="font-semibold text-gray-400">{sideA.label}</span>
            <span className="text-gray-600 ml-2">({Math.round(sideA.sharpScore)})</span>
          </div>
          <div>
            <span className="text-gray-600 mr-2">({Math.round(sideB.sharpScore)})</span>
            <span className="font-semibold text-gray-400">{sideB.label}</span>
          </div>
        </div>
        <div className="h-7 bg-slate-800 rounded-lg overflow-hidden relative">
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xs font-medium text-gray-500">No clear edge - money split evenly</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* Labels row - sharp side highlighted with checkmark */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5">
          {isSharpA && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
          <span className={`font-semibold ${isSharpA ? 'text-emerald-400' : 'text-gray-500'}`}>
            {sideA.label}
          </span>
          <span className={`${isSharpA ? 'text-emerald-400/70' : 'text-gray-600'}`}>
            ({Math.round(sideA.sharpScore)})
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className={`px-2 py-0.5 rounded ${
            scoreDiff >= 40 ? 'bg-emerald-500/20' :
            scoreDiff >= 30 ? 'bg-emerald-500/15' :
            scoreDiff >= 20 ? 'bg-amber-500/20' :
            'bg-slate-800'
          }`}>
            <span className={`text-xs font-bold ${
              scoreDiff >= 40 ? 'text-emerald-400' :
              scoreDiff >= 30 ? 'text-emerald-400' :
              scoreDiff >= 20 ? 'text-amber-400' :
              'text-gray-400'
            }`}>
              +{Math.round(scoreDiff)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`${!isSharpA ? 'text-emerald-400/70' : 'text-gray-600'}`}>
            ({Math.round(sideB.sharpScore)})
          </span>
          <span className={`font-semibold ${!isSharpA ? 'text-emerald-400' : 'text-gray-500'}`}>
            {sideB.label}
          </span>
          {!isSharpA && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
        </div>
      </div>
      
      {/* Money split bar - shows where the actual dollars are */}
      <div className="h-7 rounded-lg overflow-hidden relative flex border-2 border-slate-800">
        {/* Side A money bar */}
        <div
          className={`h-full transition-all duration-500 flex items-center justify-center min-w-[60px] relative ${
            isSharpA 
              ? 'bg-gradient-to-r from-emerald-600 to-emerald-500 ring-2 ring-emerald-400 ring-offset-0' 
              : 'bg-slate-700'
          }`}
          style={{ width: `${Math.max(sideAMoneyPercent, 15)}%` }}
        >
          {isSharpA && (
            <div className="absolute inset-0 border-2 border-emerald-300/50 rounded-l-lg pointer-events-none" />
          )}
          <span className={`text-xs font-bold ${isSharpA ? 'text-white drop-shadow-sm' : 'text-gray-400'}`}>
            {formatUsdCompact(sideA.totalValue)}
          </span>
        </div>
        
        {/* Divider */}
        <div className="w-0.5 bg-slate-900" />
        
        {/* Side B money bar */}
        <div
          className={`h-full transition-all duration-500 flex items-center justify-center min-w-[60px] relative ${
            !isSharpA 
              ? 'bg-gradient-to-l from-emerald-600 to-emerald-500 ring-2 ring-emerald-400 ring-offset-0' 
              : 'bg-slate-700'
          }`}
          style={{ width: `${Math.max(sideBMoneyPercent, 15)}%` }}
        >
          {!isSharpA && (
            <div className="absolute inset-0 border-2 border-emerald-300/50 rounded-r-lg pointer-events-none" />
          )}
          <span className={`text-xs font-bold ${!isSharpA ? 'text-white drop-shadow-sm' : 'text-gray-400'}`}>
            {formatUsdCompact(sideB.totalValue)}
          </span>
        </div>
      </div>
      
      {/* Summary line - Conviction */}
      <div className="flex items-center justify-center gap-2">
        <span className="text-xs text-gray-500">Conviction:</span>
        <span className={`text-sm font-bold ${
          (isSharpA ? sideAMoneyPercent : sideBMoneyPercent) >= 40 && (isSharpA ? sideAMoneyPercent : sideBMoneyPercent) <= 60
            ? 'text-emerald-400' 
            : (isSharpA ? sideAMoneyPercent : sideBMoneyPercent) >= 30 && (isSharpA ? sideAMoneyPercent : sideBMoneyPercent) <= 70
            ? 'text-amber-400'
            : 'text-gray-400'
        }`}>
          {Math.round(isSharpA ? sideAMoneyPercent : sideBMoneyPercent)}%
        </span>
      </div>
    </div>
  )
}

function SideDetails({
  side,
  isSharp,
  scoreDiff,
}: {
  side: SharpMoneyCacheEntry['sideA'] | SharpMoneyCacheEntry['sideB']
  isSharp: boolean
  scoreDiff: number
}) {
  return (
    <div
      className={`rounded-lg p-4 ${
        isSharp ? 'bg-emerald-500/10 border border-emerald-500/30' : 'bg-slate-800/30'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h4 className={`font-semibold ${isSharp ? 'text-emerald-400' : 'text-white'}`}>
            {side.label}
          </h4>
          {isSharp && (
            <span className="flex items-center gap-1 text-[0.65rem] font-semibold uppercase text-emerald-400 bg-emerald-500/20 px-2 py-0.5 rounded">
              <Zap className="h-3 w-3" /> Sharp
            </span>
          )}
        </div>
        <span className={`text-lg font-bold ${isSharp ? 'text-emerald-400' : 'text-cyan-400'}`}>
          {Math.round(side.sharpScore)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm mb-4">
        <div>
          <span className="text-gray-500">Total Value</span>
          <p className="font-semibold text-white">{formatUsdCompact(side.totalValue)}</p>
        </div>
      </div>

      {/* Top Holders */}
      <div>
        <h5 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
          Top Holders
        </h5>
        <div className="grid grid-cols-[16px_20px_minmax(0,1fr)_80px_56px_56px_80px] items-center gap-2 text-[0.6rem] uppercase tracking-wider text-gray-500 mb-1">
          <span />
          <span />
          <span>Holder</span>
          <span className="text-right">PnL $</span>
          <span className="text-right">PnL u</span>
          <span className="text-right">Stake u</span>
          <span className="text-right">Stake $</span>
        </div>
        <ul className="space-y-1.5">
          {side.topHolders.map((holder, idx) => (
            <li
              key={holder.proxyWallet}
              className="grid grid-cols-[16px_20px_minmax(0,1fr)_80px_56px_56px_80px] items-center gap-2 text-sm"
            >
              <span className="text-gray-500">{idx + 1}.</span>
              {holder.profileImage ? (
                <img
                  src={holder.profileImage}
                  alt=""
                  className="h-5 w-5 rounded-full object-cover"
                />
              ) : (
                <div className="h-5 w-5 rounded-full bg-slate-700 flex items-center justify-center">
                  <User className="h-3 w-3 text-gray-400" />
                </div>
              )}
              <a
                href={buildPolymarketProfileUrl(holder.proxyWallet)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 truncate text-gray-300 hover:text-emerald-400 transition-colors cursor-pointer"
                onClick={(e) => e.stopPropagation()}
              >
                {truncateWalletName(holder.name || holder.pseudonym) || `${holder.proxyWallet.slice(0, 6)}...${holder.proxyWallet.slice(-4)}`}
              </a>
              <div className="flex justify-end">
                <PnlBadge pnlAll={holder.pnlAll} />
              </div>
              <div className="flex justify-end">
                <UnitBadge pnlUnits={holder.pnlAllUnits} unitSize={holder.unitSize} />
              </div>
              <div className="flex justify-end">
                <StakeUnitBadge stakeUsd={holder.amount} unitSize={holder.unitSize} />
              </div>
              <span className="text-gray-400 text-xs text-right">
                {formatUsdCompact(holder.amount)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function PnlBadge({ pnlAll }: { pnlAll?: number | null }) {
  if (pnlAll === null || pnlAll === undefined) {
    return null
  }

  const isPositive = pnlAll >= 0

  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[0.6rem] font-semibold px-1.5 py-0.5 rounded ${
        isPositive
          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
          : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
      }`}
    >
      {isPositive ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
      {formatUsdCompact(Math.abs(pnlAll))}
    </span>
  )
}

function UnitBadge({
  pnlUnits,
  unitSize,
}: {
  pnlUnits?: number | null
  unitSize?: number | null
}) {
  const formatted = formatUnits(pnlUnits === null || pnlUnits === undefined ? null : Math.abs(pnlUnits))
  if (!formatted) {
    return null
  }

  const isPositive = (pnlUnits ?? 0) >= 0
  const title =
    unitSize && Number.isFinite(unitSize)
      ? `${formatted}u • unit size ${formatUsdCompact(unitSize)}`
      : `${formatted}u`

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-0.5 text-[0.6rem] font-semibold px-1.5 py-0.5 rounded ${
        isPositive
          ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
          : 'bg-rose-500/10 text-rose-300 border border-rose-500/20'
      }`}
    >
      {formatted}u
    </span>
  )
}

function StakeUnitBadge({
  stakeUsd,
  unitSize,
}: {
  stakeUsd: number
  unitSize?: number | null
}) {
  if (!unitSize || unitSize <= 0) {
    return null
  }

  const stakeUnits = stakeUsd / unitSize
  if (!Number.isFinite(stakeUnits)) {
    return null
  }

  const formatted = formatUnits(Math.abs(stakeUnits))
  if (!formatted) {
    return null
  }

  const title = `${formatted}x typical stake • unit size ${formatUsdCompact(unitSize)}`

  const tone =
    stakeUnits < 0.5
      ? 'bg-slate-500/10 text-slate-300 border border-slate-500/20'
      : stakeUnits <= 2
        ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
        : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-0.5 text-[0.6rem] font-semibold px-1.5 py-0.5 rounded ${tone}`}
    >
      {formatted}x
    </span>
  )
}
