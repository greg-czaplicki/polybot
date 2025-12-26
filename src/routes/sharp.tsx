import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  RefreshCw,
  Target,
  TrendingUp,
  TrendingDown,
  Trophy,
  User,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { getSportLabel } from '@/lib/sports'
import {
  getSharpMoneyCacheFn,
  getSharpMoneyCacheStatsFn,
  refreshMarketSharpnessFn,
  fetchTrendingSportsMarketsFn,
  clearSharpMoneyCacheFn,
  type SharpMoneyCacheEntry,
} from '../server/api/sharp-money'

export const Route = createFileRoute('/sharp')({
  component: SharpMoneyPage,
})

// Sport filter options
const SPORT_FILTERS = [
  { value: 'all', label: 'All Sports' },
  { value: 'nfl', label: 'NFL' },
  { value: 'nba', label: 'NBA' },
  { value: 'ncaaf', label: 'College Football' },
  { value: 'ncaab', label: 'College Basketball' },
  { value: 'mlb', label: 'MLB' },
  { value: 'nhl', label: 'NHL' },
  { value: 'epl', label: 'Premier League' },
]

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

function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '$0'
  }
  if (Math.abs(value) >= 1000) {
    return USD_COMPACT_FORMATTER.format(value)
  }
  return USD_FORMATTER.format(value)
}

