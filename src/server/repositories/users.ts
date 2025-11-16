import { nowUnixSeconds } from '../env'
import type { Db } from '../db/client'
import { first, run } from '../db/client'

export interface UserRow {
  id: string
  created_at: number
  updated_at: number
}

export async function getUser(db: Db, userId: string) {
  return await first<UserRow>(db, `SELECT * FROM users WHERE id = ?`, userId)
}

export async function ensureUser(db: Db, userId?: string) {
  if (userId) {
    const existing = await getUser(db, userId)
    if (existing) {
      return existing
    }
  }

  const id = crypto.randomUUID()
  const timestamp = nowUnixSeconds()

  await run(
    db,
    `INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)`,
    id,
    timestamp,
    timestamp,
  )

  return {
    id,
    created_at: timestamp,
    updated_at: timestamp,
  }
}
