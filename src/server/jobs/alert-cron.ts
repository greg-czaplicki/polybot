import type { Env } from '../env'
import { listAllWatchers } from '../repositories/watchers'
import { evaluateWatchers } from '../services/alerts'

export async function runAlertCron(env: Env) {
  const db = env.POLYWHALER_DB
  const watchers = await listAllWatchers(db)

  if (watchers.length === 0) {
    console.log('[alerts] No watchers configured, skipping cron scan.')
    return
  }

  const result = await evaluateWatchers(db, watchers)
  console.log('[alerts] Cron scan complete', {
    wallets: new Set(watchers.map((watcher) => watcher.walletAddress)).size,
    watchers: watchers.length,
    alerts: result.alerts.length,
  })
}
