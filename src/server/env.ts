export interface Env {
  POLYWHALER_DB: D1Database
  ALERT_PUSH_VAPID_PUBLIC_KEY?: string
  ALERT_PUSH_VAPID_PRIVATE_KEY?: string
  ALERT_EMAIL_FROM?: string
  PRIMARY_USER_ID?: string
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
