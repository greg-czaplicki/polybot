import { useEffect, useState } from "react";

/**
 * Server functions authenticate via this same-origin cookie (verified
 * server-side by requireAuth). SameSite=Strict keeps cross-site POSTs from
 * carrying it.
 */
export function setAuthCookie(token: string, expiresAtMs: number) {
	const maxAge = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
	const secure = window.location.protocol === "https:" ? "; Secure" : "";
	document.cookie = `polywhaler_auth=${encodeURIComponent(token)}; path=/; max-age=${maxAge}; SameSite=Strict${secure}`;
}

function hasAuthCookie(): boolean {
	return document.cookie
		.split(";")
		.some((part) => part.trim().startsWith("polywhaler_auth="));
}

export function useRequireAuth() {
	const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

	useEffect(() => {
		const expiresAt = Number(
			localStorage.getItem("polywhaler_auth_expires_at") ?? 0,
		);
		const token = localStorage.getItem("polywhaler_auth_token");
		const authStatus =
			localStorage.getItem("polywhaler_authenticated") === "true" &&
			Number.isFinite(expiresAt) &&
			expiresAt > Date.now() &&
			Boolean(token);
		// Sessions from before the cookie existed self-heal: re-mint the cookie
		// from the stored token so server-side auth sees it without a re-login.
		if (authStatus && token && !hasAuthCookie()) {
			setAuthCookie(token, expiresAt);
		}
		setIsAuthenticated(authStatus);
		if (!authStatus) {
			window.location.href = "/login";
		}
	}, []);

	return isAuthenticated;
}
