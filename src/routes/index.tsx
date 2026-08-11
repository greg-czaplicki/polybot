import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import { formatSideLabel } from "@/lib/side-label";
import {
	type DashboardEraSummary,
	type DashboardHealth,
	type DashboardPickRow,
	type DashboardRecap,
	getDashboardFn,
} from "../server/api/dashboard";

export const Route = createFileRoute("/")({
	component: DashboardPage,
});

const NAV_LINKS: { href: string; label: string }[] = [
	{ href: "/sharp", label: "Markets" },
	{ href: "/bot", label: "Bot" },
	{ href: "/stats", label: "Stats" },
	{ href: "/shadow", label: "Shadow" },
	{ href: "/wallets", label: "Wallets" },
	{ href: "/strategy", label: "Strategy" },
	{ href: "/canonical", label: "Canonical" },
];

function formatRelativeTime(seconds: number | null): string {
	if (!seconds) return "never";
	const diff = Math.floor(Date.now() / 1000) - seconds;
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

function formatEventTime(iso: string | null): string {
	if (!iso) return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString(undefined, {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatSettledTime(seconds: number | null): string {
	if (!seconds) return "—";
	return new Date(seconds * 1000).toLocaleString(undefined, {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatUnits(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "—";
	return `${value >= 0 ? "+" : ""}${value.toFixed(2)}u`;
}

function formatPct(value: number | null, digits = 1): string {
	if (value === null || !Number.isFinite(value)) return "—";
	return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

/**
 * CLV average with its sample size — an average over thin coverage reads
 * as authoritative without the n (book CLV was shown for weeks while
 * backed by 10 picks). "— (n=0)" collapses to a bare dash.
 */
function formatClvWithN(value: number | null, n: number): string {
	if (n === 0) return "—";
	return `${formatPct(value, 2)} (n=${n})`;
}

function signClass(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "text-ink-55";
	return value >= 0 ? "text-signal-pos" : "text-signal-bad";
}

function statusClass(status: string): string {
	switch (status) {
		case "win":
			return "bg-signal-pos/10 text-signal-pos ring-signal-pos/35";
		case "loss":
			return "bg-signal-bad/10 text-signal-bad ring-signal-bad/35";
		default:
			return "bg-ink-10 text-ink-70 ring-ink-25";
	}
}

type HealthTone = "ok" | "warn" | "bad" | "unknown";

function ageTone(
	seconds: number | null,
	warnAfter: number,
	badAfter: number,
): HealthTone {
	if (!seconds) return "unknown";
	const age = Math.floor(Date.now() / 1000) - seconds;
	if (age <= warnAfter) return "ok";
	if (age <= badAfter) return "warn";
	return "bad";
}

const TONE_DOT: Record<HealthTone, string> = {
	ok: "bg-signal-pos",
	warn: "bg-signal-warn",
	bad: "bg-signal-bad",
	unknown: "bg-ink-25",
};

interface HealthItem {
	label: string;
	tone: HealthTone;
	detail: string;
}

function buildHealthItems(health: DashboardHealth): HealthItem[] {
	return [
		{
			label: "Bot",
			// VPS bot polls every few minutes; silence past 15m is unusual.
			tone: ageTone(health.botLastSeenAt, 15 * 60, 60 * 60),
			detail: `polled ${formatRelativeTime(health.botLastSeenAt)}`,
		},
		{
			label: "Pipeline",
			// Worker cron runs every 2 minutes.
			tone: ageTone(health.pipelineNewestAt, 10 * 60, 30 * 60),
			detail: `data ${formatRelativeTime(health.pipelineNewestAt)}`,
		},
		{
			label: "Canonical",
			// Staleness threshold matches canonical-sync (6h).
			tone:
				health.canonicalLastRunStatus === "failed"
					? "bad"
					: ageTone(health.canonicalLastRunAt, 6 * 3600, 24 * 3600),
			detail: `${health.canonicalLastRunStatus ?? "no runs"} ${formatRelativeTime(
				health.canonicalLastRunAt,
			)}`,
		},
		{
			label: "Last pick",
			// Informational — long gaps between picks are legitimate.
			tone: health.lastPickAt ? "ok" : "unknown",
			detail: formatRelativeTime(health.lastPickAt),
		},
	];
}

function PickSide({ pick }: { pick: DashboardPickRow }) {
	const sideText = formatSideLabel(
		pick.sharpSideLabel,
		pick.sharpSide,
		pick.marketTitle,
	);
	return (
		<span>
			<span className="text-ink-95">{sideText ?? pick.sharpSide ?? "—"}</span>
			{pick.betType ? (
				<span className="ml-2 text-xs uppercase text-ink-55">
					{pick.betType}
				</span>
			) : null}
		</span>
	);
}

function DashboardPage() {
	const [health, setHealth] = useState<DashboardHealth | null>(null);
	const [activeBets, setActiveBets] = useState<DashboardPickRow[]>([]);
	const [recentSettled, setRecentSettled] = useState<DashboardPickRow[]>([]);
	const [recap, setRecap] = useState<DashboardRecap | null>(null);
	const [eras, setEras] = useState<DashboardEraSummary[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const result = await getDashboardFn();
			setHealth(result.health);
			setActiveBets(result.activeBets);
			setRecentSettled(result.recentSettled);
			setRecap(result.recap);
			setEras(result.eras);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load");
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const recapSettled = recap ? recap.wins + recap.losses + recap.pushes : 0;

	return (
		<AuthGate>
			<div className="min-h-screen bg-ink-00 text-ink-85">
				<div className="mx-auto w-full max-w-6xl px-4 py-8">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<h1 className="font-sans text-2xl font-semibold tracking-tight text-ink-95">
								Polywhaler
							</h1>
							<p className="mt-0.5 font-sans text-sm text-ink-70">
								The bot runs itself — this is what happened.
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-1.5">
							{NAV_LINKS.map((link) => (
								<a
									key={link.href}
									href={link.href}
									className="inline-flex h-8 items-center rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-85 ring-1 ring-inset ring-ink-25 transition-colors hover:bg-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
								>
									{link.label}
								</a>
							))}
							<button
								type="button"
								onClick={() => void load()}
								disabled={isLoading}
								className="inline-flex h-8 items-center rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-85 ring-1 ring-inset ring-ink-25 transition-colors hover:bg-ink-15 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
							>
								{isLoading ? "…" : "Refresh"}
							</button>
						</div>
					</div>

					{error ? (
						<p className="mt-4 rounded-md bg-signal-bad/10 p-3 text-sm text-signal-bad">
							{error}
						</p>
					) : null}

					{/* Health strip */}
					<div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
						{(health ? buildHealthItems(health) : []).map((item) => (
							<div
								key={item.label}
								className="flex items-center gap-2.5 rounded-md bg-ink-05 px-4 py-3 ring-1 ring-inset ring-ink-15"
							>
								<span
									className={`h-2 w-2 flex-shrink-0 rounded-full ${TONE_DOT[item.tone]}`}
								/>
								<div className="min-w-0">
									<p className="font-mono text-xxs uppercase tracking-[0.2em] text-ink-55">
										{item.label}
									</p>
									<p className="truncate text-sm text-ink-85">{item.detail}</p>
								</div>
							</div>
						))}
						{!health && !error ? (
							<p className="col-span-full py-2 text-sm text-ink-55">
								{isLoading ? "Loading…" : ""}
							</p>
						) : null}
					</div>

					{/* Overnight recap tiles */}
					{recap ? (
						<div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
							<div className="rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15">
								<p className="font-mono text-xxs uppercase tracking-[0.2em] text-ink-55">
									Last 24h record
								</p>
								<p className="mt-1 text-lg font-semibold text-ink-95">
									{recapSettled > 0
										? `${recap.wins}-${recap.losses}${recap.pushes > 0 ? ` (${recap.pushes}p)` : ""}`
										: "nothing settled"}
								</p>
							</div>
							<div className="rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15">
								<p className="font-mono text-xxs uppercase tracking-[0.2em] text-ink-55">
									Last 24h units
								</p>
								<p
									className={`mt-1 text-lg font-semibold ${
										recapSettled > 0 ? signClass(recap.units) : "text-ink-95"
									}`}
								>
									{recapSettled > 0 ? formatUnits(recap.units) : "—"}
								</p>
							</div>
							<div className="rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15">
								<p className="font-mono text-xxs uppercase tracking-[0.2em] text-ink-55">
									Picks placed 24h
								</p>
								<p className="mt-1 text-lg font-semibold text-ink-95">
									{recap.picksPlaced}
								</p>
							</div>
							<div className="rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15">
								<p className="font-mono text-xxs uppercase tracking-[0.2em] text-ink-55">
									Active bets
								</p>
								<p className="mt-1 text-lg font-semibold text-ink-95">
									{activeBets.length}
								</p>
							</div>
						</div>
					) : null}

					{/* Active bets */}
					<h2 className="mt-8 font-mono text-sm font-semibold uppercase tracking-[0.2em] text-ink-55">
						Active bets
					</h2>
					<div className="mt-3 overflow-x-auto rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15">
						<table className="min-w-full text-left text-sm text-ink-85">
							<thead>
								<tr className="font-mono text-xxs uppercase tracking-[0.15em] text-ink-55">
									<th className="pb-2 pr-4">Market</th>
									<th className="pb-2 pr-4">Side</th>
									<th className="pb-2 pr-4">Price</th>
									<th className="pb-2 pr-4">Grade</th>
									<th className="pb-2 pr-4">Sport</th>
									<th className="pb-2 pr-4">Fill</th>
									<th className="pb-2">Starts</th>
								</tr>
							</thead>
							<tbody>
								{activeBets.map((pick) => (
									<tr key={pick.id} className="border-t border-ink-10">
										<td className="max-w-sm py-2 pr-4">
											<a
												href={`/sharp/market/${pick.conditionId}`}
												className="block truncate text-ink-95 hover:text-brand-blue"
											>
												{pick.marketTitle}
											</a>
										</td>
										<td className="py-2 pr-4">
											<PickSide pick={pick} />
										</td>
										<td className="py-2 pr-4">
											{pick.price !== null ? pick.price.toFixed(2) : "—"}
										</td>
										<td className="py-2 pr-4">{pick.grade ?? "—"}</td>
										<td className="py-2 pr-4 uppercase text-ink-55">
											{pick.sportTag ?? "—"}
										</td>
										<td className="py-2 pr-4 text-ink-55">
											{pick.fillStatus ?? "—"}
										</td>
										<td className="py-2 text-ink-55">
											{formatEventTime(pick.eventTime)}
										</td>
									</tr>
								))}
								{activeBets.length === 0 && !isLoading ? (
									<tr>
										<td colSpan={7} className="py-4 text-ink-55">
											No open bets — the bot has nothing pending.
										</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</div>

					{/* Recently settled */}
					<h2 className="mt-8 font-mono text-sm font-semibold uppercase tracking-[0.2em] text-ink-55">
						Settled (last 48h)
					</h2>
					<div className="mt-3 overflow-x-auto rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15">
						<table className="min-w-full text-left text-sm text-ink-85">
							<thead>
								<tr className="font-mono text-xxs uppercase tracking-[0.15em] text-ink-55">
									<th className="pb-2 pr-4">Market</th>
									<th className="pb-2 pr-4">Side</th>
									<th className="pb-2 pr-4">Price</th>
									<th className="pb-2 pr-4">Result</th>
									<th className="pb-2 pr-4">Units</th>
									<th className="pb-2 pr-4">CLV</th>
									<th className="pb-2">Settled</th>
								</tr>
							</thead>
							<tbody>
								{recentSettled.map((pick) => (
									<tr key={pick.id} className="border-t border-ink-10">
										<td className="max-w-sm py-2 pr-4">
											<a
												href={`/sharp/market/${pick.conditionId}`}
												className="block truncate text-ink-95 hover:text-brand-blue"
											>
												{pick.marketTitle}
											</a>
										</td>
										<td className="py-2 pr-4">
											<PickSide pick={pick} />
										</td>
										<td className="py-2 pr-4">
											{pick.price !== null ? pick.price.toFixed(2) : "—"}
										</td>
										<td className="py-2 pr-4">
											<span
												className={`inline-flex rounded px-1.5 py-0.5 font-mono text-xxs font-semibold uppercase ring-1 ring-inset ${statusClass(pick.status)}`}
											>
												{pick.status}
											</span>
										</td>
										<td className={`py-2 pr-4 ${signClass(pick.roi)}`}>
											{formatUnits(pick.roi)}
										</td>
										<td className={`py-2 pr-4 ${signClass(pick.clv)}`}>
											{pick.clv !== null ? formatPct(pick.clv * 100, 1) : "—"}
										</td>
										<td className="py-2 text-ink-55">
											{formatSettledTime(pick.settledAt)}
										</td>
									</tr>
								))}
								{recentSettled.length === 0 && !isLoading ? (
									<tr>
										<td colSpan={7} className="py-4 text-ink-55">
											Nothing settled in the last 48 hours.
										</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</div>

					{/* Era performance */}
					<h2 className="mt-8 font-mono text-sm font-semibold uppercase tracking-[0.2em] text-ink-55">
						Strategy performance
					</h2>
					<p className="mt-1 text-xs text-ink-55">
						Live picks only, current strategy code. Small samples — judge on n,
						not vibes. Full history on{" "}
						<a href="/stats" className="text-brand-blue hover:underline">
							/stats
						</a>
						.
					</p>
					<div className="mt-3 grid gap-3 sm:grid-cols-2">
						{eras.map((era) => {
							const settled = era.wins + era.losses;
							return (
								<div
									key={era.label}
									className="rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15"
								>
									<p className="font-mono text-xxs uppercase tracking-[0.2em] text-ink-55">
										{era.label}
									</p>
									<div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
										<span className="text-lg font-semibold text-ink-95">
											{era.wins}-{era.losses}
											{era.pushes > 0 ? ` (${era.pushes}p)` : ""}
										</span>
										<span
											className={`text-lg font-semibold ${signClass(era.units)}`}
										>
											{formatUnits(era.units)}
										</span>
										<span className={`text-sm ${signClass(era.roiPct)}`}>
											ROI {formatPct(era.roiPct)}
										</span>
									</div>
									<p className="mt-1 text-xs text-ink-55">
										CLV {formatClvWithN(era.avgClvPct, era.clvN)} · DK{" "}
										{formatClvWithN(era.avgBookClvPct, era.bookClvN)} · Pin{" "}
										{formatClvWithN(era.avgPinClvPct, era.pinClvN)} · {settled}{" "}
										settled · {era.pending} pending
									</p>
								</div>
							);
						})}
						{eras.length === 0 && !isLoading ? (
							<p className="text-sm text-ink-55">No era data yet.</p>
						) : null}
					</div>
				</div>
			</div>
		</AuthGate>
	);
}
