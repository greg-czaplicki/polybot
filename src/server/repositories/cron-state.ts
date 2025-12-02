import type { Db } from '../db/client'
import { first, run } from '../db/client'

export async function getCronCursor(db: Db, name: string): Promise<string | null> {
  const row = await first<{ value?: string | null }>(
    db,
    `SELECT value FROM cron_state WHERE name = ?`,
    name,
  )
  if (!row) {
    return null
  }
  return row.value ?? null
}

export async function setCronCursor(db: Db, name: string, value: string | null) {
  await run(
    db,
    `INSERT INTO cron_state (name, value)
     VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
    name,
    value ?? null,
  )
}
