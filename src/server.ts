import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'

import type { Env, RequestContext } from './server/env'
import { handleBotRequest } from './server/api/bot'
import { handleBotControlRequest } from './server/api/bot-control'
import { settlePendingManualPicks } from './server/api/manual-picks'
import { runCanonicalSync, persistSyncRun, getCanonicalFreshness } from './server/pipeline/canonical-sync'
import { SharpPipeline, handleSharpQueue } from './server/pipeline/sharp-pipeline'
import { getPipelineStub } from './server/pipeline/sharp-pipeline-utils'

const startFetch = createStartHandler(defaultStreamHandler)

const serverEntry = {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
    const url = new URL(request.url)

    const botResponse = await handleBotRequest(request, env)
    if (botResponse) {
      return botResponse
    }

    const botControlResponse = await handleBotControlRequest(request, env)
    if (botControlResponse) {
      return botControlResponse
    }
    
    // Trigger background sharp pipeline refresh
    if (url.pathname === '/_pipeline/trigger' && request.method === 'POST') {
      try {
        const stub = getPipelineStub(env)
        const response = await stub.fetch('https://sharp-pipeline/tick', {
          method: 'POST',
          body: await request.text(),
        })
        const payload = await response.text()
        return new Response(payload, {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        console.error('[sharp-pipeline] Trigger error:', error)
        return new Response(JSON.stringify({ success: false, error: String(error) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // Pipeline status for UI polling
    if (url.pathname === '/_pipeline/status' && request.method === 'GET') {
      try {
        const stub = getPipelineStub(env)
        const response = await stub.fetch('https://sharp-pipeline/status')
        const payload = await response.text()
        return new Response(payload, {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        console.error('[sharp-pipeline] Status error:', error)
        return new Response(JSON.stringify({ success: false, error: String(error) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // Trigger manual canonical sync
    if (url.pathname === '/_canonical/trigger' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({})) as { skipSeeding?: boolean }
        const result = await runCanonicalSync(env.POLYWHALER_DB, {
          skipSeeding: body.skipSeeding,
        })
        const runId = await persistSyncRun(env.POLYWHALER_DB, result)
        return new Response(JSON.stringify({ success: true, runId, result }), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        console.error('[canonical-sync] Trigger error:', error)
        return new Response(JSON.stringify({ success: false, error: String(error) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // Canonical pipeline freshness status
    if (url.pathname === '/_canonical/status' && request.method === 'GET') {
      try {
        const freshness = await getCanonicalFreshness(env.POLYWHALER_DB)
        return new Response(JSON.stringify(freshness), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        console.error('[canonical-sync] Status error:', error)
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
    const stub = getPipelineStub(env)
    executionCtx.waitUntil(
      stub.fetch('https://sharp-pipeline/tick', {
        method: 'POST',
      }).then(() => {}).catch((error) => {
        console.error('[sharp-pipeline] Scheduled tick failed', error)
      }),
    )
    executionCtx.waitUntil(
      settlePendingManualPicks(env.POLYWHALER_DB, { limit: 100 })
        .then((result) => {
          if (result.updated > 0) {
            console.log(
              `[manual-picks] Scheduled settle updated ${result.updated}/${result.checked} pending picks`,
            )
          }
        })
        .catch((error) => {
          console.error('[manual-picks] Scheduled settle failed', error)
        }),
    )
    executionCtx.waitUntil(
      runCanonicalSync(env.POLYWHALER_DB, { skipSeeding: true })
        .then((result) => persistSyncRun(env.POLYWHALER_DB, result))
        .then((id) => {
          console.log(`[canonical-sync] Scheduled sync complete: ${id}`)
        })
        .catch((error) => {
          console.error('[canonical-sync] Scheduled sync failed', error)
        }),
    )
  },
  async queue(batch: MessageBatch, env: Env, executionCtx: ExecutionContext) {
    await handleSharpQueue(batch, env, executionCtx)
  },
}

export type ServerEntry = typeof serverEntry

export default serverEntry

export { SharpPipeline }
