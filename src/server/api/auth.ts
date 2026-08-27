import { signAuthToken } from "../auth-token";
import type { Env } from "../env";

const AUTH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
	});
}

/**
 * Login route. A plain route (not a server function) so the global
 * deny-by-default server-fn middleware (src/start.ts) needs no exemption.
 * FAIL CLOSED: missing APP_PASSWORD denies every caller (set via wrangler
 * secrets, or .dev.vars locally).
 */
export async function handleLoginRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname !== "/api/login") return null;
	if (request.method !== "POST") {
		return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
	}

	const password = env.APP_PASSWORD;
	if (!password) {
		return jsonResponse({ error: "auth_not_configured" }, { status: 503 });
	}

	let body: { password?: string } | null = null;
	try {
		body = (await request.json()) as { password?: string };
	} catch {
		return jsonResponse({ error: "invalid_body" }, { status: 400 });
	}

	if (!body?.password || body.password !== password) {
		return jsonResponse({ error: "invalid_password" }, { status: 401 });
	}

	const secret = env.APP_AUTH_SECRET ?? password;
	const expiresAt = Date.now() + AUTH_TTL_MS;
	const token = await signAuthToken(secret, expiresAt);
	return jsonResponse({ success: true, token, expiresAt });
}
