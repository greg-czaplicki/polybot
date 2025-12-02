import type { Db } from '../db/client'
import { all, first, run } from '../db/client'

export interface PositionAlertStateRow {
  wallet_address: string
  asset: string
  last_alerted_value: number
  last_alerted_at: number
  last_alerted_bucket: number
}

export async function getPositionAlertState(
  db: Db,
  walletAddress: string,
  asset: string,
) {
  return await first<PositionAlertStateRow>(
    db,
    `SELECT * FROM position_alert_state WHERE wallet_address = ? AND asset = ?`,
    walletAddress,
    asset,
  )
}

export async function setPositionAlertState(
  db: Db,
  walletAddress: string,
  asset: string,
  value: number,
  timestamp: number,
  bucket: number,
) {
  await run(
    db,
    `INSERT INTO position_alert_state (wallet_address, asset, last_alerted_value, last_alerted_at, last_alerted_bucket)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(wallet_address, asset)
     DO UPDATE SET last_alerted_value = excluded.last_alerted_value,
                   last_alerted_at = excluded.last_alerted_at,
                   last_alerted_bucket = excluded.last_alerted_bucket`,
    walletAddress,
    asset,
    value,
    timestamp,
    bucket,
  )
}

export async function clearPositionAlertState(
  db: Db,
  walletAddress: string,
  asset: string,
) {
  await run(
    db,
    `DELETE FROM position_alert_state WHERE wallet_address = ? AND asset = ?`,
    walletAddress,
    asset,
  )
}

export async function clearMissingAlertStates(
  db: Db,
  walletAddress: string,
  activeAssets: string[],
) {
  if (activeAssets.length === 0) {
    await run(
      db,
      `DELETE FROM position_alert_state WHERE wallet_address = ?`,
      walletAddress,
    )
    return
  }
  await run(
    db,
    `DELETE FROM position_alert_state
     WHERE wallet_address = ?
       AND asset NOT IN (
         SELECT value FROM json_each(?)
       )`,
    walletAddress,
    JSON.stringify(activeAssets),
  )
}
