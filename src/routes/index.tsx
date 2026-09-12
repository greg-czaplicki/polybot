import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import {
	PlChartSection,
	presetRange,
} from "@/components/charts/pl-chart-section";
import { ago, clock, dollars, pct, units } from "@/components/terminal/format";
import {
	Cell,
	Dot,
	Empty,
	Num,
	Panel,
	Row,
	Stat,
	Tag,
	Tape,
	type Tone,
	toneClass,
	Workspace,
} from "@/components/terminal/panel";
import { Shell, ShellButton } from "@/components/terminal/shell";
import { roiZScore } from "@/lib/gate-verdict";
import { reasonLabel } from "@/lib/shadow-labels";
import { formatSideLabel } from "@/lib/side-label";
import {
	type DashboardHealth,
	type DashboardPickRow,
	getDashboardFn,
} from "../server/api/dashboard";
import type {
	ShadowReasonSummary,
	ShadowSportSummary,
} from "../server/api/shadow-book-api";

export const Route = createFileRoute("/")({
	component: TerminalPage,
});

type Dashboard = Awaited<ReturnType<typeof getDashboardFn>>;

function ageTone(
	seconds: number | null,
	warnAfter: number,
	badAfter: number,
): Tone {
	if (!seconds) return "off";
	const age = Math.floor(Date.now() / 1000) - seconds;
	if (age <= warnAfter) return "ok";
	if (age <= badAfter) return "warn";
	return "bad";
}

interface AliveItem {
	key: string;
	label: string;
	tone: Tone;
	value: string;
	/** Shown only when the item is not ok — what to look at. */
	alarm?: string;
}

/** The "is the machine alive" strip. Thresholds mirror each subsystem's cadence. */
function aliveItems(h: DashboardHealth): AliveItem[] {
	const botTone = ageTone(h.botLastSeenAt, 15 * 60, 60 * 60);
	const syncTone =
		h.canonicalLastRunStatus === "failed"
			? "bad"
			: ageTone(h.canonicalLastRunAt, 15 * 60, 60 * 60);
	const pipeTone = ageTone(h.pipelineNewestAt, 10 * 60, 30 * 60);
	const pinTone =
		h.pinCredits === null
			? "off"
			: h.pinCredits < 25
				? "bad"
				: h.pinCredits < 60
					? "warn"
					: ageTone(h.pinLastFetchAt, 36 * 3600, 72 * 3600);
	const bankTone =
		h.bankroll === null
			? "off"
			: ageTone(h.bankrollSyncedAt, 30 * 60, 2 * 3600);
	return [
		{
			key: "bot",
			label: "Bot",
			tone: botTone,
			value: `polled ${ago(h.botLastSeenAt)}`,
			alarm: botTone === "bad" ? "bot silent — check VPS" : undefined,
		},
		{
			key: "sync",
			label: "Sync",
			tone: syncTone,
			value: `${h.canonicalLastRunStatus ?? "none"} ${ago(h.canonicalLastRunAt)}`,
			alarm:
				syncTone === "bad"
					? h.canonicalLastRunStatus === "failed"
						? "canonical sync failed"
						: "canonical sync stale"
					: undefined,
		},
		{
			key: "pipe",
			label: "Pipeline",
			tone: pipeTone,
			value: `data ${ago(h.pipelineNewestAt)}`,
			alarm: pipeTone === "bad" ? "sharp-money cache stale" : undefined,
		},
		{
			key: "pin",
			label: "Pinnacle",
			tone: pinTone,
			value:
				h.pinCredits === null
					? "no fetches"
					: `${h.pinCredits} cr · ${h.pinFetches24h}/24h · ${ago(h.pinLastFetchAt)}`,
			alarm:
				pinTone === "bad"
					? h.pinCredits !== null && h.pinCredits < 25
						? "OddsPapi credits nearly gone"
						: "no Pinnacle fetch in 3 days"
					: undefined,
		},
		{
			key: "bank",
			label: "Bankroll",
			tone: bankTone,
			value:
				h.bankroll === null
					? "no report"
					: `${dollars(h.bankroll)} · ${
							h.stakeMode === "fixed" && h.fixedStake
								? `flat $${h.fixedStake}`
								: (h.stakeMode ?? "—")
						} · ${ago(h.bankrollSyncedAt)}`,
			alarm: bankTone === "bad" ? "bankroll report stale" : undefined,
		},
		{
			key: "lanes",
			label: "Paper lanes",
			tone: h.lanesEvaluatedAt ? "ok" : "off",
			value: h.lanesEvaluatedAt
				? `${h.lanesFired ?? 0} fired · ${ago(h.lanesEvaluatedAt)}`
				: "no heartbeat",
		},
		{
			key: "pick",
			label: "Last pick",
			tone: h.lastPickAt ? "ok" : "off",
			value: ago(h.lastPickAt),
		},
	];
}

