import type { WatcherRule } from '@/lib/alerts/types'
import type { PolymarketPosition } from '@/lib/polymarket'
import { fetchPositionsForUser } from '@/lib/polymarket'
import type { Db } from '../db/client'
import { insertAlertEvent } from '../repositories/alerts'
import {
  markWatcherTriggered,
  updateWatcherPositionBaseline,
} from '../repositories/watchers'

interface EvaluateResult {
  alerts: Awaited<ReturnType<typeof insertAlertEvent>>[]
}

export async function evaluateWatchers(db: Db, watchers: WatcherRule[]) {
  const alerts: EvaluateResult['alerts'] = []

  const byWallet = watchers.reduce<Record<string, WatcherRule[]>>(
    (acc, watcher) => {
      const key = watcher.walletAddress
      acc[key] = acc[key] ?? []
      acc[key]!.push(watcher)
      return acc
    },
    {},
  )

  for (const [walletAddress, walletWatchers] of Object.entries(byWallet)) {
    let positions: PolymarketPosition[] = []
    try {
      positions = await fetchPositionsForUser(walletAddress)
    } catch (error) {
      console.error(
        'Unable to fetch positions for wallet',
        walletAddress,
        error,
      )
      continue
    }

    if (positions.length === 0) {
      continue
    }

    for (const watcher of walletWatchers) {
      const triggered = await evaluateWatcherRules(
        db,
        watcher,
        positions,
        alerts,
      )

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
  positions: PolymarketPosition[],
  alerts: EvaluateResult['alerts'],
) {
  const threshold = watcher.singleTradeThresholdUsd
  if (!threshold || threshold <= 0) {
    return false
  }

  const totalPositionValue = positions.reduce(
    (sum, position) => sum + position.currentValue,
    0,
  )

  if (totalPositionValue <= 0) {
    return false
  }

  const previousBaseline = watcher.lastPositionValueNotified ?? 0
  const delta = totalPositionValue - previousBaseline

  if (delta < threshold) {
    return false
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const alert = await insertAlertEvent(
    db,
    watcher.id,
    watcher.walletAddress,
    'position_step',
    totalPositionValue,
    positions.length,
    positions.map((position) =>
      summarizePosition(position, nowSeconds),
    ).slice(0, 15),
  )
  alerts.push({ ...alert, nickname: watcher.nickname ?? undefined })

  await updateWatcherPositionBaseline(
    db,
    watcher.id,
    watcher.userId,
    totalPositionValue,
  )

  return true
}

function summarizePosition(position: PolymarketPosition, timestamp: number) {
  return {
    transactionHash: undefined,
    timestamp,
    size: position.currentValue,
    price: position.curPrice,
    side: 'BUY' as const,
    title: position.title,
  }
}
