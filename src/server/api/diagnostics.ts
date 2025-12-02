import { createServerFn } from '@tanstack/react-start'

import { fetchPositionsForUser, fetchTradesForUser } from '@/lib/polymarket'

import { getDb } from '../env'
import { listWalletResults } from '../repositories/wallet-stats'

const requireString = (value: unknown, label: string) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`)
  }
  return value
}

export const getWalletDiagnosticsFn = createServerFn({ method: 'POST' }).handler(
  async ({ data, context }) => {
    const db = getDb(context)
    const payload = data as { walletAddress?: string; days?: number }
    const walletAddress = requireString(payload.walletAddress, 'walletAddress')
    const days =
      typeof payload.days === 'number' && Number.isFinite(payload.days) ? payload.days : 7
    const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60

    const [resultsResponse, trades, positions] = await Promise.all([
      listWalletResults(db, walletAddress, { sportsOnly: false, limit: 500 }),
      fetchTradesForUser(walletAddress).catch((error) => {
        console.error('[diagnostics] trades fetch failed', walletAddress, error)
        return []
      }),
      fetchPositionsForUser(walletAddress).catch((error) => {
        console.error('[diagnostics] positions fetch failed', walletAddress, error)
        return []
      }),
    ])

    const recentResults = resultsResponse.filter((result) => result.resolvedAt >= since)
    const closedPnl = recentResults.reduce((total, result) => total + result.pnlUsd, 0)
    const wins = recentResults.filter((result) => result.result === 'win').length
    const losses = recentResults.filter((result) => result.result === 'loss').length
    const ties = recentResults.filter((result) => result.result === 'tie').length

    const openPnl = positions.reduce((total, position) => total + (position.cashPnl ?? 0), 0)
    const buyVolume = trades
      .filter((trade) => trade.timestamp >= since && trade.side === 'BUY')
      .reduce((total, trade) => total + trade.size * trade.price, 0)
    const sellVolume = trades
      .filter((trade) => trade.timestamp >= since && trade.side === 'SELL')
      .reduce((total, trade) => total + trade.size * trade.price, 0)

    return {
      closed: {
        wins,
        losses,
        ties,
        pnlUsd: closedPnl,
        sampleCount: recentResults.length,
        results: recentResults,
        since,
      },
      open: {
        pnlUsd: openPnl,
        positionCount: positions.length,
      },
      trades: {
        since,
        buyVolume,
        sellVolume,
      },
    }
  },
)
