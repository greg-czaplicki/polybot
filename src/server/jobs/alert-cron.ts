import type { Env } from '../env'
import { getCronCursor, setCronCursor } from '../repositories/cron-state'
import {
  listDistinctWatcherWallets,
  listWatchersByWallets,
} from '../repositories/watchers'
import { evaluateWatchers } from '../services/alerts'

const ALERT_WALLET_BATCH = 5
const ALERT_CURSOR_KEY = 'alerts_wallet_cursor'

export async function runAlertCron(env: Env) {
  const db = env.POLYWHALER_DB
  const lastCursor = await getCronCursor(db, ALERT_CURSOR_KEY)
  const wallets = await listDistinctWatcherWallets(db, {
    after: lastCursor,
    limit: ALERT_WALLET_BATCH,
  })

  if (wallets.length === 0) {
    await setCronCursor(db, ALERT_CURSOR_KEY, null)
    console.log('[alerts] No wallets to process, skipping cron scan.')
    return
  }

  const nextCursor =
    wallets.length === ALERT_WALLET_BATCH ? wallets[wallets.length - 1] : null
  await setCronCursor(db, ALERT_CURSOR_KEY, nextCursor)

  const watchers = await listWatchersByWallets(db, wallets)

  if (watchers.length === 0) {
    console.log('[alerts] No watchers configured, skipping cron scan.')
    return
  }

  const result = await evaluateWatchers(db, watchers, env)
  console.log('[alerts] Cron scan complete', {
    wallets: wallets.length,
    watchers: watchers.length,
    alerts: result.alerts.length,
  })
}
