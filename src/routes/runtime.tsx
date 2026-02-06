import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'

import { AuthGate } from '@/components/auth-gate'
import {
  backfillSharpMoneyHistoryFn,
  fetchTrendingSportsMarketsFn,
  getRuntimeMarketStatsFn,
} from '../server/api/sharp-money'

export const Route = createFileRoute('/runtime')({
  component: RuntimePage,
})

const USD_COMPACT_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})

function formatUsdCompact(value: number): string {
  return USD_COMPACT_FORMATTER.format(value)
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return 'Never'
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestamp
  if (diff < 60) return 'Just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function RuntimePage() {
  const [stats, setStats] = useState<{
    fetchedAt: number
    totalMarkets: number
    expandedEventCount: number
    expandedMarketCount: number
    tagStats: Array<{
      tag: string
      seriesId: number
      count: number
      markets: Array<{ title: string; volume: number; eventSlug?: string; slug?: string }>
    }>
    combinedTagStats: Array<{
      tag: string
      count: number
      markets: Array<{ title: string; volume: number; eventSlug?: string; slug?: string }>
    }>
    filteredTagStats: Array<{
      tag: string
      count: number
      markets: Array<{ title: string; volume: number; eventSlug?: string; slug?: string }>
    }>
    eventStats: Array<{
      tag: string
      seriesId: number
      eventCount: number
      marketCount: number
    }>
    eventDetails: Array<{
      tag: string
      seriesId: number
      eventSlug: string
      eventTitle: string
      marketCount: number
      rawMarketCount: number
    }>
    retryCount: number
    failureCount: number
    totalRuns: number
    totalRetries: number
    totalFailures: number
    paginationCapHits: Array<{ tag: string; seriesId: number; eventCount: number }>
    cacheFreshness?: {
      total: number
      missingHistory: number
      staleHistory: number
      oldestHistory?: number
      newestHistory?: number
      oldestComputed?: number
      newestComputed?: number
      cutoff: number
    }
  } | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isBackfilling, setIsBackfilling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [backfillResult, setBackfillResult] = useState<string | null>(null)

  const filteredTotalMarkets = stats
    ? stats.filteredTagStats.reduce((sum, entry) => sum + entry.count, 0)
    : 0

  const loadStats = useCallback(async () => {
    setError(null)
    try {
      const result = await getRuntimeMarketStatsFn({ data: { freshnessWindowHours: 24 } })
      setStats(result.stats ?? null)
    } catch (err) {
      console.error('Failed to load runtime stats', err)
      setError('Failed to load runtime stats')
    }
  }, [])

  const refreshStats = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      await fetchTrendingSportsMarketsFn({ data: { limit: 50, includeLowVolume: true } })
      await loadStats()
    } catch (err) {
      console.error('Failed to refresh runtime stats', err)
      setError('Failed to refresh runtime stats')
    } finally {
      setIsLoading(false)
    }
  }, [loadStats])

  const handleBackfill = useCallback(async () => {
    if (isBackfilling) return
    if (!confirm('Backfill history for cache entries missing it?')) return
    setIsBackfilling(true)
    setBackfillResult(null)
    setError(null)
    try {
      let totalUpdated = 0
      const batchLimit = 200
      for (let i = 0; i < 5; i += 1) {
        const result = await backfillSharpMoneyHistoryFn({
          data: { limit: batchLimit },
        })
        const updated = result.updated ?? 0
        totalUpdated += updated
        if (updated < batchLimit) break
      }
      setBackfillResult(`Backfilled ${totalUpdated} entries`)
      await loadStats()
    } catch (err) {
      console.error('Failed to backfill history', err)
      setError('Failed to backfill history')
    } finally {
      setIsBackfilling(false)
    }
  }, [isBackfilling, loadStats])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  return (
    <AuthGate>
      <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Runtime</p>
            <h1 className="text-3xl font-semibold text-slate-50">Market Fetch Stats</h1>
            <p className="mt-2 text-sm text-slate-400">
              Verify how many markets we pull per sport tag and which ones dominate by volume.
            </p>
          </div>
          <a
            href="/sharp"
            className="inline-flex items-center justify-center rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-200 transition-colors hover:bg-slate-800/60"
          >
            Back to Sharp
          </a>
        </header>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm text-slate-400">
                Last fetched: {formatRelativeTime(stats?.fetchedAt)}
              </p>
              <p className="text-sm text-slate-400">
                Filtered markets (window): {filteredTotalMarkets}
              </p>
              <p className="text-sm text-slate-400">
                Expanded events: {stats?.expandedEventCount ?? 0} • Expanded markets: {stats?.expandedMarketCount ?? 0}
              </p>
              <p className="text-sm text-slate-400">
                Retries: {stats?.retryCount ?? 0} • Failures: {stats?.failureCount ?? 0} • Pagination caps: {stats?.paginationCapHits?.length ?? 0}
              </p>
              <p className="text-sm text-slate-400">
                Totals: {stats?.totalRuns ?? 0} runs • {stats?.totalRetries ?? 0} retries • {stats?.totalFailures ?? 0} failures
              </p>
              {stats?.cacheFreshness && (
                <p className="text-sm text-slate-400">
                  Cache freshness: {stats.cacheFreshness.total} total •{' '}
                  {stats.cacheFreshness.staleHistory} stale •{' '}
                  {stats.cacheFreshness.missingHistory} missing history
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={refreshStats}
                disabled={isLoading}
                className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60"
              >
                {isLoading ? 'Refreshing…' : 'Refresh Stats'}
              </button>
              <button
                type="button"
                onClick={handleBackfill}
                disabled={isBackfilling}
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-500/20 disabled:opacity-60"
              >
                {isBackfilling ? 'Backfilling…' : 'Backfill History'}
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">
              {error}
            </div>
          )}
          {backfillResult && (
            <div className="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100">
              {backfillResult}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6">
          {stats ? (
            <div className="overflow-auto">
              <table className="min-w-full text-left text-sm text-slate-200">
                <thead>
                  <tr className="text-xs uppercase tracking-[0.2em] text-slate-500">
                    <th className="pb-3">Tag</th>
                    <th className="pb-3">Count</th>
                    <th className="pb-3">Markets (today)</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.filteredTagStats.map((entry) => (
                    <tr key={`${entry.seriesId}-${entry.tag}`} className="border-t border-slate-800">
                      <td className="py-3 pr-4 font-semibold text-slate-100">
                        {entry.tag} <span className="text-xs text-slate-500">(series {entry.seriesId})</span>
                      </td>
                      <td className="py-3 pr-4">{entry.count}</td>
                      <td className="py-3 text-slate-300">
                        {entry.markets.length === 0 ? (
                          <span className="text-slate-500">No markets returned</span>
                        ) : (
                          entry.markets.map((market) => (
                            <div key={`${entry.seriesId}-${market.title}`} className="text-sm">
                              {market.title} • {formatUsdCompact(market.volume)}
                              {market.eventSlug ? ` • ${market.eventSlug}` : market.slug ? ` • ${market.slug}` : ''}
                            </div>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              No runtime stats yet. Click “Refresh Stats” to capture the latest fetch results.
            </p>
          )}
        </section>

        {stats && (
          <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6">
            <h2 className="text-lg font-semibold text-slate-50">Expanded + filtered markets</h2>
            <p className="mt-1 text-sm text-slate-400">
              Includes event-level expansion and 24h window filtering.
            </p>
            {stats.paginationCapHits.length > 0 && (
              <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
                Pagination cap hit for:{" "}
                {stats.paginationCapHits
                  .map((hit) => `${hit.tag} (${hit.eventCount})`)
                  .join(", ")}
              </div>
            )}
            <div className="mt-4 space-y-6">
              {stats.filteredTagStats.map((entry) => (
                <div key={`filtered-${entry.tag}`} className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-100 uppercase tracking-[0.2em]">
                      {entry.tag}
                    </p>
                    <p className="text-xs text-slate-400">{entry.count} markets</p>
                  </div>
                  <div className="mt-3 grid gap-2 text-sm text-slate-200">
                    {entry.markets.length === 0 ? (
                      <span className="text-slate-500">No markets returned</span>
                    ) : (
                      entry.markets.map((market) => (
                        <div key={`${entry.tag}-${market.title}`} className="text-sm">
                          {market.title} • {formatUsdCompact(market.volume)}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {stats && stats.eventStats.length > 0 && (
          <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6">
            <h2 className="text-lg font-semibold text-slate-50">Event expansion</h2>
            <div className="mt-4 grid gap-3 text-sm text-slate-200">
              {stats.eventStats.map((entry) => (
                <div
                  key={`${entry.tag}-${entry.seriesId}`}
                  className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-2"
                >
                  <span className="font-semibold uppercase tracking-[0.2em] text-slate-100">
                    {entry.tag}
                  </span>
                  <span className="text-slate-400">
                    series {entry.seriesId} • events {entry.eventCount} • markets {entry.marketCount}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {stats && stats.eventDetails.length > 0 && (
          <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6">
            <h2 className="text-lg font-semibold text-slate-50">Event details</h2>
            <div className="mt-4 space-y-3 text-sm text-slate-200">
              {stats.eventDetails.map((entry) => (
                <div
                  key={`${entry.tag}-${entry.eventSlug}`}
                  className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-slate-100">
                      {entry.eventTitle}
                    </span>
                    <span className="text-xs text-slate-400">
                      {entry.marketCount}/{entry.rawMarketCount} markets • {entry.tag} • series {entry.seriesId}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500">{entry.eventSlug}</div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      </div>
    </AuthGate>
  )
}
