import type { PolymarketPosition } from '@/lib/polymarket'

import type { Env } from '../env'
import { nowUnixSeconds } from '../env'
import { fetchPositionsForUser } from '../../lib/polymarket'
import { listAllWatchers } from '../repositories/watchers'
import {
  deletePositionSnapshot,
  insertWalletResult,
  listPositionSnapshotsForWallet,
  upsertPositionSnapshot,
  type WalletPositionSnapshotRow,
} from '../repositories/wallet-stats'

function isSportsMarket(position: PolymarketPosition) {
  const source = `${position.title ?? ''} ${position.eventSlug ?? ''}`.toLowerCase()
  if (!source) {
    return false
  }
  const keywords = ['nfl', 'nba', 'mlb', 'nhl', 'premier league', 'ufc', 'tennis', 'golf', 'soccer', 'football', 'basketball', 'baseball', 'hockey']
  return keywords.some((keyword) => source.includes(keyword))
}

export async function runStatsCron(env: Env) {
  const db = env.POLYWHALER_DB
  const watchers = await listAllWatchers(db)

  if (watchers.length === 0) {
    console.log('[stats] No watchers configured, skipping stats cron.')
    return
  }

  const wallets = Array.from(
    new Set(watchers.map((watcher) => watcher.walletAddress)),
  )

  for (const walletAddress of wallets) {
    let positions: PolymarketPosition[] = []
    try {
      positions = await fetchPositionsForUser(walletAddress)
    } catch (error) {
      console.error('[stats] Unable to fetch positions for wallet', walletAddress, error)
      continue
    }

    const snapshots = await listPositionSnapshotsForWallet(db, walletAddress)
    const snapshotByAsset = new Map<string, WalletPositionSnapshotRow>()
    snapshots.forEach((snapshot) => {
      snapshotByAsset.set(snapshot.asset, snapshot)
    })

    const now = nowUnixSeconds()

    const openAssets = new Set<string>()
    for (const position of positions) {
      const assetKey = position.asset
      openAssets.add(assetKey)
      await upsertPositionSnapshot(db, {
        wallet_address: walletAddress,
        asset: assetKey,
        title: position.title,
        event_slug: position.eventSlug ?? position.slug,
        is_sports: isSportsMarket(position) ? 1 : 0,
        last_size: position.size,
        last_current_value: position.currentValue,
        last_cash_pnl: position.cashPnl,
        last_percent_pnl: position.percentPnl,
      })
      snapshotByAsset.delete(assetKey)
    }

    // Any remaining snapshots represent markets that have closed since last run
    for (const snapshot of snapshotByAsset.values()) {
      const pnl = snapshot.last_cash_pnl
      const epsilon = 1e-6
      let result: 'win' | 'loss' | 'tie'
      if (pnl > epsilon) {
        result = 'win'
      } else if (pnl < -epsilon) {
        result = 'loss'
      } else {
        result = 'tie'
      }

      await insertWalletResult(db, {
        wallet_address: snapshot.wallet_address,
        asset: snapshot.asset,
        title: snapshot.title ?? undefined,
        event_slug: snapshot.event_slug ?? undefined,
        resolved_at: now,
        pnl_usd: pnl,
        result,
        is_sports: snapshot.is_sports,
      })

      await deletePositionSnapshot(db, snapshot.wallet_address, snapshot.asset)
    }
  }

  console.log('[stats] Cron scan complete', { wallets: wallets.length })
}

