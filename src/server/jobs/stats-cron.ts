import type { PolymarketPosition, PolymarketTrade } from '@/lib/polymarket'
import { detectSportTag, isSportsMarket } from '@/lib/sports'
import { bucketSettlementHorizon, detectBetType } from '@/lib/markets'

import type { Env } from '../env'
import { nowUnixSeconds } from '../env'
import { fetchPositionsForUser, fetchTradesForUser } from '../../lib/polymarket'
import { getCronCursor, setCronCursor } from '../repositories/cron-state'
import { listDistinctWatcherWallets } from '../repositories/watchers'
import {
  deletePositionSnapshot,
  deleteWalletSizingSnapshot,
  insertWalletPnlSnapshot,
  insertWalletResult,
  listRecordedResultAssets,
  listPositionSnapshotsForWallet,
  upsertPositionSnapshot,
  upsertWalletSizingSnapshot,
  type WalletPositionSnapshotRow,
} from '../repositories/wallet-stats'

const STATS_WALLET_BATCH = 5
const STATS_CURSOR_KEY = 'stats_wallet_cursor'

const EPSILON = 1e-6

function parseEventEndTimestamp(value?: string | null) {
  if (!value) {
    return null
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return Math.floor(parsed.getTime() / 1000)
}

interface ClosingPnlResult {
  pnl: number
  resolvedAt: number
}

function calculateClosingPnl(
  snapshot: WalletPositionSnapshotRow,
  trades: PolymarketTrade[] | null,
): ClosingPnlResult | null {
  if (!trades || trades.length === 0 || Math.abs(snapshot.last_size) < EPSILON) {
    return null
  }

  const relevantTrades = trades
    .filter(
      (trade) =>
        trade.asset === snapshot.asset &&
        typeof trade.timestamp === 'number' &&
        trade.timestamp >= snapshot.last_seen_at,
    )
    .sort((a, b) => a.timestamp - b.timestamp)

  if (relevantTrades.length === 0) {
    return null
  }

  let remaining = snapshot.last_size
  let avgPrice = snapshot.last_avg_price
  let realizedDelta = 0
  let resolvedAt = snapshot.last_seen_at

  for (const trade of relevantTrades) {
    if (Math.abs(remaining) < EPSILON) {
      break
    }

    const tradeSize = trade.size
    if (remaining > 0) {
      if (trade.side === 'SELL') {
        const closingSize = Math.min(remaining, tradeSize)
        realizedDelta += closingSize * (trade.price - avgPrice)
        remaining -= closingSize
        resolvedAt = Math.max(resolvedAt, trade.timestamp)
      } else if (trade.side === 'BUY') {
        const newSize = remaining + tradeSize
        avgPrice = newSize === 0 ? 0 : ((avgPrice * remaining) + (trade.price * tradeSize)) / newSize
        remaining = newSize
      }
    } else if (remaining < 0) {
      if (trade.side === 'BUY') {
        const closingSize = Math.min(-remaining, tradeSize)
        realizedDelta += closingSize * (avgPrice - trade.price)
        remaining += closingSize
        resolvedAt = Math.max(resolvedAt, trade.timestamp)
      } else if (trade.side === 'SELL') {
        const newSize = remaining - tradeSize
        const absRemaining = Math.abs(remaining)
        const newAbs = Math.abs(newSize)
        avgPrice = newAbs === 0 ? 0 : ((avgPrice * absRemaining) + (trade.price * tradeSize)) / newAbs
        remaining = newSize
      }
    }
  }

  if (Math.abs(remaining) > EPSILON) {
    return null
  }

  return {
    pnl: snapshot.last_realized_pnl + realizedDelta,
    resolvedAt,
  }
}

export async function runStatsCron(env: Env) {
  const db = env.POLYWHALER_DB
  const lastCursor = await getCronCursor(db, STATS_CURSOR_KEY)
  const wallets = await listDistinctWatcherWallets(db, {
    after: lastCursor,
    limit: STATS_WALLET_BATCH,
  })

  if (wallets.length === 0) {
    await setCronCursor(db, STATS_CURSOR_KEY, null)
    console.log('[stats] No wallets to process, skipping stats cron.')
    return
  }

  const nextCursor =
    wallets.length === STATS_WALLET_BATCH ? wallets[wallets.length - 1] : null
  await setCronCursor(db, STATS_CURSOR_KEY, nextCursor)

  for (const walletAddress of wallets) {
    let positions: PolymarketPosition[] = []
    try {
      positions = await fetchPositionsForUser(walletAddress)
    } catch (error) {
      console.error('[stats] Unable to fetch positions for wallet', walletAddress, error)
      continue
    }

    const snapshots = await listPositionSnapshotsForWallet(db, walletAddress)
    const recordedResultAssets = await listRecordedResultAssets(db, walletAddress)
    const snapshotByAsset = new Map<string, WalletPositionSnapshotRow>()
    snapshots.forEach((snapshot) => {
      snapshotByAsset.set(snapshot.asset, snapshot)
    })

    const now = nowUnixSeconds()
    const closedSnapshots: WalletPositionSnapshotRow[] = []
    let openCashPnl = 0
    let openPositionValue = 0
    let openPositionCount = 0
    let totalInitialValue = 0
    for (const position of positions) {
      const assetKey = position.asset

      // Some resolved markets stick around in the Polymarket positions response with
      // zero value or a redeemable flag, so treat them as closed instead of updating.
      const descriptor = {
        title: position.title,
        slug: position.slug,
        eventSlug: position.eventSlug,
      }
      const sportTag = detectSportTag(descriptor)
      const sportsFlag = isSportsMarket(descriptor) ? 1 : 0
      const eventEndTimestamp = parseEventEndTimestamp(position.endDate)

      const resolved =
        position.redeemable ||
        Math.abs(position.currentValue) < EPSILON ||
        Math.abs(position.size) < EPSILON
      if (resolved) {
        const snapshot = snapshotByAsset.get(assetKey)
        if (snapshot) {
          closedSnapshots.push(snapshot)
          snapshotByAsset.delete(assetKey)
        } else {
          if (recordedResultAssets.has(assetKey)) {
            continue
          }
          closedSnapshots.push({
            id: `synthetic-${walletAddress}-${assetKey}`,
            wallet_address: walletAddress,
            asset: assetKey,
            title: position.title ?? null,
            event_slug: position.eventSlug ?? position.slug ?? null,
            is_sports: sportsFlag,
            sport_tag: sportTag ?? null,
            last_size: position.size,
            last_current_value: position.currentValue ?? 0,
            last_cash_pnl: position.cashPnl ?? 0,
            last_percent_pnl: position.percentPnl ?? 0,
            last_avg_price: position.avgPrice ?? 0,
            last_realized_pnl: position.realizedPnl ?? 0,
            last_seen_at: now,
            opened_at: now,
            event_end_timestamp: eventEndTimestamp ?? null,
          })
        }
        continue
      }

      openCashPnl += position.cashPnl ?? 0
      openPositionValue += position.currentValue ?? 0
      openPositionCount += 1
      const initialValue =
        typeof position.initialValue === 'number' ? Math.max(position.initialValue, 0) : 0
      totalInitialValue += initialValue
      await upsertPositionSnapshot(db, {
        wallet_address: walletAddress,
        asset: assetKey,
        title: position.title,
        event_slug: position.eventSlug ?? position.slug,
        is_sports: sportsFlag,
        sport_tag: sportTag ?? null,
        last_size: position.size,
        last_current_value: position.currentValue,
        last_cash_pnl: position.cashPnl,
        last_percent_pnl: position.percentPnl,
        last_avg_price: position.avgPrice,
        last_realized_pnl: position.realizedPnl,
        event_end_timestamp: eventEndTimestamp,
        opened_at: now,
      })
      snapshotByAsset.delete(assetKey)
    }

    if (openPositionCount > 0) {
      const averageSize =
        openPositionCount > 0 ? totalInitialValue / openPositionCount : 0
      await upsertWalletSizingSnapshot(db, walletAddress, {
        averageSize,
        positionCount: openPositionCount,
      })
    } else {
      await deleteWalletSizingSnapshot(db, walletAddress)
    }

    for (const snapshot of snapshotByAsset.values()) {
      closedSnapshots.push(snapshot)
    }

    let trades: PolymarketTrade[] | null = null
    if (closedSnapshots.length > 0) {
      try {
        trades = await fetchTradesForUser(walletAddress)
      } catch (error) {
        console.error('[stats] Unable to fetch trades for wallet', walletAddress, error)
      }
    }

    // Any remaining snapshots represent markets that have closed since last run
    for (const snapshot of closedSnapshots) {
      const closing = calculateClosingPnl(snapshot, trades)
      const pnl = closing?.pnl ?? snapshot.last_cash_pnl
      const fallbackResolvedAt =
        snapshot.event_end_timestamp ?? snapshot.last_seen_at ?? now
      const resolvedAt = Math.min(closing?.resolvedAt ?? fallbackResolvedAt, now)
      let result: 'win' | 'loss' | 'tie'
      if (pnl > EPSILON) {
        result = 'win'
      } else if (pnl < -EPSILON) {
        result = 'loss'
      } else {
        result = 'tie'
      }

      const marketDescriptor = {
        title: snapshot.title ?? undefined,
        eventSlug: snapshot.event_slug ?? undefined,
      }
      const betType = detectBetType(marketDescriptor)
      const horizonBucket = bucketSettlementHorizon(
        snapshot.opened_at,
        snapshot.event_end_timestamp,
        resolvedAt,
        betType,
      )

      await insertWalletResult(db, {
        wallet_address: snapshot.wallet_address,
        asset: snapshot.asset,
        title: snapshot.title ?? undefined,
        event_slug: snapshot.event_slug ?? undefined,
        resolved_at: resolvedAt,
        pnl_usd: pnl,
        result,
        is_sports: snapshot.is_sports,
        sport_tag: snapshot.sport_tag ?? null,
        bet_type: betType,
        horizon_bucket: horizonBucket === 'unknown' ? null : horizonBucket,
        event_end_timestamp: snapshot.event_end_timestamp ?? null,
        opened_at: snapshot.opened_at,
      })

      recordedResultAssets.add(snapshot.asset)
      await deletePositionSnapshot(db, snapshot.wallet_address, snapshot.asset)
    }

    await insertWalletPnlSnapshot(db, {
      wallet_address: walletAddress,
      captured_at: now,
      open_cash_pnl: openCashPnl,
      open_position_value: openPositionValue,
    })
  }

  console.log('[stats] Cron scan complete', { wallets: wallets.length })
}
