import type { WatcherRule } from '@/lib/alerts/types'
import type { PolymarketPosition, PolymarketTrade } from '@/lib/polymarket'
import { fetchPositionsForUser, fetchTradesForUser } from '@/lib/polymarket'
import type { Db } from '../db/client'
import { insertAlertEvent } from '../repositories/alerts'
import {
  markWatcherTriggered,
  touchWatcherCursor,
} from '../repositories/watchers'
import type { Env } from '../env'
import { sendPusherNotification } from './pusher'
import {
  clearMissingAlertStates,
  getPositionAlertState,
  setPositionAlertState,
} from '../repositories/position-alert-state'

interface EvaluateResult {
  alerts: Awaited<ReturnType<typeof insertAlertEvent>>[]
}

const DEFAULT_TRADE_ALERT_THRESHOLD = 50_000

function formatWalletAddress(address: string) {
  if (address.length <= 10) {
    return address
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export async function evaluateWatchers(db: Db, watchers: WatcherRule[], env: Env) {
  const alerts: EvaluateResult['alerts'] = []

  const byWallet = watchers.reduce<Record<string, WatcherRule[]>>((acc, watcher) => {
    const key = watcher.walletAddress
    const bucket = acc[key] ?? []
    bucket.push(watcher)
    acc[key] = bucket
    return acc
  }, {})

  for (const [walletAddress, walletWatchers] of Object.entries(byWallet)) {
    let trades: PolymarketTrade[] = []
    let positions: PolymarketPosition[] = []
    try {
      trades = await fetchTradesForUser(walletAddress)
    } catch (error) {
      console.error(
        'Unable to fetch trades for wallet',
        walletAddress,
        error,
      )
      continue
    }
    try {
      positions = await fetchPositionsForUser(walletAddress)
    } catch (error) {
      console.error(
        'Unable to fetch positions for wallet',
        walletAddress,
        error,
      )
      positions = []
    }

    for (const watcher of walletWatchers) {
      const { triggered, lastProcessedTimestamp } = await evaluateWatcherRules(
        db,
        watcher,
        trades,
        positions,
        alerts,
        env,
      )

      if (
        lastProcessedTimestamp &&
        lastProcessedTimestamp > (watcher.lastSeenTradeTimestamp ?? 0)
      ) {
        await touchWatcherCursor(
          db,
          watcher.id,
          watcher.userId,
          lastProcessedTimestamp,
        )
      }

      if (triggered) {
        await markWatcherTriggered(db, watcher.id, watcher.userId)
      }
    }
  }

  return { alerts }
}

async function evaluateWatcherRules(
  db: Db,
  watcher: WatcherRule,
  trades: PolymarketTrade[],
  positions: PolymarketPosition[],
  alerts: EvaluateResult['alerts'],
  env: Env,
): Promise<{ triggered: boolean; lastProcessedTimestamp: number | null }> {
  const threshold =
    watcher.singleTradeThresholdUsd ?? Number(env.ALERT_POSITION_THRESHOLD_USD ?? DEFAULT_TRADE_ALERT_THRESHOLD)

  if (threshold <= 0 || trades.length === 0) {
    return { triggered: false, lastProcessedTimestamp: null }
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const previousCursor = watcher.lastSeenTradeTimestamp ?? 0
  let comparisonCursor = previousCursor
  let bootstrapCursor: number | null = null

  if (comparisonCursor <= 0) {
    const latestTradeTimestamp = trades.reduce((max, trade) => {
      const timestamp = typeof trade.timestamp === 'number' ? trade.timestamp : 0
      return timestamp > max ? timestamp : max
    }, 0)

    if (latestTradeTimestamp > 0) {
      comparisonCursor = latestTradeTimestamp
      bootstrapCursor = latestTradeTimestamp
    } else {
      comparisonCursor = nowSeconds
      bootstrapCursor = nowSeconds
    }
  }

  const newTrades = trades.filter(
    (trade) => typeof trade.timestamp === 'number' && trade.timestamp > comparisonCursor,
  )

  if (newTrades.length === 0 && bootstrapCursor === null) {
    return { triggered: false, lastProcessedTimestamp: null }
  }

  let triggered = false
  let maxProcessedTimestamp = previousCursor

  if (bootstrapCursor !== null && bootstrapCursor > maxProcessedTimestamp) {
    maxProcessedTimestamp = bootstrapCursor
  }

  for (const trade of newTrades) {
    const tradeTimestamp = typeof trade.timestamp === 'number' ? trade.timestamp : nowSeconds
    if (tradeTimestamp > maxProcessedTimestamp) {
      maxProcessedTimestamp = tradeTimestamp
    }
  }

  const positionTriggered = await evaluatePositionSteps(
    db,
    watcher,
    positions,
    threshold,
    alerts,
    env,
  )
  triggered = triggered || positionTriggered

  const lastProcessedTimestamp =
    maxProcessedTimestamp > previousCursor ? maxProcessedTimestamp : null

  return { triggered, lastProcessedTimestamp }
}

async function evaluatePositionSteps(
  db: Db,
  watcher: WatcherRule,
  positions: PolymarketPosition[],
  threshold: number,
  alerts: EvaluateResult['alerts'],
  env: Env,
) {
  let triggered = false
  const activeAssets = new Set<string>()
  const nowSeconds = Math.floor(Date.now() / 1000)

  for (const position of positions) {
    if (!position || !position.asset) {
      continue
    }
    const asset = position.asset
    activeAssets.add(asset)

    const currentValue =
      typeof position.currentValue === 'number' ? position.currentValue : 0
    const bucket = Math.floor(currentValue / threshold)
    const state = await getPositionAlertState(
      db,
      watcher.walletAddress,
      asset,
    )

    if (bucket <= 0) {
      if (state && state.last_alerted_bucket !== 0) {
        await setPositionAlertState(
          db,
          watcher.walletAddress,
          asset,
          currentValue,
          nowSeconds,
          0,
        )
      }
      continue
    }

    if (state && bucket <= state.last_alerted_bucket) {
      continue
    }

    const positionTitle =
      position.title ?? position.slug ?? position.eventSlug ?? asset

    const alert = await insertAlertEvent(
      db,
      watcher.id,
      watcher.walletAddress,
      'position_step',
      currentValue,
      0,
      [
        {
          transactionHash: undefined,
          timestamp: nowSeconds,
          size: position.size ?? currentValue,
          price: position.curPrice ?? 1,
          side: 'BUY',
          title: positionTitle,
        },
      ],
    )
    alerts.push({ ...alert, nickname: watcher.nickname ?? undefined })
    triggered = true

    await setPositionAlertState(
      db,
      watcher.walletAddress,
      asset,
      currentValue,
      nowSeconds,
      bucket,
    )

    const interest = env.PUSHER_BEAMS_INTEREST ?? 'wallet-alerts'
    const walletLabel =
      watcher.nickname ?? formatWalletAddress(watcher.walletAddress)
    const valueFormatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(currentValue)

    await sendPusherNotification(env, {
      interests: [interest],
      title: `Alert: ${walletLabel}`,
      body: `${positionTitle} · ${valueFormatted}`,
      data: {
        walletAddress: watcher.walletAddress,
        nickname: watcher.nickname ?? watcher.walletAddress,
        position: {
          title: positionTitle,
          currentValue,
          asset,
        },
        threshold,
        triggeredAt: nowSeconds,
      },
    })
  }

  await clearMissingAlertStates(
    db,
    watcher.walletAddress,
    Array.from(activeAssets),
  )

  return triggered
}