function Side({ pick }: { pick: DashboardPickRow }) {
	const text = formatSideLabel(
		pick.sharpSideLabel,
		pick.sharpSide,
		pick.marketTitle,
	);
	return (
		<span className="text-ink-95">
			{text ?? pick.sharpSide ?? "—"}
			{pick.betType ? (
				<span className="ml-1.5">
					<Tag>{pick.betType === "moneyline" ? "ML" : pick.betType}</Tag>
				</span>
			) : null}
		</span>
	);
}

function _resultWord(status: string): string {
	return status === "win" ? "W" : status === "loss" ? "L" : "P";
}

function _resultClass(status: string): string {
	return status === "win"
		? "text-signal-pos"
		: status === "loss"
			? "text-signal-bad"
			: "text-ink-55";
}

interface VerdictRow {
	key: string;
	label: string;
	scope: string;
	verdict: "ready" | "watch" | "hold";
	reason: string;
	n: number;
	wins: number;
	losses: number;
	roiPct: number | null;
	z: number | null;
	pinClvPct: number | null;
	pinN: number;
}

function _verdictRows(
	reasons: ShadowReasonSummary[],
	bySport: ShadowSportSummary[],
): VerdictRow[] {
	const rank = { ready: 0, watch: 1, hold: 2 };
	const rows: VerdictRow[] = [
		...reasons.map((r) => ({
			key: r.rejectReason,
			label: reasonLabel(r.rejectReason),
			scope: "all",
			verdict: r.verdict,
			reason: r.verdictReason,
			n: r.cleanTotal,
			wins: r.cleanWins,
			losses: r.cleanLosses,
			roiPct: r.cleanRoiPct,
			z: r.cleanZ,
			pinClvPct: r.cleanAvgPinClvPct,
			pinN: r.cleanPinN,
		})),
		...bySport.map((r) => ({
			key: `${r.rejectReason}:${r.sportTag}`,
			label: reasonLabel(r.rejectReason),
			scope: r.sportTag,
			verdict: r.verdict,
			reason: r.verdictReason,
			n: r.cleanTotal,
			wins: r.cleanWins,
			losses: r.cleanLosses,
			roiPct: r.cleanRoiPct,
			z: r.cleanZ,
			pinClvPct: r.cleanAvgPinClvPct,
			pinN: r.cleanPinN,
		})),
	];
	return rows.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.n - a.n);
}

/** Short label for a market inside its event: ML, Spread −4.5, O/U 44.5, TT O/U 17.5, 1H O/U 22.5. */
function lineLabel(question: string | null, marketType: string | null): string {
	const q = question ?? "";
	const num = q.match(/O\/U\s*([\d.]+)/)?.[1];
	if (marketType === "spread") {
		const m = q.match(/\(([-+][\d.]+)\)/);
		return `Spread ${m ? m[1].replace("-", "−") : ""}`.trim();
	}
	if (marketType === "team_total") return `TT O/U ${num ?? ""}`.trim();
	if (marketType === "period")
		return `${q.includes("1H") || q.includes("1st Half") ? "1H" : "Per"} O/U ${num ?? ""}`.trim();
	if (marketType === "total") return `O/U ${num ?? ""}`.trim();
	if (marketType === "moneyline") return "ML";
	return q.split(":")[0].slice(0, 18);
}

interface SharpEvent {
	key: string;
	title: string;
	sport: string | null;
	start: number;
	rows: Dashboard["sharpAlerts"];
}

function groupSharpEvents(alerts: Dashboard["sharpAlerts"]): SharpEvent[] {
	const byKey = new Map<string, SharpEvent>();
	for (const a of alerts) {
		const key = a.eventKey ?? a.conditionId;
		let ev = byKey.get(key);
		if (!ev) {
			ev = { key, title: "", sport: a.sport, start: a.start, rows: [] };
			byKey.set(key, ev);
		}
		ev.rows.push(a);
		// Prefer the moneyline's "A vs. B" as the event title; else the first question's matchup segment.
		const q = a.question ?? "";
		const seg = q.split(":").find((p) => / vs\.? /.test(p)) ?? q;
		if (a.marketType === "moneyline" || !ev.title) ev.title = seg.trim();
	}
	return [...byKey.values()]
		.map((ev) => ({
			...ev,
			rows: [...ev.rows].sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0)),
		}))
		.sort((x, y) => x.start - y.start);
}

