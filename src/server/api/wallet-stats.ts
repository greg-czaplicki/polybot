import { createServerFn } from '@tanstack/react-start'

import { getDb } from '../env'
import { getWalletStats, listWalletResults } from '../repositories/wallet-stats'

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
      sportsOnly: payload.sportsOnly ?? true,
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
