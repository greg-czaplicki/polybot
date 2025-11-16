import type { Db } from '../db/client'
import { all, first, run } from '../db/client'
import { nowUnixSeconds } from '../env'

export interface WalletPositionSnapshotRow {
  id: string
  wallet_address: string
  asset: string
  title?: string | null
  event_slug?: string | null
  is_sports: number
  last_size: number
  last_current_value: number
  last_cash_pnl: number
  last_percent_pnl: number
  last_seen_at: number
}

export interface WalletResultRow {
  id: string
  wallet_address: string
  asset: string
  title?: string | null
  event_slug?: string | null
  resolved_at: number
  pnl_usd: number
  result: 'win' | 'loss' | 'tie'
  is_sports: number
}

export interface WalletResultSummary {
  asset: string
  title?: string | null
  eventSlug?: string | null
  resolvedAt: number
  pnlUsd: number
  result: 'win' | 'loss' | 'tie'
  isSports: boolean
}

export async function upsertPositionSnapshot(
  db: Db,
  input: Omit<WalletPositionSnapshotRow, 'id' | 'last_seen_at'>,
) {
  const existing = await first<WalletPositionSnapshotRow>(
    db,
    `SELECT * FROM wallet_positions_snapshot WHERE wallet_address = ? AND asset = ?`,
    input.wallet_address,
    input.asset,
  )

  const now = nowUnixSeconds()

  if (existing) {
    await run(
      db,
      `UPDATE wallet_positions_snapshot
       SET title = ?,
           event_slug = ?,
           is_sports = ?,
           last_size = ?,
           last_current_value = ?,
           last_cash_pnl = ?,
           last_percent_pnl = ?,
           last_seen_at = ?
       WHERE id = ?`,
      input.title ?? null,
      input.event_slug ?? null,
      input.is_sports,
      input.last_size,
      input.last_current_value,
      input.last_cash_pnl,
      input.last_percent_pnl,
      now,
      existing.id,
    )
    return
  }

  const id = crypto.randomUUID()
  await run(
    db,
    `INSERT INTO wallet_positions_snapshot (
       id,
       wallet_address,
       asset,
       title,
       event_slug,
       is_sports,
       last_size,
       last_current_value,
       last_cash_pnl,
       last_percent_pnl,
       last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.wallet_address,
    input.asset,
    input.title ?? null,
    input.event_slug ?? null,
    input.is_sports,
    input.last_size,
    input.last_current_value,
    input.last_cash_pnl,
    input.last_percent_pnl,
    now,
  )
}

export async function listPositionSnapshotsForWallet(db: Db, walletAddress: string) {
  return await all<WalletPositionSnapshotRow>(
    db,
    `SELECT * FROM wallet_positions_snapshot WHERE wallet_address = ?`,
    walletAddress,
  )
}

export async function deletePositionSnapshot(
  db: Db,
  walletAddress: string,
  asset: string,
) {
  await run(
    db,
    `DELETE FROM wallet_positions_snapshot WHERE wallet_address = ? AND asset = ?`,
    walletAddress,
    asset,
  )
}

export interface WalletStatsBucket {
  wins: number
  losses: number
  ties: number
  pnlUsd: number
}

export interface WalletStats {
  allTime: WalletStatsBucket
  daily: WalletStatsBucket
  weekly: WalletStatsBucket
  monthly: WalletStatsBucket
}

export async function insertWalletResult(
  db: Db,
  input: Omit<WalletResultRow, 'id'>,
) {
  const id = crypto.randomUUID()

  await run(
    db,
    `INSERT INTO wallet_results (
       id,
       wallet_address,
       asset,
       title,
       event_slug,
       resolved_at,
       pnl_usd,
       result,
       is_sports
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.wallet_address,
    input.asset,
    input.title ?? null,
    input.event_slug ?? null,
    input.resolved_at,
    input.pnl_usd,
    input.result,
    input.is_sports,
  )
}

export async function listWalletResults(
  db: Db,
  walletAddress: string,
  options?: { limit?: number; sportsOnly?: boolean },
): Promise<WalletResultSummary[]> {
  const limit = options?.limit ?? 20
  const sportsOnly = options?.sportsOnly ?? false
  const params: Array<unknown> = [walletAddress]
  let where = `wallet_address = ?`
  if (sportsOnly) {
    where += ` AND is_sports = 1`
  }
  const rows = await all<WalletResultRow>(
    db,
    `SELECT * FROM wallet_results
     WHERE ${where}
     ORDER BY resolved_at DESC
     LIMIT ?`,
    ...params,
    limit,
  )

  return rows.map((row) => ({
    asset: row.asset,
    title: row.title ?? undefined,
    eventSlug: row.event_slug ?? undefined,
    resolvedAt: row.resolved_at,
    pnlUsd: row.pnl_usd,
    result: row.result,
    isSports: row.is_sports === 1,
  }))
}

async function getBucket(
  db: Db,
  walletAddress: string,
  since?: number,
  sportsOnly?: boolean,
): Promise<WalletStatsBucket> {
  const params: Array<unknown> = [walletAddress]
  let where = `wallet_address = ?`

  if (typeof since === 'number') {
    where += ` AND resolved_at >= ?`
    params.push(since)
  }

  if (sportsOnly) {
    where += ` AND is_sports = 1`
  }

  const rows = await all<{
    wins: number
    losses: number
    ties: number
    pnlUsd: number
  }>(
    db,
    `SELECT
       SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
       SUM(CASE WHEN result = 'tie' THEN 1 ELSE 0 END) AS ties,
       COALESCE(SUM(pnl_usd), 0) AS pnlUsd
     FROM wallet_results
     WHERE ${where}`,
    ...params,
  )

  const row = rows[0]
  return {
    wins: row?.wins ?? 0,
    losses: row?.losses ?? 0,
    ties: row?.ties ?? 0,
    pnlUsd: row?.pnlUsd ?? 0,
  }
}

export async function getWalletStats(
  db: Db,
  walletAddress: string,
  options?: { sportsOnly?: boolean },
): Promise<WalletStats> {
  const now = nowUnixSeconds()
  const dayAgo = now - 60 * 60 * 24
  const weekAgo = now - 60 * 60 * 24 * 7
  const monthAgo = now - 60 * 60 * 24 * 30
  const sportsOnly = options?.sportsOnly ?? true

  const [allTime, daily, weekly, monthly] = await Promise.all([
    getBucket(db, walletAddress, undefined, sportsOnly),
    getBucket(db, walletAddress, dayAgo, sportsOnly),
    getBucket(db, walletAddress, weekAgo, sportsOnly),
    getBucket(db, walletAddress, monthAgo, sportsOnly),
  ])

  return {
    allTime,
    daily,
    weekly,
    monthly,
  }
}
