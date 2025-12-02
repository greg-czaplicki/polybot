import type { AlertChannel, WatcherRule } from '@/lib/alerts/types'
import { nowUnixSeconds } from '../env'
import type { Db } from '../db/client'
import { all, first, run } from '../db/client'

export interface WatcherInput {
  id?: string
  walletAddress: string
  nickname?: string
  singleTradeThresholdUsd?: number | null
  accumulationThresholdUsd?: number | null
  accumulationWindowSeconds?: number
  minTrades?: number
  notifyChannels?: AlertChannel[]
}

export interface WatcherRow {
  id: string
  user_id: string
  wallet_address: string
  nickname?: string | null
  single_trade_threshold_usd?: number | null
  accumulation_threshold_usd?: number | null
  accumulation_window_seconds: number
  min_trades: number
  notify_channels: string
  last_triggered_at?: number | null
  last_seen_trade_timestamp?: number | null
   last_position_value_notified?: number | null
  created_at: number
  updated_at: number
}

export function normalizeWalletAddress(value: string) {
  return value.trim().toLowerCase()
}

function deserializeWatcher(row: WatcherRow): WatcherRule {
  return {
    id: row.id,
    userId: row.user_id,
    walletAddress: row.wallet_address,
    nickname: row.nickname ?? undefined,
    singleTradeThresholdUsd: row.single_trade_threshold_usd ?? undefined,
    accumulationThresholdUsd: row.accumulation_threshold_usd ?? undefined,
    accumulationWindowSeconds: row.accumulation_window_seconds,
    minTrades: row.min_trades,
    notifyChannels: safeParseChannels(row.notify_channels),
    lastTriggeredAt: row.last_triggered_at ?? undefined,
    lastSeenTradeTimestamp: row.last_seen_trade_timestamp ?? undefined,
    lastPositionValueNotified: row.last_position_value_notified ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function safeParseChannels(raw: string | null): AlertChannel[] {
  if (!raw) {
    return ['pusher']
  }

  try {
    const parsed = JSON.parse(raw) as AlertChannel[]
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed
    }
  } catch (error) {
    console.warn('Unable to parse notify channels', error)
  }

  return ['pusher']
}

export async function listWatchers(db: Db, userId: string) {
  const rows = await all<WatcherRow>(
    db,
    `SELECT * FROM wallet_watchers WHERE user_id = ? ORDER BY created_at DESC`,
    userId,
  )

  return rows.map(deserializeWatcher)
}

export async function getWatcherById(db: Db, watcherId: string, userId: string) {
  const row = await first<WatcherRow>(
    db,
    `SELECT * FROM wallet_watchers WHERE id = ? AND user_id = ?`,
    watcherId,
    userId,
  )
  return row ? deserializeWatcher(row) : null
}

export async function upsertWatcher(db: Db, userId: string, input: WatcherInput) {
  const now = nowUnixSeconds()
  const walletAddress = normalizeWalletAddress(input.walletAddress)
  const notifyChannels = JSON.stringify(input.notifyChannels ?? ['pusher'])

  if (input.id) {
    await run(
      db,
      `UPDATE wallet_watchers
        SET nickname = ?,
            single_trade_threshold_usd = ?,
            accumulation_threshold_usd = ?,
            accumulation_window_seconds = ?,
            min_trades = ?,
            notify_channels = ?,
            updated_at = ?
        WHERE id = ? AND user_id = ?`,
      input.nickname ?? null,
      input.singleTradeThresholdUsd ?? null,
      input.accumulationThresholdUsd ?? null,
      input.accumulationWindowSeconds ?? 3600,
      input.minTrades ?? 1,
      notifyChannels,
      now,
      input.id,
      userId,
    )

    const updated = await getWatcherById(db, input.id, userId)
    if (!updated) {
      throw new Error('Unable to update watcher rule.')
    }
    return updated
  }

  const existing = await first<WatcherRow>(
    db,
    `SELECT * FROM wallet_watchers WHERE user_id = ? AND wallet_address = ?`,
    userId,
    walletAddress,
  )

  if (existing) {
    return await upsertWatcher(db, userId, {
      ...input,
      id: existing.id,
    })
  }

  const id = crypto.randomUUID()

  await run(
    db,
    `INSERT INTO wallet_watchers (
      id,
      user_id,
      wallet_address,
      nickname,
      single_trade_threshold_usd,
      accumulation_threshold_usd,
      accumulation_window_seconds,
      min_trades,
      notify_channels,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    walletAddress,
    input.nickname ?? null,
    input.singleTradeThresholdUsd ?? null,
    input.accumulationThresholdUsd ?? null,
    input.accumulationWindowSeconds ?? 3600,
    input.minTrades ?? 1,
    notifyChannels,
    now,
    now,
  )

  const created = await getWatcherById(db, id, userId)
  if (!created) {
    throw new Error('Unable to create watcher rule.')
  }

  return created
}

export async function deleteWatcher(db: Db, userId: string, watcherId: string) {
  await run(
    db,
    `DELETE FROM wallet_watchers WHERE id = ? AND user_id = ?`,
    watcherId,
    userId,
  )
}

export async function touchWatcherCursor(
  db: Db,
  watcherId: string,
  userId: string,
  lastSeenTimestamp: number,
) {
  await run(
    db,
    `UPDATE wallet_watchers
     SET last_seen_trade_timestamp = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    lastSeenTimestamp,
    nowUnixSeconds(),
    watcherId,
    userId,
  )
}

export async function markWatcherTriggered(
  db: Db,
  watcherId: string,
  userId: string,
) {
  await run(
    db,
    `UPDATE wallet_watchers
     SET last_triggered_at = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    nowUnixSeconds(),
    nowUnixSeconds(),
    watcherId,
    userId,
  )
}

export async function updateWatcherPositionBaseline(
  db: Db,
  watcherId: string,
  userId: string,
  lastPositionValueNotified: number,
) {
  await run(
    db,
    `UPDATE wallet_watchers
     SET last_position_value_notified = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    lastPositionValueNotified,
    nowUnixSeconds(),
    watcherId,
    userId,
  )
}

export async function listDistinctWatcherWallets(
  db: Db,
  options?: { after?: string | null; limit?: number },
) {
  const limit = options?.limit ?? 5
  const params: Array<unknown> = []
  let where = ''

  if (options?.after) {
    where = 'WHERE wallet_address > ?'
    params.push(options.after)
  }

  const rows = await all<{ wallet_address: string }>(
    db,
    `SELECT wallet_address
     FROM wallet_watchers
     ${where}
     GROUP BY wallet_address
     ORDER BY wallet_address ASC
     LIMIT ?`,
    ...params,
    limit,
  )

  return rows.map((row) => row.wallet_address)
}

export async function listWatchersByWallets(db: Db, wallets: string[]) {
  if (wallets.length === 0) {
    return []
  }

  const placeholders = wallets.map(() => '?').join(', ')
  const rows = await all<WatcherRow>(
    db,
    `SELECT * FROM wallet_watchers
     WHERE wallet_address IN (${placeholders})
     ORDER BY wallet_address ASC`,
    ...wallets,
  )

  return rows.map(deserializeWatcher)
}
