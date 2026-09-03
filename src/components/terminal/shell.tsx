import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";

import { AuthGate } from "@/components/auth-gate";

/**
 * The terminal chrome: one bar, every screen. Primary screens are the
 * operator's daily loop; Research holds the analyst tooling that used to
 * clutter the top level.
 */
const PRIMARY: {
	href: string;
	label: string;
	match: (p: string) => boolean;
}[] = [
	{ href: "/", label: "Terminal", match: (p) => p === "/" },
	{ href: "/sharp", label: "Tape", match: (p) => p.startsWith("/sharp") },
	{ href: "/stats", label: "Book", match: (p) => p.startsWith("/stats") },
	{
		href: "/shadow",
		label: "Verdicts",
		match: (p) => p.startsWith("/shadow"),
	},
	{ href: "/bot", label: "Bot", match: (p) => p.startsWith("/bot") },
];

const RESEARCH: { href: string; label: string }[] = [
	{ href: "/runtime", label: "Runtime stats" },
	{ href: "/strategy", label: "Strategy context" },
	{ href: "/wallets", label: "Wallets" },
	{ href: "/canonical", label: "Canonical games" },
];

function UtcClock() {
	const [now, setNow] = useState<Date | null>(null);
	useEffect(() => {
		setNow(new Date());
		const id = window.setInterval(() => setNow(new Date()), 15_000);
		return () => window.clearInterval(id);
	}, []);
	if (!now) return null;
	const hh = `${now.getUTCHours()}`.padStart(2, "0");
	const mm = `${now.getUTCMinutes()}`.padStart(2, "0");
	return (
		<span
			className="font-mono text-xxs tabular-nums text-ink-40"
			title="UTC — every stamp in the database is UTC"
		>
			{hh}:{mm}Z
		</span>
	);
}

export function Shell({
	children,
	wide = false,
	actions,
}: {
	children: ReactNode;
	/** Full-bleed content (the terminal workspace); default is a 6xl column. */
	wide?: boolean;
	/** Right-side controls for this screen (refresh, range). */
	actions?: ReactNode;
}) {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const inResearch = RESEARCH.some((r) => pathname.startsWith(r.href));

	return (
		<AuthGate>
			<div className="min-h-screen bg-ink-00 text-ink-85">
				<div className="sticky top-0 z-30 border-b border-ink-15 bg-ink-05/95 backdrop-blur-sm">
					<div className="flex h-10 items-center gap-1 px-3">
						<a
							href="/"
							className="mr-3 shrink-0 font-sans text-sm font-semibold tracking-tight text-ink-95"
						>
							Polywhaler
						</a>
						<nav
							aria-label="Primary"
							className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
						>
							{PRIMARY.map((link) => {
								const active = link.match(pathname);
								return (
									<a
										key={link.href}
										href={link.href}
										aria-current={active ? "page" : undefined}
										className={`flex h-10 shrink-0 items-center border-b-2 px-2.5 font-mono text-xxs font-semibold uppercase tracking-[0.18em] transition-colors ${
											active
												? "border-brand-blue text-ink-95"
												: "border-transparent text-ink-55 hover:text-ink-85"
										}`}
									>
										{link.label}
									</a>
								);
							})}
							<details className="group relative shrink-0">
								<summary
									className={`flex h-10 cursor-pointer list-none items-center gap-1 border-b-2 px-2.5 font-mono text-xxs font-semibold uppercase tracking-[0.18em] transition-colors ${
										inResearch
											? "border-brand-blue text-ink-95"
											: "border-transparent text-ink-55 hover:text-ink-85"
									}`}
								>
									Research
									<span aria-hidden className="text-ink-40">
										▾
									</span>
								</summary>
								<div className="absolute left-0 top-full z-40 mt-px min-w-44 border border-ink-15 bg-ink-05 py-1 shadow-[0_8px_24px_-12px_var(--ink-00)]">
									{RESEARCH.map((r) => (
										<a
											key={r.href}
											href={r.href}
											className={`block px-3 py-1.5 text-sm hover:bg-ink-10 ${
												pathname.startsWith(r.href)
													? "text-ink-95"
													: "text-ink-70"
											}`}
										>
											{r.label}
										</a>
									))}
								</div>
							</details>
						</nav>
						<div className="ml-2 flex shrink-0 items-center gap-3">
							{actions}
							<UtcClock />
						</div>
					</div>
				</div>
				<main className={wide ? "" : "mx-auto w-full max-w-6xl px-4 py-6"}>
					{children}
				</main>
			</div>
		</AuthGate>
	);
}

/** Small ghost control used in the shell's action slot. */
export function ShellButton({
	onClick,
	disabled,
	children,
	title,
}: {
	onClick: () => void;
	disabled?: boolean;
	children: ReactNode;
	title?: string;
}) {
	return (
		<button
			type="button"
			title={title}
			onClick={onClick}
			disabled={disabled}
			className="h-6 border border-ink-25 px-2 font-mono text-xxs font-semibold uppercase tracking-[0.15em] text-ink-70 transition-colors hover:bg-ink-15 hover:text-ink-95 disabled:opacity-50"
		>
			{children}
		</button>
	);
}
