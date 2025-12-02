import type { WatcherRule } from '@/lib/alerts/types'
import type { PolymarketPosition } from '@/lib/polymarket'
import { fetchPositionsForUser } from '@/lib/polymarket'
import type { Db } from '../db/client'
import { insertAlertEvent } from '../repositories/alerts'
import {
  markWatcherTriggered,
  updateWatcherPositionBaseline,
} from '../repositories/watchers'
import {
  clearMissingAlertStates,
  getPositionAlertState,
  setPositionAlertState,
} from '../repositories/position-alert-state'
import type { Env } from '../env'
import { sendPusherNotification } from './pusher'

interface EvaluateResult {
  alerts: Awaited<ReturnType<typeof insertAlertEvent>>[]
}

const DEFAULT_POSITION_ALERT_THRESHOLD = 50_000
const POSITION_ALERT_COOLDOWN_SECONDS = 60 * 30

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
      await clearMissingAlertStates(db, walletAddress, [])
      continue
    }

    for (const watcher of walletWatchers) {
      const triggered = await evaluateWatcherRules(
        db,
        watcher,
        positions,
        alerts,
        env,
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
  env: Env,
) {
  const threshold =
    watcher.singleTradeThresholdUsd ?? Number(env.ALERT_POSITION_THRESHOLD_USD ?? DEFAULT_POSITION_ALERT_THRESHOLD)

  if (threshold <= 0) {
    return false
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  let triggered = false
  const activeAssets = positions.map((position) => position.asset)
  for (const position of positions) {
    const currentValue = position.currentValue
    if (currentValue < threshold) {
      continue
    }
    const state = await getPositionAlertState(
      db,
      watcher.walletAddress,
      position.asset,
    )
    const currentBucket = Math.floor(currentValue / threshold)
    const lastBucket = state?.last_alerted_bucket ?? 0
    if (currentBucket <= lastBucket) {
      continue
    }

    const alert = await insertAlertEvent(
      db,
      watcher.id,
      watcher.walletAddress,
      'single',
      currentValue,
      1,
      [
        {
          transactionHash: undefined,
          timestamp: nowSeconds,
          size: position.size,
          price: position.curPrice,
          side: 'BUY',
          title: position.title ?? position.slug ?? position.asset,
        },
      ],
    )
    alerts.push({ ...alert, nickname: watcher.nickname ?? undefined })
    triggered = true

    await setPositionAlertState(
      db,
      watcher.walletAddress,
      position.asset,
      currentValue,
      nowSeconds,
      currentBucket,
    )

    const interest = env.PUSHER_BEAMS_INTEREST ?? 'wallet-alerts'
    const walletLabel = watcher.nickname ?? formatWalletAddress(watcher.walletAddress)
    const positionTitle = position.title ?? position.slug ?? position.asset ?? 'Unknown market'
    const valueFormatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(currentValue)

    await sendPusherNotification(env, {
      interests: [interest],
      title: `Alert: ${walletLabel}`,
      body: `${positionTitle} - ${valueFormatted} exposure`,
      data: {
        walletAddress: watcher.walletAddress,
        nickname: watcher.nickname ?? watcher.walletAddress,
        position: {
          title: positionTitle,
          currentValue,
          asset: position.asset,
        },
        threshold,
        triggeredAt: nowSeconds,
      },
    })
  }

  await clearMissingAlertStates(db, watcher.walletAddress, activeAssets)

  if (triggered) {
    await updateWatcherPositionBaseline(
      db,
      watcher.id,
      watcher.userId,
      positions.reduce((total, position) => total + position.currentValue, 0),
    )
  }

  return triggered
}
