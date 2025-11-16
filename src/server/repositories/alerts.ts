import type { AlertEventRecord } from '@/lib/alerts/types'
import { nowUnixSeconds } from '../env'
import type { Db } from '../db/client'
import { all, run } from '../db/client'

interface AlertEventRow {
  id: string
  watcher_id: string
  wallet_address: string
  trigger_type: string
  trigger_value: number
  trade_count: number
  payload: string
  triggered_at: number
  status: string
}

export async function insertAlertEvent(
  db: Db,
  watcherId: string,
  walletAddress: string,
  triggerType: AlertEventRecord['triggerType'],
  triggerValue: number,
  tradeCount: number,
  trades: AlertEventRecord['trades'],
) {
  const id = crypto.randomUUID()
  const triggeredAt = nowUnixSeconds()

  await run(
    db,
    `INSERT INTO alert_events (
      id,
      watcher_id,
      wallet_address,
      trigger_type,
      trigger_value,
      trade_count,
      payload,
      triggered_at,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    watcherId,
    walletAddress,
    triggerType,
    triggerValue,
    tradeCount,
    JSON.stringify(trades),
    triggeredAt,
    'pending',
  )

  const record: AlertEventRecord = {
    id,
    walletAddress,
    watcherId,
    triggerType,
    triggerValue,
    tradeCount,
    trades,
    status: 'pending',
    triggeredAt,
  }

  return record
}

export async function listAlertsForUser(db: Db, userId: string, limit = 20) {
  const rows = await all<AlertEventRow & { nickname?: string | null }>(
    db,
    `SELECT ae.*,
            ww.nickname
       FROM alert_events ae
       INNER JOIN wallet_watchers ww ON ww.id = ae.watcher_id
      WHERE ww.user_id = ?
      ORDER BY ae.triggered_at DESC
      LIMIT ?`,
    userId,
    limit,
  )

  return rows.map((row) => ({
    id: row.id,
    watcherId: row.watcher_id,
    walletAddress: row.wallet_address,
    triggerType: row.trigger_type as AlertEventRecord['triggerType'],
    triggerValue: row.trigger_value,
    tradeCount: row.trade_count,
    trades: safeParseTrades(row.payload),
    status: row.status as AlertEventRecord['status'],
    triggeredAt: row.triggered_at,
    nickname: row.nickname ?? undefined,
  }))
}

function safeParseTrades(raw: string) {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed
    }
  } catch (error) {
    console.warn('Unable to parse alert payload', error)
  }

  return []
}
