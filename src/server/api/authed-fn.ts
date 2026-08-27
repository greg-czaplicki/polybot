/**
 * Deny-by-default server-function auth (2026-08-28 security triage).
 *
 * Registered GLOBALLY via `functionMiddleware` in src/start.ts: every
 * server function verifies the signed auth token (carried by the
 * `polywhaler_auth` SameSite=Strict cookie, or `x-auth-token` header)
 * before its handler runs. `requireAuth` fails closed when secrets are
 * unconfigured. Login is a plain route (POST /api/login), not a server
 * function, so nothing needs an exemption.
 */
import { createMiddleware } from "@tanstack/react-start";

import { type RequestContext, requireAuth } from "../env";

export const authMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next, context }) => {
		await requireAuth(context as RequestContext | undefined);
		return next();
	},
);
