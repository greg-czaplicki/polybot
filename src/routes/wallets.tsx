import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { Shell } from "@/components/terminal/shell";
import { getSportLabel } from "@/lib/sports";
import {
	getWalletClvSummaryFn,
	type WalletClvTotals,
	type WalletEntryRow,
	type WalletLeaderboardRow,
	type WalletSpecialistRow,
} from "../server/api/wallet-clv-api";

export const Route = createFileRoute("/wallets")({
	component: WalletsPage,
});

const REFRESH_INTERVAL_MS = 60_000;

function shortWallet(address: string): string {
	if (address.length <= 12) return address;
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatUsd(value: number): string {
	if (value >= 10_000) return `$${(value / 1000).toFixed(1)}k`;
	return `$${Math.round(value).toLocaleString()}`;
}

function formatCents(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "—";
	return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}¢`;
}

function formatPct(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "—";
	return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function profileUrl(address: string): string {
	return `https://polymarket.com/profile/${address}`;
}

function clvClass(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "text-ink-55";
	return value >= 0 ? "text-signal-pos" : "text-signal-bad";
}

function formatTime(seconds: number): string {
	return new Date(seconds * 1000).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function sportBadge(tag: string | null): string {
	return getSportLabel(tag) ?? "?";
}

function SportMixCell({
	topSport,
	topSportShare,
	sportsCount,
	markets,
}: {
	topSport: string | null;
	topSportShare: number | null;
	sportsCount: number;
	markets: number;
}) {
	if (!topSport || topSportShare === null) {
		return <span className="text-ink-40">—</span>;
	}
	// Badge = specialist, same bar as the Sport Specialists panel (>=5
	// distinct markets): increments pyramided into one game are 100%
	// concentrated without saying anything about the wallet.
	if (topSportShare >= 0.9 && markets >= 5) {
		return (
			<span className="inline-flex items-center rounded bg-brand-blue/10 px-1.5 py-0.5 text-xxs font-semibold uppercase tracking-wider text-brand-cyan ring-1 ring-inset ring-brand-blue/35">
				{sportBadge(topSport)}
			</span>
		);
	}
	return (
		<span className="text-ink-70">
			{sportBadge(topSport)}{" "}
			<span className="text-ink-55">
				{Math.round(topSportShare * 100)}%
				{sportsCount > 1 ? ` · ${sportsCount} sports` : ""}
			</span>
		</span>
	);
}

function statusTone(status: string): string {
	switch (status) {
		case "closed":
			return "bg-brand-blue/10 text-brand-cyan ring-brand-blue/35";
		case "void":
			return "bg-ink-10 text-ink-55 ring-ink-25";
		default:
			return "bg-ink-10 text-ink-70 ring-ink-25";
	}
}

function WalletsPage() {
	const [totals, setTotals] = useState<WalletClvTotals | null>(null);
	const [recent, setRecent] = useState<WalletEntryRow[]>([]);
	const [leaderboard, setLeaderboard] = useState<WalletLeaderboardRow[]>([]);
	const [specialists, setSpecialists] = useState<WalletSpecialistRow[]>([]);
	const [loadedAt, setLoadedAt] = useState<number | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);

	const load = useCallback(async () => {
		try {
			const result = await getWalletClvSummaryFn();
			setTotals(result.totals);
			setRecent(result.recent);
			setLeaderboard(result.leaderboard);
			setSpecialists(result.specialists);
			setLoadedAt(Date.now());
			setLoadFailed(false);
		} catch (error) {
			console.error("Failed to load wallet CLV summary:", error);
			setLoadFailed(true);
		}
	}, []);

	useEffect(() => {
		void load();
		const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [load]);

	return (
		<Shell wide>
			<div>
				<div className="mx-auto w-full max-w-6xl px-4 py-10">
					{/* Header */}
					<div className="mb-6 flex flex-wrap items-start justify-between gap-4">
						<div>
							<h1 className="font-sans text-2xl font-semibold tracking-tight text-ink-95">
								Wallet CLV
							</h1>
							<p className="mt-0.5 font-sans text-sm text-ink-70">
								Top-holder entries observed per market, settled against the
								closing line. Skill = beating the close, repeatedly.
							</p>
						</div>
						<div className="flex items-center gap-2"></div>
					</div>

					{/* Totals strip */}
					{totals && (
						<div className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-xs tabular-nums">
							<Stat label="entries" value={String(totals.entries)} />
							<Stat label="wallets" value={String(totals.distinctWallets)} />
							<Stat label="24h" value={String(totals.entriesLast24h)} />
							<Stat label="open" value={String(totals.open)} muted />
							<Stat label="settled" value={String(totals.closed)} />
							<Stat
								label="specialists"
								value={String(totals.specialistWallets)}
							/>
							<Stat
								label="avg clv"
								value={formatCents(totals.avgClv)}
								tone={
									totals.avgClv === null
										? undefined
										: totals.avgClv >= 0
											? "pos"
											: "bad"
								}
							/>
							{loadedAt && (
								<span className="ml-auto text-xxs uppercase tracking-wider text-ink-40">
									auto-refreshes · updated{" "}
									{new Date(loadedAt).toLocaleTimeString(undefined, {
										hour: "numeric",
										minute: "2-digit",
									})}
								</span>
							)}
						</div>
					)}
					{loadFailed && (
						<div className="mb-6 rounded-md bg-ink-05 p-4 font-mono text-sm text-ink-55 ring-1 ring-inset ring-ink-15">
							failed to load wallet data.
						</div>
					)}

					{/* Leaderboard */}
					<section
						aria-labelledby="wallet-leaderboard-heading"
						className="mb-6 rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15"
					>
						<h2
							id="wallet-leaderboard-heading"
							className="mb-1 font-mono text-xxs font-semibold uppercase tracking-[0.2em] text-ink-55"
						>
							Skill Leaderboard
						</h2>
						<p className="mb-3 font-sans text-xs text-ink-55">
							Wallets with ≥3 settled entries, ranked by relative CLV (close
							move as % of entry price) — did their entry beat the close, and by
							how much relative to what they paid?
						</p>
						{leaderboard.length === 0 ? (
							<div className="font-mono text-sm text-ink-55">
								no wallets qualify yet — entries settle when their games start,
								and a wallet needs 3 settled entries to rank.
							</div>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full font-mono text-xs tabular-nums">
									<thead>
										<tr className="text-left text-xxs uppercase tracking-wider text-ink-55">
											<th className="py-1.5 pr-4 font-semibold">Wallet</th>
											<th className="py-1.5 pr-4 font-semibold">Sport</th>
											<th className="py-1.5 pr-4 font-semibold">Rel CLV</th>
											<th className="py-1.5 pr-4 font-semibold">Avg CLV</th>
											<th className="py-1.5 pr-4 font-semibold">Beat close</th>
											<th className="py-1.5 pr-4 font-semibold">Entries</th>
											<th className="py-1.5 pr-4 font-semibold">Volume in</th>
											<th className="py-1.5 font-semibold">Last seen</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-ink-15">
										{leaderboard.map((row) => (
											<tr key={row.walletAddress}>
												<td className="py-2 pr-4">
													<a
														href={profileUrl(row.walletAddress)}
														target="_blank"
														rel="noopener noreferrer"
														className="text-ink-85 underline decoration-ink-25 underline-offset-2 transition-colors hover:text-brand-cyan hover:decoration-brand-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
													>
														{shortWallet(row.walletAddress)}
													</a>
												</td>
												<td className="py-2 pr-4">
													<SportMixCell
														topSport={row.topSport}
														topSportShare={row.topSportShare}
														sportsCount={row.sportsCount}
														markets={row.markets}
													/>
												</td>
												<td
													className={`py-2 pr-4 font-semibold ${clvClass(row.avgRelClv)}`}
												>
													{formatPct(row.avgRelClv)}
												</td>
												<td className={`py-2 pr-4 ${clvClass(row.avgClv)}`}>
													{formatCents(row.avgClv)}
												</td>
												<td className="py-2 pr-4 text-ink-70">
													{row.beatCloseCount}/{row.closed}
												</td>
												<td className="py-2 pr-4 text-ink-70">{row.entries}</td>
												<td className="py-2 pr-4 text-ink-70">
													{formatUsd(row.totalDeltaUsd)}
												</td>
												<td className="py-2 text-ink-55">
													{formatTime(row.lastSeenAt)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</section>

					{/* Sport specialists */}
					<section
						aria-labelledby="wallet-specialists-heading"
						className="mb-6 rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15"
					>
						<h2
							id="wallet-specialists-heading"
							className="mb-1 font-mono text-xxs font-semibold uppercase tracking-[0.2em] text-ink-55"
						>
							Sport Specialists
						</h2>
						<p className="mb-3 font-sans text-xs text-ink-55">
							Wallets with ≥5 distinct markets and ≥90% of them in one sport
							(pyramided increments into one game count once), ranked by
							relative CLV (≥3 settled to rank). Descriptive only — the
							2026-08-27 read found no specialist CLV edge yet; small-n leaders
							are expected by chance.
						</p>
						{specialists.length === 0 ? (
							<div className="font-mono text-sm text-ink-55">
								no specialists with 3 settled entries yet.
							</div>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full font-mono text-xs tabular-nums">
									<thead>
										<tr className="text-left text-xxs uppercase tracking-wider text-ink-55">
											<th className="py-1.5 pr-4 font-semibold">Wallet</th>
											<th className="py-1.5 pr-4 font-semibold">Sport</th>
											<th className="py-1.5 pr-4 font-semibold">Focus</th>
											<th className="py-1.5 pr-4 font-semibold">Rel CLV</th>
											<th className="py-1.5 pr-4 font-semibold">Avg CLV</th>
											<th className="py-1.5 pr-4 font-semibold">Beat close</th>
											<th className="py-1.5 pr-4 font-semibold">Markets</th>
											<th className="py-1.5 pr-4 font-semibold">Entries</th>
											<th className="py-1.5 pr-4 font-semibold">Volume in</th>
											<th className="py-1.5 font-semibold">Last seen</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-ink-15">
										{specialists.map((row) => (
											<tr key={row.walletAddress}>
												<td className="py-2 pr-4">
													<a
														href={profileUrl(row.walletAddress)}
														target="_blank"
														rel="noopener noreferrer"
														className="text-ink-85 underline decoration-ink-25 underline-offset-2 transition-colors hover:text-brand-cyan hover:decoration-brand-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
													>
														{shortWallet(row.walletAddress)}
													</a>
												</td>
												<td className="py-2 pr-4">
													<span className="inline-flex items-center rounded bg-brand-blue/10 px-1.5 py-0.5 text-xxs font-semibold uppercase tracking-wider text-brand-cyan ring-1 ring-inset ring-brand-blue/35">
														{sportBadge(row.sport)}
													</span>
												</td>
												<td className="py-2 pr-4 text-ink-70">
													{Math.round(row.sportShare * 100)}%
												</td>
												<td
													className={`py-2 pr-4 font-semibold ${clvClass(row.avgRelClv)}`}
												>
													{formatPct(row.avgRelClv)}
												</td>
												<td className={`py-2 pr-4 ${clvClass(row.avgClv)}`}>
													{formatCents(row.avgClv)}
												</td>
												<td className="py-2 pr-4 text-ink-70">
													{row.beatCloseCount}/{row.closed}
												</td>
												<td className="py-2 pr-4 text-ink-70">{row.markets}</td>
												<td className="py-2 pr-4 text-ink-70">{row.entries}</td>
												<td className="py-2 pr-4 text-ink-70">
													{formatUsd(row.totalDeltaUsd)}
												</td>
												<td className="py-2 text-ink-55">
													{formatTime(row.lastSeenAt)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</section>

					{/* Live entry feed */}
					<section
						aria-labelledby="wallet-feed-heading"
						className="rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15"
					>
						<h2
							id="wallet-feed-heading"
							className="mb-1 font-mono text-xxs font-semibold uppercase tracking-[0.2em] text-ink-55"
						>
							Entry Feed
						</h2>
						<p className="mb-3 font-sans text-xs text-ink-55">
							Newest observed positions — “new” means first appearance in a
							market’s top 20 (entry size is a lower bound).
						</p>
						{recent.length === 0 ? (
							<div className="font-mono text-sm text-ink-55">
								no entries yet.
							</div>
						) : (
							<ul className="divide-y divide-ink-15">
								{recent.map((entry) => (
									<li
										key={`${entry.walletAddress}-${entry.observedAt}-${entry.marketTitle}-${entry.side}`}
										className="py-2.5 first:pt-0 last:pb-0"
									>
										<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
											<div className="min-w-0 flex-1">
												<span className="font-sans text-sm font-semibold text-ink-95">
													{entry.marketTitle}
												</span>
												<span className="ml-2 font-mono text-xxs uppercase tracking-wider text-ink-55">
													side {entry.side}
												</span>
											</div>
											<div className="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums">
												<span className="text-ink-85">
													{formatUsd(entry.deltaUsd)}
												</span>
												<span className="text-ink-55">
													@ {entry.entryPrice.toFixed(2)}
												</span>
												{entry.status === "closed" && (
													<span
														className={`font-semibold ${clvClass(entry.clv)}`}
													>
														{formatCents(entry.clv)}
													</span>
												)}
												<span
													className={`inline-flex items-center rounded px-1.5 py-0.5 text-xxs font-semibold uppercase tracking-wider ring-1 ring-inset ${statusTone(entry.status)}`}
												>
													{entry.status === "closed" ? "settled" : entry.status}
												</span>
											</div>
										</div>
										<div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 font-mono text-xxs tabular-nums text-ink-55">
											<a
												href={profileUrl(entry.walletAddress)}
												target="_blank"
												rel="noopener noreferrer"
												className="underline decoration-ink-25 underline-offset-2 transition-colors hover:text-brand-cyan hover:decoration-brand-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
											>
												{shortWallet(entry.walletAddress)}
											</a>
											<span aria-hidden>·</span>
											<span>
												{entry.kind === "new_top20" ? "new" : "added"}
											</span>
											{entry.sport && (
												<>
													<span aria-hidden>·</span>
													<span className="uppercase">
														{sportBadge(entry.sport)}
													</span>
												</>
											)}
											<span aria-hidden>·</span>
											<span>{formatTime(entry.observedAt)}</span>
											<span aria-hidden>·</span>
											<span>game {formatTime(entry.eventTime)}</span>
										</div>
									</li>
								))}
							</ul>
						)}
					</section>
				</div>
			</div>
		</Shell>
	);
}

function Stat({
	label,
	value,
	tone,
	muted,
}: {
	label: string;
	value: string;
	tone?: "pos" | "bad";
	muted?: boolean;
}) {
	const valueClass = muted
		? "text-ink-55"
		: tone === "pos"
			? "text-signal-pos"
			: tone === "bad"
				? "text-signal-bad"
				: "text-ink-95";
	return (
		<span className="flex items-baseline gap-1.5">
			<span className={`font-semibold ${valueClass}`}>{value}</span>
			<span className="text-xxs uppercase tracking-wider text-ink-55">
				{label}
			</span>
		</span>
	);
}
