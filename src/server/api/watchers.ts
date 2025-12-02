import { createServerFn } from '@tanstack/react-start'

import type { WatcherInput } from '../repositories/watchers'
import {
  deleteWatcher,
  listWatchers,
  upsertWatcher,
} from '../repositories/watchers'
import { ensureUser } from '../repositories/users'
import { getDb } from '../env'
import { evaluateWatchers } from '../services/alerts'
import { listAlertsForUser } from '../repositories/alerts'

const requireString = (value: unknown, label: string) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`)
  }
  return value
}

export const ensureUserFn = createServerFn({ method: 'POST' }).handler(
  async ({ data, context }) => {
    const db = getDb(context)
    const preferredUserId =
      context?.env?.PRIMARY_USER_ID || (data as { userId?: string })?.userId
    const user = await ensureUser(db, preferredUserId)
    return { userId: user.id }
  },
)

export const listWatchersFn = createServerFn({ method: 'POST' }).handler(
  async ({ data, context }) => {
    const db = getDb(context)
    const userId = requireString((data as { userId?: string })?.userId, 'userId')
    const watchers = await listWatchers(db, userId)
    return { watchers }
  },
)

export const upsertWatcherFn = createServerFn({ method: 'POST' }).handler(
  async ({ data, context }) => {
    const db = getDb(context)
    const payload = data as { userId?: string; watcher?: WatcherInput }
    const userId = requireString(payload.userId, 'userId')
    const watcherInput = payload.watcher

    if (!watcherInput) {
      throw new Error('watcher payload is required')
    }

    const saved = await upsertWatcher(db, userId, {
      ...watcherInput,
      walletAddress: watcherInput.walletAddress,
    })

    return { watcher: saved }
  },
)

export const deleteWatcherFn = createServerFn({ method: 'POST' }).handler(
  async ({ data, context }) => {
    const db = getDb(context)
    const payload = data as { userId?: string; watcherId?: string }
    const userId = requireString(payload.userId, 'userId')
    const watcherId = requireString(payload.watcherId, 'watcherId')
    await deleteWatcher(db, userId, watcherId)
    return { success: true }
  },
)

export const runAlertScanFn = createServerFn({ method: 'POST' }).handler(
  async ({ data, context }) => {
    const db = getDb(context)
    const userId = requireString((data as { userId?: string })?.userId, 'userId')
    const watchers = await listWatchers(db, userId)
    const result = await evaluateWatchers(db, watchers, context?.env)
    return { alerts: result.alerts }
  },
)

export const listAlertHistoryFn = createServerFn({ method: 'POST' }).handler(
  async ({ data, context }) => {
    const db = getDb(context)
    const userId = requireString((data as { userId?: string })?.userId, 'userId')
    const alerts = await listAlertsForUser(db, userId)
    return { alerts }
  },
)
