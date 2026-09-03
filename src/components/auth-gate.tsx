import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { useRequireAuth } from "@/lib/auth";

export function AuthGate({ children }: { children: ReactNode }) {
	const isAuthenticated = useRequireAuth();

	if (isAuthenticated === false) {
		return null;
	}

	if (isAuthenticated === null) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-ink-00 text-ink-85">
				<div className="text-center">
					<Loader2 className="h-8 w-8 animate-spin text-brand-blue mx-auto mb-4" />
					<p className="font-mono text-xs text-ink-55">
						Checking authentication...
					</p>
				</div>
			</div>
		);
	}

	return <>{children}</>;
}
