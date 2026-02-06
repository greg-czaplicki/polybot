import type { Env } from "../env"
import { verifyAuthToken } from "../auth-token"

type BotControlAuthResult = { ok: true } | { ok: false; response: Response }

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	})
}

async function requireUiAuth(request: Request, env: Env): Promise<BotControlAuthResult> {
	const authSecret = env.APP_AUTH_SECRET ?? env.APP_PASSWORD
	if (!authSecret) {
		return { ok: true }
	}

	const authorization = request.headers.get("authorization") ?? ""
	const token = authorization.toLowerCase().startsWith("bearer ")
		? authorization.slice(7).trim()
		: request.headers.get("x-auth-token") ?? ""

	if (!token) {
		return { ok: false, response: jsonResponse({ error: "missing_auth" }, { status: 401 }) }
	}

	const isValid = await verifyAuthToken(token, authSecret)
	if (!isValid) {
		return { ok: false, response: jsonResponse({ error: "invalid_auth" }, { status: 401 }) }
	}

	return { ok: true }
}

function getUpstreamHeaders(env: Env): Headers {
	const headers = new Headers()
	if (env.BOT_CONTROL_TOKEN) {
		headers.set("Authorization", `Bearer ${env.BOT_CONTROL_TOKEN}`)
	}
	if (env.BOT_CONTROL_ACCESS_ID && env.BOT_CONTROL_ACCESS_SECRET) {
		headers.set("CF-Access-Client-Id", env.BOT_CONTROL_ACCESS_ID)
		headers.set("CF-Access-Client-Secret", env.BOT_CONTROL_ACCESS_SECRET)
	}
	return headers
}

const ALLOWED_ROUTES: Record<string, Set<string>> = {
	"/status": new Set(["GET"]),
	"/start": new Set(["POST"]),
	"/stop": new Set(["POST"]),
	"/restart": new Set(["POST"]),
	"/logs": new Set(["GET"]),
	"/logs/stream": new Set(["GET"]),
	"/env": new Set(["GET", "POST"]),
}

export async function handleBotControlRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url)
	if (!url.pathname.startsWith("/api/bot-control/")) return null

	const auth = await requireUiAuth(request, env)
	if (!auth.ok) return auth.response

	if (!env.BOT_CONTROL_URL) {
		return jsonResponse({ error: "bot_control_not_configured" }, { status: 503 })
	}

	const upstreamPath = url.pathname.replace("/api/bot-control", "")
	const allowedMethods = ALLOWED_ROUTES[upstreamPath]
	if (!allowedMethods || !allowedMethods.has(request.method)) {
		return jsonResponse({ error: "not_found" }, { status: 404 })
	}

	const upstreamUrl = new URL(upstreamPath, env.BOT_CONTROL_URL)
	upstreamUrl.search = url.search

	const headers = getUpstreamHeaders(env)
	let body: ArrayBuffer | undefined
	if (request.method !== "GET" && request.method !== "HEAD") {
		body = await request.arrayBuffer()
		if (body.byteLength) {
			const contentType = request.headers.get("content-type")
			if (contentType) {
				headers.set("Content-Type", contentType)
			}
		}
	}

	const upstreamResponse = await fetch(upstreamUrl.toString(), {
		method: request.method,
		headers,
		body,
	})

	const responseHeaders = new Headers(upstreamResponse.headers)
	responseHeaders.set("Cache-Control", "no-store")
	return new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		headers: responseHeaders,
	})
}
