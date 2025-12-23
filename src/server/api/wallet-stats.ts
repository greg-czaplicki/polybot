import { createServerFn } from '@tanstack/react-start'

import { getDb } from '../env'
import {
  clearWalletData,
  getWalletSizingSnapshot,
  getWalletStats,
  listWalletResults,
} from '../repositories/wallet-stats'

const requireString = (value: unknown, label: string) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`)
  }
  return value
}

export const getWalletStatsFn = createServerFn({ method: 'POST' }).handler(
  async ({ data, context }) => {
    const db = getDb(context)
    const payload = data as {
      walletAddress?: string
      sportsOnly?: boolean
    }
    const walletAddress = requireString(payload.walletAddress, 'walletAddress')
    const stats = await getWalletStats(db, walletAddress, {
      sportsOnly: payload.sportsOnly ?? false,
    })
    return { stats }
  },
)

export const listWalletResultsFn = createServerFn({ method: 'POST' }).handler(
  async ({ data, context }) => {
    const db = getDb(context)
    const payload = data as {
      walletAddress?: string
      sportsOnly?: boolean
      limit?: number
    }
    const walletAddress = requireString(payload.walletAddress, 'walletAddress')
    const results = await listWalletResults(db, walletAddress, {
      sportsOnly: payload.sportsOnly ?? false,
      limit: payload.limit ?? 20,
    })
    return { results }
  },
)

export const getWalletSizingFn = createServerFn({ method: 'POST' }).handler(
  async ({ data, context }) => {
    const db = getDb(context)
    const payload = data as { walletAddress?: string }
    const walletAddress = requireString(payload.walletAddress, 'walletAddress')
    const sizing = await getWalletSizingSnapshot(db, walletAddress)
    if (!sizing) {
      return { sizing: null }
    }
    return {
      sizing: {
        averageSize: sizing.avg_initial_size,
        positionCount: sizing.position_count,
        updatedAt: sizing.updated_at,
      },
    }
  },
)

/**
 * Clear all recorded stats data for a wallet so it can be re-processed.
 * This is useful when fixing bugs in the result recording logic.
 */
export const clearWalletDataFn = createServerFn({ method: 'POST' }).handler(
  async ({ data, context }) => {
    const db = getDb(context)
    const payload = data as { walletAddress?: string }
    const walletAddress = requireString(payload.walletAddress, 'walletAddress')
    await clearWalletData(db, walletAddress)
    console.log('[wallet-stats] Cleared all data for wallet', walletAddress)
    return { success: true, walletAddress }
  },
)
