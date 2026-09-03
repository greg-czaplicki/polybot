import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import {
	Cell,
	Empty,
	Panel,
	Row,
	Tag,
	Tape,
	Workspace,
} from "@/components/terminal/panel";
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
		<Shell
			wide
			actions={
				loadedAt ? (
					<span className="font-mono text-xxs tabular-nums text-ink-40">
						auto ·{" "}
						{new Date(loadedAt).toLocaleTimeString(undefined, {
							hour: "numeric",
							minute: "2-digit",
						})}
					</span>
				) : undefined
			}
		>
			{/* Totals strip */}
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 bg-ink-05 px-3 py-2 font-mono text-xs tabular-nums">
				<span className="mr-2 text-xxs font-semibold uppercase tracking-[0.18em] text-ink-55">
					Wallet CLV
				</span>
				{totals ? (
					<>
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
					</>
				) : (
					<span className="text-ink-55">
						{loadFailed ? "failed to load" : "loading…"}
					</span>
				)}
				<span className="ml-auto text-xxs text-ink-40">
					top-holder entries settled against the close · skill = beating it
					repeatedly
				</span>
			</div>

			<Workspace>
				<Panel
					title="Skill leaderboard"
					span={12}
					meta="≥3 settled · ranked by relative CLV (close move as % of entry)"
				>
					{leaderboard.length === 0 ? (
						<Empty>
							No wallets qualify yet. Entries settle when their games start; a
							wallet needs 3 settled entries to rank.
						</Empty>
					) : (
						<Tape
							minWidth="min-w-[760px]"
							head={[
								{ label: "Wallet" },
								{ label: "Sport" },
								{ label: "Rel CLV", align: "right" },
								{ label: "Avg CLV", align: "right" },
								{ label: "Beat close", align: "right" },
								{ label: "Entries", align: "right" },
								{ label: "Volume in", align: "right" },
								{ label: "Last seen", align: "right" },
							]}
						>
							{leaderboard.map((row) => (
								<Row key={row.walletAddress}>
									<Cell mono>
										<a
											href={profileUrl(row.walletAddress)}
											target="_blank"
											rel="noopener noreferrer"
											className="text-ink-85 hover:text-brand-blue"
										>
											{shortWallet(row.walletAddress)}
										</a>
									</Cell>
									<Cell>
										<SportMixCell
											topSport={row.topSport}
											topSportShare={row.topSportShare}
											sportsCount={row.sportsCount}
											markets={row.markets}
										/>
									</Cell>
									<Cell
										right
										className={`font-semibold ${clvClass(row.avgRelClv)}`}
									>
										{formatPct(row.avgRelClv)}
									</Cell>
									<Cell right className={clvClass(row.avgClv)}>
										{formatCents(row.avgClv)}
									</Cell>
									<Cell right className="text-ink-70">
										{row.beatCloseCount}/{row.closed}
									</Cell>
									<Cell right className="text-ink-70">
										{row.entries}
									</Cell>
									<Cell right className="text-ink-70">
										{formatUsd(row.totalDeltaUsd)}
									</Cell>
									<Cell right className="text-ink-55">
										{formatTime(row.lastSeenAt)}
									</Cell>
								</Row>
							))}
						</Tape>
					)}
				</Panel>

				<Panel
					title="Sport specialists"
					span={12}
					meta="≥5 markets · ≥90% one sport · descriptive only (2026-08-27 read: no specialist edge yet)"
				>
					{specialists.length === 0 ? (
						<Empty>No specialists with 3 settled entries yet.</Empty>
					) : (
						<Tape
							minWidth="min-w-[820px]"
							head={[
								{ label: "Wallet" },
								{ label: "Sport" },
								{ label: "Focus", align: "right" },
								{ label: "Rel CLV", align: "right" },
								{ label: "Avg CLV", align: "right" },
								{ label: "Beat close", align: "right" },
								{ label: "Markets", align: "right" },
								{ label: "Entries", align: "right" },
								{ label: "Volume in", align: "right" },
								{ label: "Last seen", align: "right" },
							]}
						>
							{specialists.map((row) => (
								<Row key={row.walletAddress}>
									<Cell mono>
										<a
											href={profileUrl(row.walletAddress)}
											target="_blank"
											rel="noopener noreferrer"
											className="text-ink-85 hover:text-brand-blue"
										>
											{shortWallet(row.walletAddress)}
										</a>
									</Cell>
									<Cell>
										<Tag>{sportBadge(row.sport)}</Tag>
									</Cell>
									<Cell right className="text-ink-70">
										{Math.round(row.sportShare * 100)}%
									</Cell>
									<Cell
										right
										className={`font-semibold ${clvClass(row.avgRelClv)}`}
									>
										{formatPct(row.avgRelClv)}
									</Cell>
									<Cell right className={clvClass(row.avgClv)}>
										{formatCents(row.avgClv)}
									</Cell>
									<Cell right className="text-ink-70">
										{row.beatCloseCount}/{row.closed}
									</Cell>
									<Cell right className="text-ink-70">
										{row.markets}
									</Cell>
									<Cell right className="text-ink-70">
										{row.entries}
									</Cell>
									<Cell right className="text-ink-70">
										{formatUsd(row.totalDeltaUsd)}
									</Cell>
									<Cell right className="text-ink-55">
										{formatTime(row.lastSeenAt)}
									</Cell>
								</Row>
							))}
						</Tape>
					)}
				</Panel>

				<Panel
					title="Entry feed"
					span={12}
					meta="newest top-20 appearances · size is a lower bound"
				>
					{recent.length === 0 ? (
						<Empty>No entries yet.</Empty>
					) : (
						<Tape
							minWidth="min-w-[820px]"
							head={[
								{ label: "Market" },
								{ label: "Side" },
								{ label: "Wallet" },
								{ label: "Kind" },
								{ label: "Sport" },
								{ label: "Size", align: "right" },
								{ label: "Entry", align: "right" },
								{ label: "CLV", align: "right" },
								{ label: "Status" },
								{ label: "Seen", align: "right" },
								{ label: "Game", align: "right" },
							]}
						>
							{recent.map((entry) => (
								<Row
									key={`${entry.walletAddress}-${entry.observedAt}-${entry.marketTitle}-${entry.side}`}
								>
									<Cell className="max-w-[16rem] truncate text-ink-95">
										{entry.marketTitle}
									</Cell>
									<Cell>
										<Tag>{entry.side}</Tag>
									</Cell>
									<Cell mono>
										<a
											href={profileUrl(entry.walletAddress)}
											target="_blank"
											rel="noopener noreferrer"
											className="text-ink-70 hover:text-brand-blue"
										>
											{shortWallet(entry.walletAddress)}
										</a>
									</Cell>
									<Cell className="text-xs text-ink-55">
										{entry.kind === "new_top20" ? "new" : "added"}
									</Cell>
									<Cell>
										{entry.sport ? <Tag>{sportBadge(entry.sport)}</Tag> : "—"}
									</Cell>
									<Cell right>{formatUsd(entry.deltaUsd)}</Cell>
									<Cell right className="text-ink-70">
										{entry.entryPrice.toFixed(2)}
									</Cell>
									<Cell
										right
										className={`font-semibold ${clvClass(entry.clv)}`}
									>
										{entry.status === "closed" ? formatCents(entry.clv) : "—"}
									</Cell>
									<Cell
										className={`font-mono text-xxs uppercase tracking-[0.12em] ${
											entry.status === "closed"
												? "text-ink-70"
												: "text-signal-pos"
										}`}
									>
										{entry.status === "closed" ? "settled" : entry.status}
									</Cell>
									<Cell right className="text-ink-55">
										{formatTime(entry.observedAt)}
									</Cell>
									<Cell right className="text-ink-55">
										{formatTime(entry.eventTime)}
									</Cell>
								</Row>
							))}
						</Tape>
					)}
				</Panel>
			</Workspace>
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