function TerminalPage() {
	const [data, setData] = useState<Dashboard | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			setData(await getDashboardFn());
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load");
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const chartRange = useMemo(() => presetRange("30d", null), []);
	const alive = data ? aliveItems(data.health) : [];
	const alarms = alive.filter((a) => a.alarm);

	const live = data?.liveBook ?? null;
	const currentEra = data?.eras[0] ?? null;

	return (
		<Shell
			wide
			actions={
				<>
					{data ? (
						<span className="hidden font-mono text-xxs tabular-nums text-ink-40 sm:inline">
							as of {ago(data.computedAt)}
						</span>
					) : null}
					<ShellButton onClick={() => void load()} disabled={isLoading}>
						{isLoading ? "…" : "Refresh"}
					</ShellButton>
				</>
			}
		>
			{error ? (
				<p className="border-b border-signal-bad/40 bg-signal-bad/10 px-3 py-2 text-sm text-signal-bad">
					{error}
				</p>
			) : null}

			{/* ALIVE strip — the first three seconds. */}
			<div className="flex flex-wrap items-stretch divide-x divide-ink-15 bg-ink-05">
				{alive.map((item) => (
					<div
						key={item.key}
						className="flex min-w-0 flex-1 basis-[9.5rem] items-center gap-2 px-3 py-1.5"
					>
						<Dot tone={item.tone} />
						<div className="min-w-0">
							<p className="font-mono text-xxs uppercase tracking-[0.15em] text-ink-40">
								{item.label}
							</p>
							<p
								className={`truncate font-mono text-xs tabular-nums ${
									item.tone === "bad"
										? "text-signal-bad"
										: item.tone === "warn"
											? "text-signal-warn"
											: "text-ink-85"
								}`}
							>
								{item.value}
							</p>
						</div>
					</div>
				))}
				{!data && !error ? (
					<p className="px-3 py-2 text-sm text-ink-55">
						{isLoading ? "Loading…" : ""}
					</p>
				) : null}
			</div>
			{alarms.length > 0 ? (
				<p className="border-t border-ink-15 bg-signal-bad/10 px-3 py-1.5 font-mono text-xs text-signal-bad">
					<span className="font-semibold uppercase tracking-[0.15em]">
						Attention
					</span>{" "}
					{alarms.map((a) => a.alarm).join(" · ")}
				</p>
			) : null}

			<Workspace>
				{/* BOOK */}
				<Panel
					title="Book"
					span={5}
					meta={
						data?.health.bankroll !== null &&
						data?.health.bankroll !== undefined
							? `bankroll ${dollars(data.health.bankroll)}`
							: "real fills"
					}
				>
					{data ? (
						<>
							<table className="w-full text-sm">
								<thead>
									<tr className="h-6 border-b border-ink-10 font-mono text-xxs uppercase tracking-[0.12em] text-ink-40">
										<th className="px-3 text-left font-medium">Window</th>
										<th className="px-3 text-right font-medium">W-L</th>
										<th className="px-3 text-right font-medium">Units</th>
										<th className="px-3 text-right font-medium">ROI</th>
										<th className="px-3 text-right font-medium">Pin CLV</th>
									</tr>
								</thead>
								<tbody>
									{data.windows.map((w) => {
										const settled = w.wins + w.losses;
										return (
											<Row key={w.label}>
												<Cell mono className="text-ink-70">
													{w.label}
													{w.placed > 0 ? (
														<span className="ml-1.5 text-ink-40">
															{w.placed} placed
														</span>
													) : null}
												</Cell>
												<Cell right className="text-ink-95">
													{settled > 0
														? `${w.wins}-${w.losses}${w.pushes ? ` (${w.pushes}p)` : ""}`
														: "—"}
												</Cell>
												<Cell right>
													<Num value={w.units} text={units(w.units)} />
												</Cell>
												<Cell right>
													<Num value={w.roiPct} text={pct(w.roiPct)} />
												</Cell>
												<Cell
													right
													title={`${w.pinClvN}/${settled} settled carry Pinnacle CLV`}
												>
													<Num
														value={w.avgPinClvPct}
														text={w.pinClvN > 0 ? pct(w.avgPinClvPct, 2) : "—"}
														dim={w.pinClvN < 10}
													/>
													{w.pinClvN > 0 ? (
														<span className="ml-1 text-xxs text-ink-40">
															{w.pinClvN}
														</span>
													) : null}
												</Cell>
											</Row>
										);
									})}
								</tbody>
							</table>
							{live ? (
								<div className="border-t border-ink-15 px-3 py-2">
									<p className="font-mono text-xxs uppercase tracking-[0.15em] text-ink-40">
										Out of sample since{" "}
										{new Date(live.since * 1000).toLocaleDateString(undefined, {
											month: "short",
											day: "numeric",
											timeZone: "UTC",
										})}
									</p>
									<div className="mt-1.5 grid grid-cols-3 gap-x-3">
										{(
											[
												["All", live.all],
												["Totals", live.totals],
												["ML", live.moneyline],
											] as const
										).map(([label, c]) => {
											const roi =
												c.settled > 0 && c.units !== null
													? (c.units / c.settled) * 100
													: null;
											const z = roiZScore(c.settled, c.units, c.sumSq);
											return (
												<Stat
													key={label}
													label={label}
													value={
														<span className={toneClass(roi)}>{pct(roi)}</span>
													}
													sub={`${c.wins}-${c.losses} · z ${
														z === null ? "—" : z.toFixed(1)
													}`}
												/>
											);
										})}
									</div>
								</div>
							) : null}
							{currentEra ? (
								<div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-4 border-t border-ink-15 px-3 py-2 font-mono text-xs">
									<span className="text-xxs uppercase tracking-[0.15em] text-ink-40">
										CLV vs · current era
									</span>
									<span className="text-right text-xxs uppercase tracking-[0.15em] text-ink-40">
										avg
									</span>
									<span className="text-right text-xxs uppercase tracking-[0.15em] text-ink-40">
										n
									</span>
									{(
										[
											["Polymarket", currentEra.avgClvPct, currentEra.clvN],
											[
												"DraftKings",
												currentEra.avgBookClvPct,
												currentEra.bookClvN,
											],
											["Pinnacle", currentEra.avgPinClvPct, currentEra.pinClvN],
										] as const
									).map(([name, v, n]) => (
										<Fragment key={name}>
											<span className="text-ink-70">{name}</span>
											<Num
												value={v}
												text={n > 0 ? pct(v, 2) : "—"}
												dim={n < 10}
											/>
											<span className="text-right tabular-nums text-ink-40">
												{n}/{currentEra.wins + currentEra.losses}
											</span>
										</Fragment>
									))}
								</div>
							) : null}
						</>
					) : (
						<Empty>{isLoading ? "Loading…" : "No data."}</Empty>
					)}
				</Panel>

				{/* Sharp tape: ranked-wallet fills on upcoming markets (VPS polysharp → D1) */}
				<Panel
					title="Sharp tape · upcoming"
					span={7}
					meta={
						data?.sharp.all
							? `${data.sharp.sharpWallets ?? "—"} sharp wallets · ${data.sharp.all.n} signals · ROI ${pct(
									(data.sharp.all.roi ?? 0) * 100,
								)} · CLV ${
									data.sharp.all.clv != null
										? `${(data.sharp.all.clv * 100).toFixed(2)}c`
										: "—"
								}`
							: "no polysharp report yet"
					}
				>
					{data && data.sharpAlerts.length > 0 ? (
						<Tape
							minWidth="min-w-[560px]"
							head={[
								{ label: "Seen" },
								{ label: "Line" },
								{ label: "Side" },
								{ label: "Px", align: "right" },
								{ label: "$", align: "right" },
								{ label: "Wallet", align: "right" },
								{ label: "Form", align: "right" },
								{ label: "Sq opp", align: "right" },
								{ label: "Type" },
							]}
						>
							{groupSharpEvents(data.sharpAlerts).map((ev) => (
								<Fragment key={ev.key}>
									<Row>
										<Cell className="whitespace-nowrap text-xs text-ink-40">
											{clock(ev.start)}
										</Cell>
										<Cell className="text-xs font-semibold text-ink-85">
											{ev.sport ? (
												<span className="mr-1 font-mono text-xxs uppercase tracking-[0.12em] text-ink-55">
													{ev.sport}
												</span>
											) : null}
											{ev.title}
										</Cell>
										<Cell className="text-xxs text-ink-40" colSpan={7}>
											{ev.rows.length} position{ev.rows.length === 1 ? "" : "s"}{" "}
											· {new Set(ev.rows.map((r) => r.conditionId)).size} market
											{new Set(ev.rows.map((r) => r.conditionId)).size === 1
												? ""
												: "s"}
											{ev.rows.some((r) => r.hedge) ? " · hedge present" : ""}
										</Cell>
									</Row>
									{ev.rows.map((a) => (
										<Row
											key={`${a.conditionId}:${a.side}:${a.ts}`}
											className={a.hedge ? "opacity-60" : ""}
										>
											<Cell className="whitespace-nowrap text-xs text-ink-55">
												{ago(a.ts)}
											</Cell>
											<Cell
												className="pl-4 font-mono text-xs text-ink-70"
												title={a.question ?? ""}
											>
												{lineLabel(a.question, a.marketType)}
											</Cell>
											<Cell className="max-w-[9rem] truncate text-xs text-ink-85">
												{a.sideLabel ?? (a.side === 0 ? "A" : "B")}
												{a.hedge ? (
													<span className="ml-1 font-mono text-xxs uppercase text-signal-warn">
														hedge
													</span>
												) : null}
											</Cell>
											<Cell right className="font-mono text-xs">
												{a.price != null
													? `${Math.round(a.price * 100)}¢`
													: "—"}
											</Cell>
											<Cell right className="font-mono text-xs">
												{a.usd != null
													? `$${Math.round(a.usd).toLocaleString()}`
													: "—"}
												{a.fills != null && a.fills > 1 ? (
													<span className="ml-1 text-ink-40">×{a.fills}</span>
												) : null}
											</Cell>
											<Cell
												right
												className="font-mono text-xs"
												title="wallet ROI t-stat · settled markets · ROI"
											>
												{a.walletRoiT != null
													? `t${a.walletRoiT.toFixed(1)}`
													: "—"}
												{a.walletMarkets != null ? (
													<span className="ml-1 text-ink-40">
														{a.walletMarkets}m
														{a.walletRoi != null
															? ` ${a.walletRoi >= 0 ? "+" : ""}${Math.round(a.walletRoi * 100)}%`
															: ""}
													</span>
												) : null}
											</Cell>
											<Cell
												right
												className={`font-mono text-xs ${
													a.streak != null && a.streak > 0.1
														? "text-ink-95"
														: a.streak != null && a.streak < -0.1
															? "text-ink-40"
															: ""
												}`}
												title="trailing-20 settled ROI"
											>
												{a.streak != null
													? `${a.streak >= 0 ? "+" : ""}${Math.round(a.streak * 100)}%`
													: "—"}
											</Cell>
											<Cell
												right
												className="font-mono text-xs"
												title="square $ already on the opposite side"
											>
												{a.sqOppUsd != null && Math.abs(a.sqOppUsd) >= 100
													? `${a.sqOppUsd > 0 ? "+" : "−"}$${(Math.abs(a.sqOppUsd) / 1000).toFixed(1)}k`
													: "—"}
											</Cell>
											<Cell className="text-xs text-ink-40">
												{a.marketType ?? ""}
											</Cell>
										</Row>
									))}
								</Fragment>
							))}
						</Tape>
					) : (
						<Empty>
							{isLoading && !data
								? "Loading…"
								: "No sharp fills on upcoming markets."}
						</Empty>
					)}
				</Panel>

				{/* POSITIONS — open, filled bets (the full operator view stays on /book) */}
				<Panel
					title={
						<a href="/book" className="hover:text-ink-85">
							Positions ↗
						</a>
					}
					span={12}
					meta={data ? `${data.activeBets.length} open` : undefined}
				>
					{data && data.activeBets.length > 0 ? (
						<Tape
							head={[
								{ label: "Market" },
								{ label: "Side" },
								{ label: "Px", align: "right" },
								{ label: "Grd", align: "right" },
								{ label: "Mkt" },
								{ label: "Fill" },
								{ label: "Starts", align: "right" },
							]}
						>
							{data.activeBets.map((p) => (
								<Row key={p.id}>
									<Cell className="max-w-[18rem]">
										<a
											href={`/sharp/market/${p.conditionId}`}
											className="block truncate text-ink-95 hover:text-brand-blue"
										>
											{p.marketTitle}
										</a>
									</Cell>
									<Cell>
										<Side pick={p} />
									</Cell>
									<Cell right>
										{p.price !== null ? p.price.toFixed(2) : "—"}
									</Cell>
									<Cell right>{p.grade ?? "—"}</Cell>
									<Cell>
										<Tag>{p.sportTag ?? "—"}</Tag>
									</Cell>
									<Cell className="text-ink-55">{p.fillStatus ?? "—"}</Cell>
									<Cell right className="text-ink-55">
										{clock(p.eventTime)}
									</Cell>
								</Row>
							))}
						</Tape>
					) : (
						<Empty>
							{isLoading && !data ? "Loading…" : "Flat. No open positions."}
						</Empty>
					)}
				</Panel>

				{/* P&L */}
				<Panel
					title={
						<a href="/stats" className="hover:text-ink-85">
							P&amp;L · 30d ↗
						</a>
					}
					span={12}
					meta="flat-stake units · real vs shadow"
				>
					<PlChartSection range={chartRange} compact />
				</Panel>
			</Workspace>
		</Shell>
	);
}
