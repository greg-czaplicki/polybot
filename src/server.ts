import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'

import type { Env, RequestContext } from './server/env'
import { runAlertCron } from './server/jobs/alert-cron'
import { runStatsCron } from './server/jobs/stats-cron'
import { clearAllWalletData, clearWalletData } from './server/repositories/wallet-stats'

const startFetch = createStartHandler(defaultStreamHandler)

const serverEntry = {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
    const url = new URL(request.url)
    
    // Manual cron trigger endpoint for debugging
    if (url.pathname === '/_cron' && request.method === 'POST') {
      try {
        console.log('[manual-cron] Starting manual cron run...')
        await Promise.all([
          runAlertCron(env).catch((error) => {
            console.error('[alerts] Manual cron failed', error)
            throw error
          }),
          runStatsCron(env).catch((error) => {
            console.error('[stats] Manual cron failed', error)
            throw error
          }),
        ])
        console.log('[manual-cron] Manual cron completed successfully')
        return new Response(JSON.stringify({ success: true, message: 'Cron completed' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        console.error('[manual-cron] Error:', error)
        return new Response(JSON.stringify({ success: false, error: String(error) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // Clear wallet data endpoint for debugging
    if (url.pathname === '/_clear-wallet' && request.method === 'POST') {
      try {
        const body = (await request.json()) as { walletAddress?: string }
        const walletAddress = body.walletAddress
        if (!walletAddress) {
          return new Response(JSON.stringify({ success: false, error: 'walletAddress required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        console.log('[clear-wallet] Clearing data for wallet:', walletAddress)
        await clearWalletData(env.POLYWHALER_DB, walletAddress)
        console.log('[clear-wallet] Data cleared successfully')
        return new Response(JSON.stringify({ success: true, walletAddress }), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        console.error('[clear-wallet] Error:', error)
        return new Response(JSON.stringify({ success: false, error: String(error) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // Clear ALL wallet data endpoint - nuclear option
    if (url.pathname === '/_clear-all-wallets' && request.method === 'POST') {
      try {
        console.log('[clear-all] Clearing ALL wallet stats data...')
        await clearAllWalletData(env.POLYWHALER_DB)
        console.log('[clear-all] All wallet data cleared successfully')
        return new Response(JSON.stringify({ success: true, message: 'All wallet data cleared' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        console.error('[clear-all] Error:', error)
        return new Response(JSON.stringify({ success: false, error: String(error) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    const context: RequestContext = {
      env,
      executionCtx,
    }

    return startFetch(request, { context })
  },
  scheduled(_event: ScheduledEvent, env: Env, executionCtx: ExecutionContext) {
    executionCtx.waitUntil(
      Promise.all([
        runAlertCron(env).catch((error) => {
          console.error('[alerts] Cron scan failed', error)
          throw error
        }),
        runStatsCron(env).catch((error) => {
          console.error('[stats] Cron scan failed', error)
          throw error
        }),
      ]).then(() => {}),
    )
  },
}

export type ServerEntry = typeof serverEntry

export default serverEntry
