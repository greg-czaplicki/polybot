import { STRATEGY_VERSION } from "@/lib/strategy-version";

export interface Env {
	POLYWHALER_DB: D1Database
	SHARP_PIPELINE: DurableObjectNamespace
	SHARP_PIPELINE_QUEUE: Queue
	// Password protection
	APP_PASSWORD?: string
	APP_AUTH_SECRET?: string
	// Bot API auth
	BOT_API_KEY?: string
	// The Odds API (Pinnacle benchmark capture); sweep is a no-op when unset
	ODDS_API_KEY?: string
	// Bot control proxy
	BOT_CONTROL_URL?: string
	BOT_CONTROL_TOKEN?: string
	BOT_CONTROL_ACCESS_ID?: string
	BOT_CONTROL_ACCESS_SECRET?: string
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

// Strategy era + build commit, e.g. "v4-realized-edge-gates+b40fec0a12".
// The typeof guard covers environments where the vite define is not applied
// (e.g. bare vitest runs).
export function buildStrategyVersion(): string {
  const commit = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : null
  return commit ? `${STRATEGY_VERSION}+${commit}` : STRATEGY_VERSION
}
