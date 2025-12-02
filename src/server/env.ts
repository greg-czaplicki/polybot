export interface Env {
  POLYWHALER_DB: D1Database
  ALERT_PUSH_VAPID_PUBLIC_KEY?: string
  ALERT_PUSH_VAPID_PRIVATE_KEY?: string
  ALERT_EMAIL_FROM?: string
  PRIMARY_USER_ID?: string
  ALERT_POSITION_THRESHOLD_USD?: string
  // Pusher Beams configuration (for push notifications)
  PUSHER_BEAMS_INSTANCE_ID?: string
  PUSHER_BEAMS_SECRET_KEY?: string
  PUSHER_BEAMS_INTEREST?: string
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
