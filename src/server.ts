import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'

import type { Env, RequestContext } from './server/env'
import { runAlertCron } from './server/jobs/alert-cron'
import { runStatsCron } from './server/jobs/stats-cron'

const startFetch = createStartHandler(defaultStreamHandler)

const serverEntry = {
  fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
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
