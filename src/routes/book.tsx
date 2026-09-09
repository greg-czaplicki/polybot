/**
 * Book detail — the operator panels that used to crowd the home terminal:
 * positions, recent settlements, the stake ladder, shadow verdicts and the
 * 24h tape. Home keeps only health, live P&L and the sharp tape.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ago, clock, dollars, pct, units } from "@/components/terminal/format";
import {
	Cell,
	Dot,
	Empty,
	Num,
	Panel,
	Row,
	Tag,
	Tape,
	type Tone,
	VerdictWord,
	Workspace,
} from "@/components/terminal/panel";
import { Shell, ShellButton } from "@/components/terminal/shell";
import { reasonLabel } from "@/lib/shadow-labels";
import { formatSideLabel } from "@/lib/side-label";
import {
	type DashboardHealth,
	type DashboardPickRow,
	getDashboardFn,
} from "../server/api/dashboard";
import {
	getShadowBookSummaryFn,
	type ShadowReasonSummary,
	type ShadowSportSummary,
} from "../server/api/shadow-book-api";

export const Route = createFileRoute("/book")({
	component: BookDetailPage,
});

type Dashboard = Awaited<ReturnType<typeof getDashboardFn>>;
type ShadowSummary = Awaited<ReturnType<typeof getShadowBookSummaryFn>>;

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
function _aliveItems(h: DashboardHealth): AliveItem[] {
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

function resultWord(status: string): string {
	return status === "win" ? "W" : status === "loss" ? "L" : "P";
}

function resultClass(status: string): string {
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

function verdictRows(
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

function BookDetailPage() {
	const [data, setData] = useState<Dashboard | null>(null);
	const [shadow, setShadow] = useState<ShadowSummary | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const [d, s] = await Promise.all([
				getDashboardFn(),
				getShadowBookSummaryFn().catch(() => null),
			]);
			setData(d);
			setShadow(s);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load");
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const verdicts = useMemo(
		() => (shadow ? verdictRows(shadow.reasons, shadow.bySport) : []),
		[shadow],
	);
	const readyN = verdicts.filter((v) => v.verdict === "ready").length;
	const watchN = verdicts.filter((v) => v.verdict === "watch").length;
	const shownVerdicts = verdicts
		.filter((v) => v.verdict !== "hold" || v.n >= 20)
		.slice(0, 9);

	const live = data?.liveBook ?? null;
	const _currentEra = data?.eras[0] ?? null;

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

			<Workspace>
				{/* POSITIONS */}
				<Panel
					title="Positions"
					span={8}
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

				{/* SETTLED */}
				<Panel
					title="Settled · 48h"
					span={7}
					meta={
						data?.recap
							? `${data.recap.wins}-${data.recap.losses} · ${units(data.recap.units)} last 24h`
							: undefined
					}
				>
					{data && data.recentSettled.length > 0 ? (
						<Tape
							head={[
								{ label: "Market" },
								{ label: "Side" },
								{ label: "Px", align: "right" },
								{ label: "R", align: "right" },
								{ label: "Units", align: "right" },
								{ label: "CLV", align: "right" },
								{ label: "Settled", align: "right" },
							]}
						>
							{data.recentSettled.map((p) => (
								<Row key={p.id}>
									<Cell className="max-w-[16rem]">
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
									<Cell
										right
										className={`font-semibold ${resultClass(p.status)}`}
									>
										{resultWord(p.status)}
									</Cell>
									<Cell right>
										<Num value={p.roi} text={units(p.roi)} />
									</Cell>
									<Cell right>
										<Num
											value={p.clv}
											text={p.clv !== null ? pct(p.clv * 100) : "—"}
										/>
									</Cell>
									<Cell right className="text-ink-55">
										{clock(p.settledAt)}
									</Cell>
								</Row>
							))}
						</Tape>
					) : (
						<Empty>
							{isLoading && !data ? "Loading…" : "Nothing settled in 48h."}
						</Empty>
					)}
				</Panel>

				{/* STAKE LADDER */}
				<Panel
					title="Stake ladder"
					span={5}
					meta="pre-registered 2026-08-27"
					tone={
						live?.triggers.some((t) => t.met && t.key === "stop")
							? "bad"
							: undefined
					}
				>
					{live ? (
						<ul>
							{live.triggers.map((t) => (
								<li
									key={t.key}
									title={`When met: ${t.action}`}
									className="flex items-start gap-2 border-b border-ink-10 px-3 py-1.5 last:border-b-0"
								>
									<span className="mt-1.5">
										<Dot
											tone={t.met ? (t.key === "stop" ? "bad" : "ok") : "off"}
										/>
									</span>
									<div className="min-w-0 flex-1">
										<p className="flex items-baseline justify-between gap-2 text-sm text-ink-85">
											<span className="truncate">{t.label}</span>
											<span
												className={`shrink-0 font-mono text-xxs uppercase tracking-[0.15em] ${
													t.met ? "text-signal-pos" : "text-ink-40"
												}`}
											>
												{t.met ? "met" : "—"}
											</span>
										</p>
										<p className="truncate font-mono text-xxs tabular-nums text-ink-55">
											{t.detail}
										</p>
									</div>
								</li>
							))}
						</ul>
					) : (
						<Empty>{isLoading ? "Loading…" : "No ladder data."}</Empty>
					)}
				</Panel>

				{/* VERDICTS */}
				<Panel
					title={
						<a href="/shadow" className="hover:text-ink-85">
							Verdicts ↗
						</a>
					}
					span={7}
					tone={readyN > 0 ? "pos" : undefined}
					meta={
						shadow
							? readyN > 0
								? `${readyN} ready · ${watchN} watch`
								: watchN > 0
									? `all hold · ${watchN} watch`
									: "all hold"
							: undefined
					}
				>
					{shadow ? (
						shownVerdicts.length > 0 ? (
							<Tape
								head={[
									{ label: "Gate" },
									{ label: "Mkt" },
									{ label: "Verdict" },
									{ label: "n", align: "right" },
									{ label: "W-L", align: "right" },
									{ label: "ROI", align: "right" },
									{ label: "z", align: "right" },
									{ label: "Pin CLV", align: "right" },
								]}
							>
								{shownVerdicts.map((v) => (
									<Row key={v.key} title={v.reason}>
										<Cell className="max-w-[14rem] truncate text-ink-85">
											{v.label}
										</Cell>
										<Cell>
											<Tag>{v.scope}</Tag>
										</Cell>
										<Cell>
											<VerdictWord verdict={v.verdict} title={v.reason} />
										</Cell>
										<Cell right>{v.n}</Cell>
										<Cell right className="text-ink-70">
											{v.wins}-{v.losses}
										</Cell>
										<Cell right>
											<Num
												value={v.roiPct}
												text={pct(v.roiPct)}
												dim={v.n < 20}
											/>
										</Cell>
										<Cell right>
											<Num
												value={v.z}
												text={v.z === null ? "—" : v.z.toFixed(1)}
												dim={v.n < 20}
											/>
										</Cell>
										<Cell right>
											<Num
												value={v.pinClvPct}
												text={v.pinN > 0 ? pct(v.pinClvPct, 2) : "—"}
												dim={v.pinN < 10}
											/>
										</Cell>
									</Row>
								))}
							</Tape>
						) : (
							<Empty>No gate has 20 settled sole-blocker rows yet.</Empty>
						)
					) : (
						<Empty>{isLoading ? "Loading…" : "Verdicts unavailable."}</Empty>
					)}
				</Panel>

				{/* TAPE BY MARKET */}
				<Panel title="Tape · 24h" span={5} meta="by market">
					{data && data.tape.length > 0 ? (
						<Tape
							minWidth="min-w-[420px]"
							head={[
								{ label: "Mkt" },
								{ label: "Live", align: "right" },
								{ label: "Shadow", align: "right" },
								{ label: "Pin", align: "right" },
								{ label: "Ahead", align: "right" },
								{ label: "Top gate" },
							]}
						>
							{data.tape.map((t) => (
								<Row key={t.sportTag}>
									<Cell className="font-mono text-xs uppercase tracking-[0.12em] text-ink-85">
										{t.sportTag}
									</Cell>
									<Cell
										right
										className={t.livePicks > 0 ? "text-ink-95" : "text-ink-40"}
									>
										{t.livePicks}
									</Cell>
									<Cell right>{t.shadowRows}</Cell>
									<Cell
										right
										title="shadow rows with a Pinnacle anchor"
										className={
											t.shadowRows > 0 && t.shadowAnchored === 0
												? "text-ink-40"
												: ""
										}
									>
										{t.shadowAnchored}
									</Cell>
									<Cell right className="text-ink-70">
										{t.upcoming}
									</Cell>
									<Cell className="max-w-[11rem] truncate text-xs text-ink-55">
										{t.topReject ? reasonLabel(t.topReject) : "—"}
										{t.topRejectN > 0 ? (
											<span className="ml-1 font-mono text-xxs text-ink-40">
												{t.topRejectN}
											</span>
										) : null}
									</Cell>
								</Row>
							))}
						</Tape>
					) : (
						<Empty>{isLoading && !data ? "Loading…" : "Quiet tape."}</Empty>
					)}
				</Panel>
			</Workspace>
		</Shell>
	);
}
