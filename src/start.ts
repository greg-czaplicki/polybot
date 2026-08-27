import { createStart } from "@tanstack/react-start";

import { authMiddleware } from "./server/api/authed-fn";

/**
 * Global server-function middleware (2026-08-28 security triage): EVERY
 * server function requires the signed auth token — deny by default. Login
 * is not a server function (POST /api/login in server.ts), so there is no
 * exemption to manage here.
 */
export const startInstance = createStart(() => ({
	functionMiddleware: [authMiddleware],
}));
