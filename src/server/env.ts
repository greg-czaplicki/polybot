import { STRATEGY_VERSION } from "@/lib/strategy-version";
import { verifyAuthToken } from "./auth-token";

export interface Env {
	POLYWHALER_DB: D1Database;
	SHARP_PIPELINE: DurableObjectNamespace;
	SHARP_PIPELINE_QUEUE: Queue;
	// Password protection
	APP_PASSWORD?: string;
	APP_AUTH_SECRET?: string;
	// Bot API auth
	BOT_API_KEY?: string;
	// Pinnacle benchmark capture: OddsPapi (primary) / pinnapi / The Odds
	// API (fallbacks, in that order); sweep is a no-op when all are unset
	ODDSPAPI_KEY?: string;
	PINNAPI_KEY?: string;
	ODDS_API_KEY?: string;
	// Bot control proxy
	BOT_CONTROL_URL?: string;
	BOT_CONTROL_TOKEN?: string;
	BOT_CONTROL_ACCESS_ID?: string;
	BOT_CONTROL_ACCESS_SECRET?: string;
}

export interface RequestContext {
	env: Env;
	executionCtx: ExecutionContext;
	/** Auth token from the incoming request (cookie or header); null if absent. */
	authToken?: string | null;
}

export function requireContext(context?: RequestContext) {
	if (!context?.env) {
		throw new Error(
			"Cloudflare env bindings are not available in this context.",
		);
	}

	return context;
}

/**
 * Server-side auth gate for server functions. FAIL CLOSED: missing secret
 * configuration denies every caller rather than allowing them (set
 * APP_PASSWORD/APP_AUTH_SECRET via wrangler secrets; .dev.vars locally).
 */
export async function requireAuth(context?: RequestContext): Promise<void> {
	const ctx = requireContext(context);
	const secret = ctx.env.APP_AUTH_SECRET ?? ctx.env.APP_PASSWORD;
	if (!secret) {
		throw new Error("unauthorized: auth is not configured");
	}
	const token = ctx.authToken;
	if (!token) {
		throw new Error("unauthorized: missing auth token");
	}
	const valid = await verifyAuthToken(token, secret);
	if (!valid) {
		throw new Error("unauthorized: invalid auth token");
	}
}

export function getDb(context?: RequestContext) {
	const ctx = requireContext(context);
	return ctx.env.POLYWHALER_DB;
}

export function nowUnixSeconds() {
	return Math.floor(Date.now() / 1000);
}

// Strategy era + build commit, e.g. "v4-realized-edge-gates+b40fec0a12".
// The typeof guard covers environments where the vite define is not applied
// (e.g. bare vitest runs).
export function buildStrategyVersion(): string {
	const commit = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : null;
	return commit ? `${STRATEGY_VERSION}+${commit}` : STRATEGY_VERSION;
}
