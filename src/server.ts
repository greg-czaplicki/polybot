import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'

import type { Env, RequestContext } from './server/env'
import { handleBotRequest } from './server/api/bot'
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
  },
  async queue(batch: MessageBatch, env: Env, executionCtx: ExecutionContext) {
    await handleSharpQueue(batch, env, executionCtx)
  },
}

export type ServerEntry = typeof serverEntry

export default serverEntry

export { SharpPipeline }
