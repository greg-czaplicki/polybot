import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { AuthGate } from '@/components/auth-gate'
import {
  analyzeMarketSharpnessDebugFn,
  fetchBatchMultiPeriodPnlFn,
  fetchWalletClosedPositionsFn,
  fetchWalletOpenPositionsFn,
  getSharpMoneyCacheFn,
  type SharpAnalysisDebug,
  type SharpAnalysisResult,
  type SharpMoneyCacheEntry,
} from '../server/api/sharp-money'

export const Route = createFileRoute('/debug')({
  component: SharpDebugPage,
})

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

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '$0'
  }
  if (Math.abs(value) >= 1000) {
    return USD_COMPACT_FORMATTER.format(value)
  }
  return USD_FORMATTER.format(value)
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '0%'
  }
  return `${Math.round(value * 100)}%`
}

function formatWallet(wallet: string): string {
  if (wallet.length <= 10) return wallet
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`
}

function calculateMedian(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

function calculateMedianTopHalf(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const start = Math.floor(sorted.length / 2)
  return calculateMedian(sorted.slice(start))
}

function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return '--'
  return new Date(timestamp * 1000).toLocaleString()
}

function buildPolymarketProfileUrl(walletAddress: string): string {
  return `https://polymarket.com/profile/${walletAddress}`
}

function parseOutcomes(input: string): string[] | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  return trimmed.split(',').map((value) => value.trim()).filter(Boolean)
}

function getMissingPnlWallets(holders: SharpAnalysisDebug['topHolders']): string[] {
  const missing = new Set<string>()
  for (const side of Object.values(holders)) {
    for (const holder of side) {
      if (
        holder.pnlDay === null
        && holder.pnlWeek === null
        && holder.pnlMonth === null
        && holder.pnlAll === null
      ) {
        missing.add(holder.proxyWallet)
      }
    }
  }
  return [...missing]
}

