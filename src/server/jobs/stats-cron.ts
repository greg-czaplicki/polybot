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

/**
 * Resolution status for a closed position.
 * 'won' = shares redeemed at $1, 'lost' = shares worthless at $0, 'unknown' = use fallback
 */
type ResolutionOutcome = 'won' | 'lost' | 'unknown'

interface ClosedSnapshotWithOutcome {
  snapshot: WalletPositionSnapshotRow
  resolution: ResolutionOutcome
}

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

    // Log summary of positions for debugging
    const redeemableCount = positions.filter((p) => p.redeemable).length
    const zeroValueCount = positions.filter((p) => Math.abs(p.currentValue) < EPSILON).length
    const zeroPriceCount = positions.filter((p) => Math.abs(p.curPrice) < EPSILON).length
    console.log('[stats] Fetched positions', {
      wallet: walletAddress,
      total: positions.length,
      redeemable: redeemableCount,
      zeroValue: zeroValueCount,
      zeroPrice: zeroPriceCount,
    })

    const snapshots = await listPositionSnapshotsForWallet(db, walletAddress)
    const recordedResultAssets = await listRecordedResultAssets(db, walletAddress)
    const snapshotByAsset = new Map<string, WalletPositionSnapshotRow>()
    snapshots.forEach((snapshot) => {
      snapshotByAsset.set(snapshot.asset, snapshot)
    })

    const now = nowUnixSeconds()
    const closedSnapshots: ClosedSnapshotWithOutcome[] = []
    let openCashPnl = 0
    let openPositionValue = 0
    let openSportsCashPnl = 0
    let openSportsPositionValue = 0
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

      // Determine if position is resolved and how
      const isRedeemable = position.redeemable === true
      const isSizeZero = Math.abs(position.size) < EPSILON
      const isValueZero = Math.abs(position.currentValue) < EPSILON
      // curPrice indicates the current market price (0 = worthless, 1 = won)
      const curPrice = position.curPrice ?? 0
      const isPriceWin = curPrice > 0.5 // Price > 50% means this outcome won
      const isPriceLoss = curPrice < 0.05 // Price < 5% means this outcome lost

      // Check if the event has already ended (for sports markets especially)
      const eventHasEnded = eventEndTimestamp !== null && eventEndTimestamp < now

      // A position is "de facto resolved" if:
      // 1. It's marked redeemable by Polymarket
      // 2. Size is zero (already sold/redeemed)
      // 3. Price has crashed to near-zero (the outcome lost, even if not marked redeemable)
      // 4. Event has ended AND price is decisive (win or loss)
      const isDeFactoLoss = isPriceLoss && (isValueZero || eventHasEnded)
      const isDeFactoWin = isPriceWin && eventHasEnded
      const resolved = isRedeemable || isSizeZero || isDeFactoLoss || isDeFactoWin

      // Determine resolution outcome based on curPrice, NOT redeemable flag!
      // redeemable=true just means market resolved, both wins AND losses are redeemable
      // The actual outcome is determined by curPrice:
      // - curPrice ≈ 1 means your shares are worth $1 (you WON)
      // - curPrice ≈ 0 means your shares are worthless (you LOST)
      let resolution: ResolutionOutcome = 'unknown'
      if (isPriceWin && (isRedeemable || eventHasEnded)) {
        // Market resolved or event ended, shares worth ~$1 - you won
        resolution = 'won'
      } else if (isPriceLoss && (isRedeemable || eventHasEnded || isValueZero)) {
        // Market resolved, event ended, or value crashed to $0 - you lost
        resolution = 'lost'
      } else if (isSizeZero) {
        // Position was fully closed - could be sold early, already redeemed
        // We'll determine the actual outcome using trade data later
        resolution = 'unknown'
      }

      if (resolved) {
        console.log('[stats] Position resolved', {
          wallet: walletAddress,
          asset: assetKey,
          title: position.title,
          resolution,
          isRedeemable,
          isSizeZero,
          isValueZero,
          eventHasEnded,
          isDeFactoLoss,
          isDeFactoWin,
          curPrice,
          isPriceWin,
          isPriceLoss,
          size: position.size,
          currentValue: position.currentValue,
          cashPnl: position.cashPnl,
        })
        const snapshot = snapshotByAsset.get(assetKey)
        if (snapshot) {
          closedSnapshots.push({ snapshot, resolution })
          snapshotByAsset.delete(assetKey)
        } else {
          if (recordedResultAssets.has(assetKey)) {
            continue
          }
          closedSnapshots.push({
            snapshot: {
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
            },
            resolution,
          })
        }
        continue
      }

      openCashPnl += position.cashPnl ?? 0
      openPositionValue += position.currentValue ?? 0
      if (sportsFlag === 1) {
        openSportsCashPnl += position.cashPnl ?? 0
        openSportsPositionValue += position.currentValue ?? 0
      }
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
      // Orphaned snapshots (no longer in positions API)
      // These are positions we tracked that have disappeared - could be sold, won, or lost
      closedSnapshots.push({ snapshot, resolution: 'unknown' })
      console.log('[stats] Orphaned snapshot detected', {
        wallet: walletAddress,
        asset: snapshot.asset,
        title: snapshot.title,
        lastSize: snapshot.last_size,
        lastCashPnl: snapshot.last_cash_pnl,
        lastAvgPrice: snapshot.last_avg_price,
      })
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
    for (const { snapshot, resolution } of closedSnapshots) {
      const closing = calculateClosingPnl(snapshot, trades)

      // Determine the result (win/loss/tie) based on MARKET OUTCOME, not PnL
      // This tracks prediction accuracy, not trading profit
      let result: 'win' | 'loss' | 'tie'
      let pnl: number

      if (resolution === 'won') {
        // Market resolved in our favor - this is a WIN regardless of PnL
        result = 'win'
        // Calculate PnL: shares resolved at $1
        if (closing?.pnl !== undefined) {
          pnl = closing.pnl
        } else {
          const resolvedValue = snapshot.last_size * 1.0
          const costBasis = snapshot.last_size * snapshot.last_avg_price
          pnl = resolvedValue - costBasis + (snapshot.last_realized_pnl ?? 0)
        }
      } else if (resolution === 'lost') {
        // Market resolved against us - this is a LOSS regardless of PnL
        result = 'loss'
        // Calculate PnL: shares resolved at $0
        if (closing?.pnl !== undefined) {
          pnl = closing.pnl
        } else {
          const costBasis = Math.abs(snapshot.last_size) * snapshot.last_avg_price
          pnl = -costBasis + (snapshot.last_realized_pnl ?? 0)
        }
      } else {
        // Unknown resolution (position disappeared from API without clear outcome)
        // Try to use trade data if available, otherwise use last known cashPnl
        if (closing?.pnl !== undefined) {
          pnl = closing.pnl
        } else {
          pnl = snapshot.last_cash_pnl
        }
        // For unknown resolution, determine result by PnL (early exit/sold position)
        if (pnl > EPSILON) {
          result = 'win'
        } else if (pnl < -EPSILON) {
          result = 'loss'
        } else {
          result = 'tie'
        }
      }

      const fallbackResolvedAt =
        snapshot.event_end_timestamp ?? snapshot.last_seen_at ?? now
      const resolvedAt = Math.min(closing?.resolvedAt ?? fallbackResolvedAt, now)

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

      console.log('[stats] Recording result', {
        wallet: snapshot.wallet_address,
        asset: snapshot.asset,
        title: snapshot.title,
        resolution,
        result,
        pnl,
        isSports: snapshot.is_sports === 1,
        sportTag: snapshot.sport_tag,
      })

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
      open_sports_cash_pnl: openSportsCashPnl,
      open_sports_position_value: openSportsPositionValue,
    })
  }

  console.log('[stats] Cron scan complete', { wallets: wallets.length })
}