function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestamp

  if (diff < 60) return 'Just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function formatEventTime(isoDate?: string): string | null {
  if (!isoDate) return null
  
  try {
    const date = new Date(isoDate)
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

function buildPolymarketUrl(eventSlug?: string, slug?: string): string | null {
  if (eventSlug && slug) {
    return `https://polymarket.com/event/${eventSlug}/${slug}`
  }
  if (eventSlug) {
    return `https://polymarket.com/event/${eventSlug}`
  }
  return null
}

function SharpMoneyPage() {
  const [entries, setEntries] = useState<SharpMoneyCacheEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedSport, setSelectedSport] = useState('all')
  const [expandedMarkets, setExpandedMarkets] = useState<Set<string>>(new Set())
  const [cacheStats, setCacheStats] = useState<{
    totalEntries: number
    newestEntry?: number
  } | null>(null)

  // Load cached data
  const loadCache = useCallback(async () => {
    setIsLoading(true)
    try {
      const [cacheResult, statsResult] = await Promise.all([
        getSharpMoneyCacheFn({
          data: {
            sportTag: selectedSport === 'all' ? undefined : selectedSport,
            limit: 50,
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
  }, [selectedSport])

  // Initial load
  useEffect(() => {
    loadCache()
  }, [loadCache])

  // Manual refresh - fetches fresh data from APIs
  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      // Fetch trending markets
      console.log('[sharp] Fetching with selectedSport:', selectedSport)
      const { markets } = await fetchTrendingSportsMarketsFn({
        data: {
          limit: 50,
          sportTags: selectedSport === 'all' ? undefined : [selectedSport],
        },
      })

      if (markets && markets.length > 0) {
        // Analyze more markets to get variety across all sports (up to 25)
        const marketsToAnalyze = markets.slice(0, 25)
        console.log(`[sharp] Analyzing ${marketsToAnalyze.length} markets...`)
        
        for (const market of marketsToAnalyze) {
          try {
            await refreshMarketSharpnessFn({
              data: {
                conditionId: market.conditionId,
                marketTitle: market.title,
                marketSlug: market.slug,
                eventSlug: market.eventSlug,
                sportTag: market.sportTag ?? undefined,
                outcomes: market.outcomes,
              },
            })
          } catch (error) {
            console.error('Failed to refresh market:', market.title, error)
          }
          // Small delay between markets
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }

      // Reload cache
      await loadCache()
    } catch (error) {
      console.error('Failed to refresh:', error)
    } finally {
      setIsRefreshing(false)
    }
  }

  // Clear cache handler
  const handleClearCache = async () => {
    if (!confirm('Clear all cached sharp money data?')) return
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

  // Filter entries by sport
  const filteredEntries = useMemo(() => {
    if (selectedSport === 'all') {
      return entries
    }
    return entries.filter((e) => e.sportTag === selectedSport)
  }, [entries, selectedSport])

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-slate-800/50 bg-slate-950/80 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link
                to="/"
                className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
              >
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <div className="flex items-center gap-2">
                <Target className="h-6 w-6 text-cyan-400" />
                <h1 className="text-xl font-bold text-white">Sharp Money</h1>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {cacheStats?.newestEntry && (
                <span className="text-xs text-gray-500">
                  Updated {formatRelativeTime(cacheStats.newestEntry)}
                </span>
              )}
              <button
                onClick={handleClearCache}
                className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm font-medium text-red-400 hover:bg-red-500/20 transition-colors"
              >
                Clear Cache
              </button>
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="flex items-center gap-2 rounded-lg bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-50 transition-colors"
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                {isRefreshing ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-4 py-6">
        {/* Sport Filter */}
        <div className="mb-6 flex flex-wrap gap-2">
          {SPORT_FILTERS.map((filter) => (
            <button
              key={filter.value}
              onClick={() => setSelectedSport(filter.value)}
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                selectedSport === filter.value
                  ? 'bg-cyan-500 text-white'
                  : 'bg-slate-800/50 text-gray-400 hover:bg-slate-800 hover:text-white'
              }`}
            >
              {filter.label}
            </button>
          ))}
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
              Click the Refresh button to analyze top sports markets and identify where the sharp money is flowing.
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
            {filteredEntries.map((entry) => (
              <SharpMoneyCard
                key={entry.id}
                entry={entry}
                isExpanded={expandedMarkets.has(entry.id)}
                onToggle={() => toggleMarket(entry.id)}
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
}: {
  entry: SharpMoneyCacheEntry
  isExpanded: boolean
  onToggle: () => void
}) {
  const polymarketUrl = buildPolymarketUrl(entry.eventSlug, entry.marketSlug)

  // Determine which side is "sharp"
  const sharpSideData = entry.sharpSide === 'A' ? entry.sideA : entry.sideB
  const squareSideData = entry.sharpSide === 'A' ? entry.sideB : entry.sideA

  return (
    <div className="rounded-xl border border-slate-800/60 bg-slate-900/50 overflow-hidden">
      {/* Card Header */}
      <div
        className="flex items-center justify-between p-4 cursor-pointer hover:bg-slate-800/30 transition-colors"
        onClick={onToggle}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {entry.sportTag && (
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-gray-500 bg-slate-800/50 px-2 py-0.5 rounded">
                {getSportLabel(entry.sportTag) ?? entry.sportTag.toUpperCase()}
              </span>
            )}
            <ConfidenceBadge confidence={entry.confidence} />
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
            <div className="flex items-center gap-1.5 mt-2">
              <Zap className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-medium text-amber-400">
                Sharp: {sharpSideData.label}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {polymarketUrl && (
            <a
              href={polymarketUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 text-gray-400 hover:text-cyan-400 transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
          {isExpanded ? (
            <ChevronUp className="h-5 w-5 text-gray-400" />
          ) : (
            <ChevronDown className="h-5 w-5 text-gray-400" />
          )}
        </div>
      </div>

      {/* Unified Edge Bar */}
      <div className="px-4 pb-4">
        <UnifiedEdgeBar 
          sideA={entry.sideA} 
          sideB={entry.sideB} 
          sharpSide={entry.sharpSide}
          conviction={entry.sharpSideValueRatio}
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
  conviction,
}: {
  sideA: SharpMoneyCacheEntry['sideA']
  sideB: SharpMoneyCacheEntry['sideB']
  sharpSide: 'A' | 'B' | 'EVEN'
  conviction?: number
}) {
  // Calculate proportional dominance (what % of total score does sharp side have)
  // e.g., 62 vs 26 → 62/(62+26) = 70%
  const totalScore = sideA.sharpScore + sideB.sharpScore
  const sharpScore = sharpSide === 'A' ? sideA.sharpScore : sideB.sharpScore
  const dominance = totalScore > 0 ? (sharpScore / totalScore) * 100 : 50
  
  // Determine colors based on conviction
  const convictionPercent = conviction ? Math.round(conviction * 100) : 50
  let barColor = 'bg-amber-500'
  let glowClass = ''
  
  if (conviction !== undefined) {
    if (conviction >= 0.4) {
      // Strong conviction - bright green gradient with glow
      barColor = 'bg-gradient-to-r from-emerald-400 to-emerald-500'
      glowClass = 'shadow-lg shadow-emerald-500/30'
    } else if (conviction >= 0.25) {
      // Moderate conviction - amber
      barColor = 'bg-amber-500'
    } else {
      // Low conviction - muted/faded
      barColor = 'bg-amber-500/50'
    }
  }

  // For EVEN, show balanced bar
  if (sharpSide === 'EVEN') {
    return (
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium text-gray-400 w-24 truncate text-right">
          {sideA.label}
        </span>
        <div className="flex-1 h-5 bg-slate-800 rounded-full overflow-hidden relative">
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[0.65rem] font-medium text-gray-500">No clear edge</span>
          </div>
        </div>
        <span className="text-xs font-medium text-gray-400 w-24 truncate">
          {sideB.label}
        </span>
      </div>
    )
  }

  // Determine which side is sharp
  const isSharpA = sharpSide === 'A'

  return (
    <div className="space-y-1.5">
      {/* Labels row */}
      <div className="flex items-center justify-between text-xs">
        <span className={`font-semibold ${isSharpA ? 'text-amber-400' : 'text-gray-500'}`}>
          {sideA.label}
        </span>
        <span className={`font-semibold ${!isSharpA ? 'text-amber-400' : 'text-gray-500'}`}>
          {sideB.label}
        </span>
      </div>
      
      {/* Unified bar - fills proportionally based on score dominance */}
      <div className={`h-6 bg-slate-800 rounded-full overflow-hidden relative ${glowClass}`}>
        {/* Bar fill - width = proportional dominance */}
        <div
          className={`absolute top-0 h-full rounded-full transition-all duration-500 ${barColor} ${
            isSharpA ? 'left-0' : 'right-0'
          }`}
          style={{ width: `${dominance}%` }}
        />
        
        {/* Score labels inside bar */}
        <div className="absolute inset-0 flex items-center justify-between px-3">
          <span className={`text-xs font-bold drop-shadow-sm ${
            isSharpA ? 'text-white' : 'text-gray-400'
          }`}>
            {Math.round(sideA.sharpScore)}
          </span>
          <span className={`text-xs font-bold drop-shadow-sm ${
            !isSharpA ? 'text-white' : 'text-gray-400'
          }`}>
            {Math.round(sideB.sharpScore)}
          </span>
        </div>
      </div>
      
      {/* Conviction indicator */}
      {conviction !== undefined && (
        <div className="flex items-center justify-center">
          <div className="flex items-center gap-1.5">
            <div className={`h-2 w-2 rounded-full ${
              conviction >= 0.4 ? 'bg-emerald-400' : conviction >= 0.25 ? 'bg-amber-400' : 'bg-rose-400'
            }`} />
            <span className={`text-xs font-medium ${
              conviction >= 0.4 ? 'text-emerald-400' : conviction >= 0.25 ? 'text-amber-400' : 'text-rose-400'
            }`}>
              {convictionPercent}% conviction
            </span>
          </div>
        </div>
      )}
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
        isSharp ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-slate-800/30'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h4 className={`font-semibold ${isSharp ? 'text-amber-400' : 'text-white'}`}>
            {side.label}
          </h4>
          {isSharp && (
            <span className="flex items-center gap-1 text-[0.65rem] font-semibold uppercase text-amber-400 bg-amber-500/20 px-2 py-0.5 rounded">
              <Zap className="h-3 w-3" /> Sharp
            </span>
          )}
        </div>
        <span className={`text-lg font-bold ${isSharp ? 'text-amber-400' : 'text-cyan-400'}`}>
          {Math.round(side.sharpScore)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm mb-4">
        <div>
          <span className="text-gray-500">Total Value</span>
          <p className="font-semibold text-white">{formatUsdCompact(side.totalValue)}</p>
        </div>
        <div>
          <span className="text-gray-500">Holders</span>
          <p className="font-semibold text-white">{side.holderCount}</p>
        </div>
      </div>

      {/* Top Holders */}
      <div>
        <h5 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
          Top Holders
        </h5>
        <ul className="space-y-1.5">
          {side.topHolders.map((holder, idx) => (
            <li
              key={holder.proxyWallet}
              className="flex items-center gap-2 text-sm"
            >
              <span className="text-gray-500 w-4">{idx + 1}.</span>
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
              <span className="flex-1 truncate text-gray-300">
                {holder.name || holder.pseudonym || `${holder.proxyWallet.slice(0, 6)}...${holder.proxyWallet.slice(-4)}`}
              </span>
              <PnlBadge pnlAll={holder.pnlAll} />
              <span className="text-gray-400 text-xs">
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
