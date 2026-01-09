export interface Env {
  POLYWHALER_DB: D1Database
  SHARP_PIPELINE: DurableObjectNamespace
  SHARP_PIPELINE_QUEUE: Queue
  // Password protection
  APP_PASSWORD?: string
}

export interface RequestContext {
  env: Env
  executionCtx: ExecutionContext
}

export function requireContext(context?: RequestContext) {
  if (!context?.env) {
    throw new Error('Cloudflare env bindings are not available in this context.')
  }

  return context
}

export function getDb(context?: RequestContext) {
  const ctx = requireContext(context)
  return ctx.env.POLYWHALER_DB
}

export function nowUnixSeconds() {
  return Math.floor(Date.now() / 1000)
}
