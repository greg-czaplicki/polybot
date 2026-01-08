import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'

import type { Env, RequestContext } from './server/env'
import { runSharpMoneyCron } from './server/jobs/sharp-money-cron'

const startFetch = createStartHandler(defaultStreamHandler)

const serverEntry = {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
    const url = new URL(request.url)
    
    // Sharp money cron trigger - separate due to rate limits
    if (url.pathname === '/_cron/sharp-money' && request.method === 'POST') {
      try {
        console.log('[manual-cron] Starting sharp money cron run...')
        await runSharpMoneyCron(env)
        console.log('[manual-cron] Sharp money cron completed successfully')
        return new Response(JSON.stringify({ success: true, message: 'Sharp money cron completed' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        console.error('[manual-cron] Sharp money error:', error)
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
    void env
    void executionCtx
  },
}

export type ServerEntry = typeof serverEntry

export default serverEntry