function SharpDebugPage() {
  const [entries, setEntries] = useState<SharpMoneyCacheEntry[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [cacheEntry, setCacheEntry] = useState<SharpMoneyCacheEntry | null>(null)
  const [conditionId, setConditionId] = useState('')
  const [marketTitle, setMarketTitle] = useState('')
  const [marketSlug, setMarketSlug] = useState('')
  const [eventSlug, setEventSlug] = useState('')
  const [sportSeriesId, setSportSeriesId] = useState('')
  const [endDate, setEndDate] = useState('')
  const [outcomesInput, setOutcomesInput] = useState('')
  const [useCache, setUseCache] = useState(true)
  const [autoFetchPnl, setAutoFetchPnl] = useState(true)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<SharpAnalysisResult | null>(null)
  const [debug, setDebug] = useState<SharpAnalysisDebug | null>(null)
  const [walletLookup, setWalletLookup] = useState('')
  const [openPositions, setOpenPositions] = useState<Array<{
    conditionId?: string
    title?: string
    avgPrice?: number
    initialValue?: number
    size?: number
    totalBought?: number
    timestamp?: number
    outcome?: string
    stake: number
  }>>([])
  const [closedPositions, setClosedPositions] = useState<Array<{
    conditionId?: string
    title?: string
    avgPrice?: number
    totalBought: number
    realizedPnl: number
    timestamp?: number
    outcome?: string
    stake: number
  }>>([])
  const [openUnitSize, setOpenUnitSize] = useState<number | null>(null)
  const [closedUnitSize, setClosedUnitSize] = useState<number | null>(null)
  const [effectiveUnitSize, setEffectiveUnitSize] = useState<number | null>(null)
  const [effectiveUnitSource, setEffectiveUnitSource] = useState<'open' | 'closed' | null>(null)
  const [openLoading, setOpenLoading] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  const loadCache = useCallback(async () => {
    setError(null)
    try {
      const { entries: cacheEntries } = await getSharpMoneyCacheFn({
        data: { limit: 50 },
      })
      setEntries(cacheEntries ?? [])
    } catch (err) {
      console.error('Failed to load sharp cache', err)
      setError('Failed to load cache')
    }
  }, [])

  useEffect(() => {
    void loadCache()
  }, [loadCache])

  useEffect(() => {
    if (!selectedId) return
    const entry = entries.find((item) => item.conditionId === selectedId) ?? null
    setCacheEntry(entry)
    if (!entry) return
    setConditionId(entry.conditionId)
    setMarketTitle(entry.marketTitle)
    setMarketSlug(entry.marketSlug ?? '')
    setEventSlug(entry.eventSlug ?? '')
    setSportSeriesId(entry.sportSeriesId ? String(entry.sportSeriesId) : '')
    setEndDate(entry.eventTime ?? '')
  }, [selectedId, entries])

  const availableEntries = useMemo(() => {
    return entries.slice().sort((a, b) => b.updatedAt - a.updatedAt)
  }, [entries])

  const handleAnalyze = useCallback(async () => {
    if (!conditionId) {
      setError('Condition ID is required')
      return
    }
    setIsLoading(true)
    setError(null)
    setStatus(null)
    setAnalysis(null)
    setDebug(null)
    try {
      const payload: {
        conditionId: string
        marketTitle?: string
        marketSlug?: string
        eventSlug?: string
        sportSeriesId?: number
        endDate?: string
        outcomes?: string[]
        useCache?: boolean
      } = {
        conditionId,
        useCache,
      }

      if (marketTitle.trim()) payload.marketTitle = marketTitle.trim()
      if (marketSlug.trim()) payload.marketSlug = marketSlug.trim()
      if (eventSlug.trim()) payload.eventSlug = eventSlug.trim()
      if (sportSeriesId.trim()) payload.sportSeriesId = Number(sportSeriesId.trim())
      if (endDate.trim()) payload.endDate = endDate.trim()

      const outcomes = parseOutcomes(outcomesInput)
      if (outcomes && outcomes.length > 0) payload.outcomes = outcomes

      let result = await analyzeMarketSharpnessDebugFn({ data: payload })
      if (!result.analysis || !result.debug) {
        setError(result.error ?? 'Failed to analyze market')
        return
      }

      if (autoFetchPnl) {
        const maxAttempts = 3
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const missingWallets = getMissingPnlWallets(result.debug.topHolders)
          if (missingWallets.length === 0) break

          setStatus(`Fetching PnL for ${missingWallets.length} wallets...`)

          const walletsPerCall = 10
          for (let i = 0; i < missingWallets.length; i += walletsPerCall) {
            const batch = missingWallets.slice(i, i + walletsPerCall)
            await fetchBatchMultiPeriodPnlFn({ data: { walletAddresses: batch } })
            if (i + walletsPerCall < missingWallets.length) {
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
          }

          result = await analyzeMarketSharpnessDebugFn({ data: payload })
          if (!result.analysis || !result.debug) break
        }
      }

      setAnalysis(result.analysis)
      setDebug(result.debug)
    } catch (err) {
      console.error('Failed to analyze market', err)
      setError('Failed to analyze market')
    } finally {
      setIsLoading(false)
      setStatus(null)
    }
  }, [
    autoFetchPnl,
    conditionId,
    endDate,
    eventSlug,
    marketSlug,
    marketTitle,
    outcomesInput,
    sportSeriesId,
    useCache,
  ])

  const handleOpenPositions = useCallback(async () => {
    if (!walletLookup.trim()) {
      setOpenError('Wallet address is required')
      return
    }
    setOpenLoading(true)
    setOpenError(null)
    try {
      const [openResult, closedResult] = await Promise.all([
        fetchWalletOpenPositionsFn({
          data: { walletAddress: walletLookup.trim(), limit: 20 },
        }),
        fetchWalletClosedPositionsFn({
          data: { walletAddress: walletLookup.trim(), limit: 20 },
        }),
      ])
      setOpenPositions(openResult.positions ?? [])
      setOpenUnitSize(openResult.unitSize ?? null)
      setClosedPositions(closedResult.positions ?? [])
      setClosedUnitSize(closedResult.unitSize ?? null)

      const openStakes = (openResult.positions ?? []).map((position) => position.stake).filter((value) => value > 0)
      const closedStakes = (closedResult.positions ?? []).map((position) => position.stake).filter((value) => value > 0)
      if (openStakes.length >= 3) {
        setEffectiveUnitSize(calculateMedianTopHalf(openStakes))
        setEffectiveUnitSource('open')
      } else if (closedStakes.length >= 3) {
        setEffectiveUnitSize(calculateMedianTopHalf(closedStakes))
        setEffectiveUnitSource('closed')
      } else {
        setEffectiveUnitSize(null)
        setEffectiveUnitSource(null)
      }
    } catch (err) {
      console.error('Failed to fetch open positions', err)
      setOpenError('Failed to fetch open positions')
    } finally {
      setOpenLoading(false)
    }
  }, [walletLookup])

  return (
    <AuthGate>
      <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
        <header>
          <p className="text-sm uppercase tracking-[0.3em] text-slate-400">Sharp Debug</p>
          <h1 className="text-3xl font-semibold text-slate-50">Bet Grade Debugger</h1>
          <p className="mt-2 text-sm text-slate-400">
            Inspect the full sharp-money pipeline for a single market. Compare cached values
            with a fresh analysis and review every intermediate computation.
          </p>
        </header>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl shadow-black/30">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                Cached markets
              </label>
              <div className="flex flex-col gap-2 md:flex-row">
                <select
                  value={selectedId}
                  onChange={(event) => setSelectedId(event.target.value)}
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                >
                  <option value="">Select a cached market</option>
                  {availableEntries.map((entry) => (
                    <option key={entry.id} value={entry.conditionId}>
                      {entry.marketTitle}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={loadCache}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100 hover:border-slate-500"
                >
                  Reload cache
                </button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Condition ID
                </label>
                <input
                  value={conditionId}
                  onChange={(event) => setConditionId(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Market title
                </label>
                <input
                  value={marketTitle}
                  onChange={(event) => setMarketTitle(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Market slug
                </label>
                <input
                  value={marketSlug}
                  onChange={(event) => setMarketSlug(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Event slug
                </label>
                <input
                  value={eventSlug}
                  onChange={(event) => setEventSlug(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Series ID
                </label>
                <input
                  value={sportSeriesId}
                  onChange={(event) => setSportSeriesId(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Event time (ISO)
                </label>
                <input
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div className="md:col-span-2">
                <label className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Outcomes (comma separated)
                </label>
                <input
                  value={outcomesInput}
                  onChange={(event) => setOutcomesInput(event.target.value)}
                  placeholder="Yes, No"
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={useCache}
                  onChange={(event) => setUseCache(event.target.checked)}
                />
                Use cache defaults when fields are empty
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={autoFetchPnl}
                  onChange={(event) => setAutoFetchPnl(event.target.checked)}
                />
                Auto-fetch missing PnL
              </label>
              <button
                type="button"
                onClick={handleAnalyze}
                disabled={isLoading}
                className="rounded-lg bg-cyan-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60"
              >
                {isLoading ? 'Analyzing...' : 'Run debug analysis'}
              </button>
            </div>

            {status && (
              <div className="rounded-lg border border-slate-700 bg-slate-950/70 px-4 py-2 text-sm text-slate-200">
                {status}
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-red-500/50 bg-red-950/40 px-4 py-2 text-sm text-red-200">
                {error}
              </div>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl shadow-black/30">
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Open positions</p>
              <h2 className="text-lg font-semibold text-slate-50">Wallet unit sizing</h2>
              <p className="text-sm text-slate-400">
                Fetch the top 20 positions by initial value and compute unit size as median of the top half.
              </p>
            </div>
            <div className="flex flex-col gap-2 md:flex-row">
              <input
                value={walletLookup}
                onChange={(event) => setWalletLookup(event.target.value)}
                placeholder="0x..."
                className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              />
              <button
                type="button"
                onClick={handleOpenPositions}
                disabled={openLoading}
                className="rounded-lg bg-cyan-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60"
              >
                {openLoading ? 'Fetching...' : 'Fetch positions'}
              </button>
            </div>
            {openError && (
              <div className="rounded-lg border border-red-500/50 bg-red-950/40 px-4 py-2 text-sm text-red-200">
                {openError}
              </div>
            )}
            {(openUnitSize !== null || closedUnitSize !== null) && (
              <div className="text-sm text-slate-300">
                Open unit size: <span className="font-semibold text-slate-100">{formatUsd(openUnitSize)}</span>{' '}
                • Closed unit size: <span className="font-semibold text-slate-100">{formatUsd(closedUnitSize)}</span>
                {effectiveUnitSize !== null && (
                  <>
                    {' '}• Using <span className="font-semibold text-slate-100">{effectiveUnitSource}</span> unit:
                    {' '}<span className="font-semibold text-slate-100">{formatUsd(effectiveUnitSize)}</span>
                  </>
                )}
              </div>
            )}
            <div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60">
              <table className="min-w-full text-xs text-slate-300">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.2em] text-slate-500">
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Title</th>
                    <th className="px-3 py-2">Outcome</th>
                    <th className="px-3 py-2">Avg Price</th>
                    <th className="px-3 py-2">Size (shares)</th>
                    <th className="px-3 py-2">Initial Value</th>
                    <th className="px-3 py-2">Stake (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map((position, index) => (
                    <tr key={`${position.conditionId ?? 'pos'}-${position.timestamp ?? index}`} className="border-t border-slate-800">
                      <td className="px-3 py-2">{formatTimestamp(position.timestamp)}</td>
                      <td className="px-3 py-2 text-slate-200">
                        {position.title ?? position.conditionId ?? '--'}
                      </td>
                      <td className="px-3 py-2">{position.outcome ?? '--'}</td>
                      <td className="px-3 py-2">{position.avgPrice?.toFixed(3) ?? '--'}</td>
                      <td className="px-3 py-2">{(position.size ?? position.totalBought ?? 0).toFixed(2)}</td>
                      <td className="px-3 py-2">{formatUsd(position.initialValue)}</td>
                      <td className="px-3 py-2">{formatUsd(position.stake)}</td>
                    </tr>
                  ))}
                  {openPositions.length === 0 && (
                    <tr>
                      <td className="px-3 py-3 text-slate-400" colSpan={7}>
                        No open positions loaded.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl shadow-black/30">
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Closed positions</p>
              <h2 className="text-lg font-semibold text-slate-50">Closed position fallback</h2>
              <p className="text-sm text-slate-400">
                Used when a wallet has fewer than 3 open positions with stake data.
              </p>
            </div>
            <div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60">
              <table className="min-w-full text-xs text-slate-300">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.2em] text-slate-500">
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Title</th>
                    <th className="px-3 py-2">Outcome</th>
                    <th className="px-3 py-2">Avg Price</th>
                    <th className="px-3 py-2">Total Bought (shares)</th>
                    <th className="px-3 py-2">Realized PnL</th>
                    <th className="px-3 py-2">Stake (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {closedPositions.map((position, index) => (
                    <tr key={`${position.conditionId ?? 'closed'}-${position.timestamp ?? index}`} className="border-t border-slate-800">
                      <td className="px-3 py-2">{formatTimestamp(position.timestamp)}</td>
                      <td className="px-3 py-2 text-slate-200">
                        {position.title ?? position.conditionId ?? '--'}
                      </td>
                      <td className="px-3 py-2">{position.outcome ?? '--'}</td>
                      <td className="px-3 py-2">{position.avgPrice?.toFixed(3) ?? '--'}</td>
                      <td className="px-3 py-2">{position.totalBought.toFixed(2)}</td>
                      <td className="px-3 py-2">{formatUsd(position.realizedPnl)}</td>
                      <td className="px-3 py-2">{formatUsd(position.stake)}</td>
                    </tr>
                  ))}
                  {closedPositions.length === 0 && (
                    <tr>
                      <td className="px-3 py-3 text-slate-400" colSpan={7}>
                        No closed positions loaded.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {cacheEntry && (
          <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6">
            <h2 className="text-lg font-semibold text-slate-50">Cached snapshot</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Edge</p>
                <p className="text-2xl font-semibold text-slate-50">{cacheEntry.edgeRating}</p>
                <p className="text-xs text-slate-400">Confidence {cacheEntry.confidence}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Score diff</p>
                <p className="text-2xl font-semibold text-slate-50">{Math.round(cacheEntry.scoreDifferential)}</p>
                <p className="text-xs text-slate-400">Sharp side {cacheEntry.sharpSide}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Updated</p>
                <p className="text-sm text-slate-200">{new Date(cacheEntry.updatedAt * 1000).toLocaleString()}</p>
              </div>
            </div>
          </section>
        )}

        {analysis && debug && (
          <>
            <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
              <h2 className="text-lg font-semibold text-slate-50">Debug summary</h2>
              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Edge rating</p>
                  <p className="text-2xl font-semibold text-slate-50">{debug.edgeRating.adjusted}</p>
                  <p className="text-xs text-slate-400">
                    Base {debug.edgeRating.base} • Penalty {debug.edgeRating.penalty.toFixed(2)}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Score diff</p>
                  <p className="text-2xl font-semibold text-slate-50">
                    {Math.round(debug.scoreDifferential)}
                  </p>
                  <p className="text-xs text-slate-400">
                    Sharp side {debug.sharpSide} • Value ratio {formatPercent(debug.sharpSideValueRatio)}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Confidence</p>
                  <p className="text-2xl font-semibold text-slate-50">{debug.confidence.adjusted}</p>
                  <p className="text-xs text-slate-400">
                    Base {debug.confidence.base} • PnL coverage {formatPercent(debug.pnlCoverage.min)}
                  </p>
                </div>
              </div>
              {debug.tokenHolders && debug.tokenHolders.length > 0 && (
                <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Token holders fetched</p>
                  <div className="mt-2 grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
                    {debug.tokenHolders.map((token) => (
                      <div key={token.token} className="flex items-center justify-between gap-2">
                        <span className="text-slate-400">{token.token.slice(0, 8)}...</span>
                        <span className="font-semibold text-slate-100">{token.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Side A</p>
                  <p className="text-lg font-semibold text-slate-100">{analysis.sideA.label}</p>
                  <p className="text-sm text-slate-400">
                    Score {analysis.sideA.sharpScore.toFixed(1)} • Holders {debug.holders.sideA}
                  </p>
                  <p className="text-sm text-slate-400">
                    Total {formatUsd(debug.totals.sideAValue)} • PnL coverage {formatPercent(debug.pnlCoverage.sideA)}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Side B</p>
                  <p className="text-lg font-semibold text-slate-100">{analysis.sideB.label}</p>
                  <p className="text-sm text-slate-400">
                    Score {analysis.sideB.sharpScore.toFixed(1)} • Holders {debug.holders.sideB}
                  </p>
                  <p className="text-sm text-slate-400">
                    Total {formatUsd(debug.totals.sideBValue)} • PnL coverage {formatPercent(debug.pnlCoverage.sideB)}
                  </p>
                </div>
              </div>
              <div className="mt-6 grid gap-4 md:grid-cols-3">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Edge components</p>
                  <p className="text-sm text-slate-300">
                    Diff score {debug.edgeRating.diffScore.toFixed(1)}
                  </p>
                  <p className="text-sm text-slate-300">
                    Volume bonus {debug.edgeRating.volumeBonus.toFixed(1)}
                  </p>
                  <p className="text-sm text-slate-300">
                    Quality bonus {debug.edgeRating.qualityBonus.toFixed(1)}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Scores</p>
                  <p className="text-sm text-slate-300">
                    Raw A {debug.rawScores.sideA.toFixed(1)} • Raw B {debug.rawScores.sideB.toFixed(1)}
                  </p>
                  <p className="text-sm text-slate-300">
                    Fade A {debug.fadeBoosts.fromSideA.toFixed(2)} • Fade B {debug.fadeBoosts.fromSideB.toFixed(2)}
                  </p>
                  <p className="text-sm text-slate-300">
                    Concentration Top1 {formatPercent(debug.concentration.top1Share)} • Top3 {formatPercent(debug.concentration.top3Share)}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Pricing</p>
                  <p className="text-sm text-slate-300">
                    Outcome A ${debug.prices.sideA.toFixed(3)} • Outcome B ${debug.prices.sideB.toFixed(3)}
                  </p>
                  <p className="text-sm text-slate-300">
                    Total value {formatUsd(debug.totals.totalMarketValue)}
                  </p>
                </div>
              </div>
              {debug.warnings.length > 0 && (
                <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                  Warnings: {debug.warnings.join(', ')}
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6">
              <h2 className="text-lg font-semibold text-slate-50">Top holders</h2>
              <div className="mt-4 grid gap-6 lg:grid-cols-2">
                {(['sideA', 'sideB'] as const).map((sideKey) => {
                  const holders = debug.topHolders[sideKey]
                  const label = sideKey === 'sideA' ? analysis.sideA.label : analysis.sideB.label
                  return (
                    <div key={sideKey} className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                      <p className="text-sm font-semibold text-slate-100">{label}</p>
                      <div className="mt-3 overflow-auto">
                        <table className="min-w-full text-xs text-slate-300">
                          <thead>
                            <tr className="text-left text-[11px] uppercase tracking-[0.2em] text-slate-500">
                              <th className="pb-2">Wallet</th>
                              <th className="pb-2">Amount</th>
                              <th className="pb-2">Day</th>
                              <th className="pb-2">Week</th>
                              <th className="pb-2">Month</th>
                              <th className="pb-2">All</th>
                              <th className="pb-2">Momentum</th>
                              <th className="pb-2">Tier</th>
                            </tr>
                          </thead>
                          <tbody>
                            {holders.map((holder) => (
                              <tr key={holder.proxyWallet} className="border-t border-slate-800">
                                <td className="py-2 pr-2 text-slate-200">
                                  <a
                                    href={buildPolymarketProfileUrl(holder.proxyWallet)}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-cyan-300 hover:text-cyan-200"
                                  >
                                    {formatWallet(holder.proxyWallet)}
                                  </a>
                                </td>
                                <td className="py-2 pr-2">{formatUsd(holder.amount)}</td>
                                <td className="py-2 pr-2">{formatUsd(holder.pnlDay ?? 0)}</td>
                                <td className="py-2 pr-2">{formatUsd(holder.pnlWeek ?? 0)}</td>
                                <td className="py-2 pr-2">{formatUsd(holder.pnlMonth ?? 0)}</td>
                                <td className="py-2 pr-2">{formatUsd(holder.pnlAll ?? 0)}</td>
                                <td className="py-2 pr-2">{holder.momentumWeight.toFixed(2)}</td>
                                <td className="py-2 pr-2">{holder.pnlTierWeight.toFixed(2)}</td>
                              </tr>
                            ))}
                            {holders.length === 0 && (
                              <tr>
                                <td className="py-2 text-slate-400" colSpan={8}>
                                  No holders data
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6">
              <h2 className="text-lg font-semibold text-slate-50">Raw debug payload</h2>
              <pre className="mt-4 max-h-[480px] overflow-auto rounded-xl border border-slate-800 bg-slate-950/90 p-4 text-xs text-slate-200">
                {JSON.stringify(debug, null, 2)}
              </pre>
            </section>
          </>
        )}
      </div>
      </div>
    </AuthGate>
  )
}
