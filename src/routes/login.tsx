import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { setAuthCookie } from "@/lib/auth";

export const Route = createFileRoute("/login")({
	component: LoginPage,
});

function LoginPage() {
	const navigate = useNavigate();
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const AUTH_TTL_DAYS = 30;

	const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);
		setIsLoading(true);

		try {
			const response = await fetch("/api/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password }),
			});
			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(
					payload?.error === "invalid_password"
						? "Invalid password"
						: (payload?.error ?? "Login failed"),
				);
			}
			const result = (await response.json()) as {
				token: string;
				expiresAt: number;
			};
			const expiresAt =
				result.expiresAt ?? Date.now() + AUTH_TTL_DAYS * 24 * 60 * 60 * 1000;

			localStorage.setItem("polywhaler_authenticated", "true");
			localStorage.setItem("polywhaler_auth_expires_at", String(expiresAt));
			localStorage.setItem("polywhaler_auth_token", result.token);
			setAuthCookie(result.token, expiresAt);
			navigate({ to: "/" });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Invalid password");
			setIsLoading(false);
		}
	};

	return (
		<div className="flex min-h-screen items-center justify-center bg-ink-00 p-4 text-ink-85">
			<div className="w-full max-w-md">
				<div className="space-y-6 rounded-lg bg-ink-05 p-8 ring-1 ring-inset ring-ink-15">
					<div className="flex flex-col items-center gap-3 text-center">
						<img src="/logo-trans.png" alt="" className="h-20 w-auto" />
						<h1 className="font-sans text-2xl font-bold uppercase leading-tight tracking-wider text-ink-95">
							Polywhaler
						</h1>
						<p className="font-mono text-xxs uppercase tracking-wider text-ink-55">
							Sign in to continue
						</p>
					</div>

					<form onSubmit={handleSubmit} className="space-y-4">
						<div className="space-y-2">
							<label
								htmlFor="password"
								className="block font-mono text-xxs font-semibold uppercase tracking-wider text-ink-55"
							>
								Password
							</label>
							<input
								id="password"
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								className="w-full rounded-md bg-ink-10 px-4 py-3 font-sans text-sm text-ink-95 placeholder:text-ink-40 ring-1 ring-inset ring-ink-25 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
								placeholder="Enter password"
								disabled={isLoading}
								autoFocus
							/>
						</div>

						{error && (
							<div className="rounded-md bg-signal-bad/10 px-4 py-3 font-mono text-xxs font-semibold uppercase tracking-wider text-signal-bad ring-1 ring-inset ring-signal-bad/35">
								{error}
							</div>
						)}

						<button
							type="submit"
							disabled={isLoading || !password}
							className="inline-flex h-10 w-full items-center justify-center rounded-full bg-brand-blue px-4 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-00 transition-colors hover:bg-brand-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:cursor-not-allowed disabled:opacity-50"
						>
							{isLoading ? "Verifying…" : "Access Dashboard"}
						</button>
					</form>
				</div>
			</div>
		</div>
	);
}
