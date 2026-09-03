import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { ago, dateStamp, pct, units } from "@/components/terminal/format";
import {
	Cell,
	Empty,
	Num,
	Panel,
	Row,
	Tag,
	Tape,
	VerdictWord,
	Workspace,
} from "@/components/terminal/panel";
import { Shell, ShellButton } from "@/components/terminal/shell";
import {
	type GateVerdict,
	PIN_CLV_MIN_N,
	PROMOTION_MIN_N,
	PROMOTION_MIN_Z,
} from "@/lib/gate-verdict";
import { PROP_SUBTYPE_LABELS, reasonLabel } from "@/lib/shadow-labels";
import { formatSideLabel } from "@/lib/side-label";
import { PAPER_LANE_REASONS } from "@/server/api/shadow-sql";
import {
	getShadowBookSummaryFn,
	type ShadowReasonSummary,
	type ShadowSportSummary,
} from "../server/api/shadow-book-api";

export const Route = createFileRoute("/shadow")({
	component: VerdictBoardPage,
});

type Summary = Awaited<ReturnType<typeof getShadowBookSummaryFn>>;

/** Below this many settled rows the ROI colour no longer vouches for the number. */
const MIN_N_FOR_COLOR = 20;

const RANK: Record<GateVerdict, number> = { ready: 0, watch: 1, hold: 2 };
const PAPER = new Set<string>(PAPER_LANE_REASONS);

function isPaper(reason: string): boolean {
	return PAPER.has(reason);
}

function z(value: number | null): string {
	return value === null || !Number.isFinite(value) ? "—" : value.toFixed(1);
}

function VerdictHead() {
	return (
		<tr className="h-6 border-b border-ink-10 font-mono text-xxs uppercase tracking-[0.12em] text-ink-40">
			<th className="px-3 text-left font-medium">Gate</th>
			<th className="px-3 text-left font-medium">Mkt</th>
			<th className="px-3 text-left font-medium">Verdict</th>
			<th
				className="px-3 text-right font-medium"
				title="sole-blocker settled rows"
			>
				n
			</th>
			<th className="px-3 text-right font-medium">W-L</th>
			<th className="px-3 text-right font-medium">ROI</th>
			<th className="px-3 text-right font-medium" title="event-clustered z">
				z
			</th>
			<th className="px-3 text-right font-medium">Pin CLV</th>
			<th
				className="px-3 text-right font-medium"
				title="close − anchor, offset-free"
			>
				Pin move
			</th>
			<th className="px-3 text-left font-medium">Next</th>
		</tr>
	);
}

/**
 * One row of the board. `scope` is "all" for the gate across sports or a
 * sport tag. Every number is the sole-blocker (clean) cohort — the only
 * cut the promotion rule reads.
 */
function VerdictRow({
	r,
	scope,
	indent = false,
	onClick,
	expanded,
}: {
	r: ShadowReasonSummary | ShadowSportSummary;
	scope: string;
	indent?: boolean;
	onClick?: () => void;
	expanded?: boolean;
}) {
	const n = r.cleanTotal;
	const title =
		r.verdict === "ready"
			? `All criteria met (n≥${PROMOTION_MIN_N}, z≥${PROMOTION_MIN_Z}, ${r.verdictClvSource} CLV>0)`
			: `Unmet: ${r.verdictReason} · CLV source ${r.verdictClvSource}`;
	return (
		<Row onClick={onClick} className={indent ? "bg-ink-05/60" : ""}>
			<Cell
				className={`max-w-[15rem] truncate ${indent ? "pl-6 text-ink-70" : "text-ink-95"}`}
			>
				{indent ? (
					""
				) : onClick ? (
					<span className="mr-1.5 inline-block w-2 text-ink-40">
						{expanded ? "−" : "+"}
					</span>
				) : null}
				{indent ? "" : reasonLabel(r.rejectReason)}
			</Cell>
			<Cell>
				<Tag>{scope}</Tag>
			</Cell>
			<Cell>
				<VerdictWord verdict={r.verdict} title={title} />
			</Cell>
			<Cell
				right
				className={n >= PROMOTION_MIN_N ? "text-ink-95" : "text-ink-70"}
			>
				{n}
				<span className="text-ink-40">/{PROMOTION_MIN_N}</span>
			</Cell>
			<Cell right className="text-ink-70">
				{r.cleanWins}-{r.cleanLosses}
			</Cell>
			<Cell right>
				<Num
					value={r.cleanRoiPct}
					text={pct(r.cleanRoiPct)}
					dim={n < MIN_N_FOR_COLOR}
				/>
			</Cell>
			<Cell
				right
				title={`clustered over ${r.cleanClusters} events · per-row z ${z(r.cleanRowZ)}`}
			>
				<Num value={r.cleanZ} text={z(r.cleanZ)} dim={n < MIN_N_FOR_COLOR} />
			</Cell>
			<Cell right title={`${r.cleanPinN} rows carry Pinnacle CLV`}>
				<Num
					value={r.cleanAvgPinClvPct}
					text={r.cleanPinN > 0 ? pct(r.cleanAvgPinClvPct, 2) : "—"}
					dim={r.cleanPinN < PIN_CLV_MIN_N}
				/>
				{r.cleanPinN > 0 ? (
					<span className="ml-1 text-xxs text-ink-40">{r.cleanPinN}</span>
				) : null}
			</Cell>
			<Cell right title={`${r.cleanPinMoveN} rows with anchor + close`}>
				<Num
					value={r.cleanAvgPinMovePct}
					text={r.cleanPinMoveN > 0 ? pct(r.cleanAvgPinMovePct, 2) : "—"}
					dim={r.cleanPinMoveN < PIN_CLV_MIN_N}
				/>
			</Cell>
			<Cell className="max-w-[16rem] truncate font-mono text-xs text-ink-55">
				{r.verdict === "ready" ? "review for promotion" : r.verdictReason}
			</Cell>
		</Row>
	);
}

function VerdictBoardPage() {
	const [data, setData] = useState<Summary | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState<Set<string>>(new Set());

	const load = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			setData(await getShadowBookSummaryFn());
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load");
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const toggle = (key: string) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	const gates = useMemo(
		() =>
			(data?.reasons ?? [])
				.filter((r) => !isPaper(r.rejectReason))
				.sort(
					(a, b) =>
						RANK[a.verdict] - RANK[b.verdict] || b.cleanTotal - a.cleanTotal,
				),
		[data],
	);
	const activeGates = useMemo(
		() => gates.filter((g) => g.cleanTotal > 0),
		[gates],
	);
	const dormantGates = useMemo(
		() => gates.filter((g) => g.cleanTotal === 0),
		[gates],
	);
	const lanes = useMemo(
		() => (data?.reasons ?? []).filter((r) => isPaper(r.rejectReason)),
		[data],
	);
	const sportsFor = useCallback(
		(reason: string) =>
			(data?.bySport ?? [])
				.filter((s) => s.rejectReason === reason)
				.sort(
					(a, b) =>
						RANK[a.verdict] - RANK[b.verdict] || b.cleanTotal - a.cleanTotal,
				),
		[data],
	);

	const all = [...(data?.reasons ?? []), ...(data?.bySport ?? [])];
	const ready = all.filter((r) => r.verdict === "ready");
	const watch = all.filter((r) => r.verdict === "watch");
	const settledTotal = (data?.reasons ?? []).reduce(
		(s, r) => s + r.wins + r.losses,
		0,
	);
	const pendingTotal = (data?.reasons ?? []).reduce((s, r) => s + r.pending, 0);
	const readyLabel = (r: ShadowReasonSummary | ShadowSportSummary) =>
		`${reasonLabel(r.rejectReason)}${"sportTag" in r ? ` · ${r.sportTag.toUpperCase()}` : ""}`;

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

			{/* DECISION — the one line this screen exists for. */}
			<div
				className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2 ${
					ready.length > 0 ? "bg-signal-pos/10" : "bg-ink-05"
				}`}
			>
				<span className="font-mono text-xxs font-semibold uppercase tracking-[0.18em] text-ink-40">
					Decision
				</span>
				<span
					className={`text-sm font-semibold ${
						ready.length > 0 ? "text-signal-pos" : "text-ink-95"
					}`}
				>
					{!data
						? isLoading
							? "Loading…"
							: "—"
						: ready.length > 0
							? `${ready.length} cohort${ready.length === 1 ? "" : "s"} ready for promotion review: ${ready
									.map(readyLabel)
									.join(", ")}`
							: "Nothing to do. Every cohort is HOLD."}
				</span>
				{data && watch.length > 0 ? (
					<span className="font-mono text-xs text-ink-55">
						watching{" "}
						{watch
							.map((r) => `${readyLabel(r)} (${r.verdictReason})`)
							.join(" · ")}
					</span>
				) : null}
				<span className="ml-auto font-mono text-xxs tabular-nums text-ink-40">
					{data ? `${settledTotal} settled · ${pendingTotal} pending` : ""}
				</span>
			</div>
			<p className="border-t border-ink-15 px-3 py-1 font-mono text-xxs text-ink-40">
				Rule: sole-blocker cohort n≥{PROMOTION_MIN_N} · clustered z≥
				{PROMOTION_MIN_Z} · Pinnacle CLV&gt;0 once ≥{PIN_CLV_MIN_N} rows carry
				it. Colour is withheld below n={MIN_N_FOR_COLOR}. Raw first-fired cuts
				are not shown here; they never decide anything.
			</p>

			<Workspace>
				{/* GATES */}
				<Panel
					title="Gates"
					span={12}
					meta={
						data
							? `${gates.length} gates · click a row for per-market cohorts`
							: undefined
					}
					tone={gates.some((g) => g.verdict === "ready") ? "pos" : undefined}
				>
					{data ? (
						<div className="overflow-x-auto">
							<table className="w-full min-w-[880px] text-sm text-ink-85">
								<thead>
									<VerdictHead />
								</thead>
								<tbody>
									{activeGates.map((g) => {
										const sports = sportsFor(g.rejectReason);
										const expanded = open.has(g.rejectReason);
										return (
											<Fragment key={g.rejectReason}>
												<VerdictRow
													r={g}
													scope="all"
													onClick={
														sports.length > 0
															? () => toggle(g.rejectReason)
															: undefined
													}
													expanded={expanded}
												/>
												{expanded
													? sports.map((s) => (
															<VerdictRow
																key={`${s.rejectReason}:${s.sportTag}`}
																r={s}
																scope={s.sportTag}
																indent
															/>
														))
													: null}
											</Fragment>
										);
									})}
									{activeGates.length === 0 ? (
										<tr>
											<td colSpan={10}>
												<Empty>No gate rows yet.</Empty>
											</td>
										</tr>
									) : null}
									{dormantGates.length > 0 ? (
										<tr>
											<td
												colSpan={10}
												className="px-3 py-1.5 font-mono text-xxs text-ink-40"
											>
												dormant (no settled sole-blocker rows):{" "}
												{dormantGates
													.map(
														(g) =>
															`${reasonLabel(g.rejectReason)}${g.pending > 0 ? ` (${g.pending} pending)` : ""}`,
													)
													.join(" · ")}
											</td>
										</tr>
									) : null}
								</tbody>
							</table>
						</div>
					) : (
						<Empty>{isLoading ? "Loading…" : "No data."}</Empty>
					)}
				</Panel>

				{/* PAPER LANES — their own cohort, not gate rejects. */}
				<Panel
					title="Paper lanes"
					span={7}
					meta="rule-only cohorts · same promotion rule"
					tone={lanes.some((l) => l.verdict === "ready") ? "pos" : undefined}
				>
					{data ? (
						lanes.length > 0 ? (
							<div className="overflow-x-auto">
								<table className="w-full min-w-[720px] text-sm text-ink-85">
									<thead>
										<VerdictHead />
									</thead>
									<tbody>
										{lanes.map((l) => (
											<Fragment key={l.rejectReason}>
												<VerdictRow r={l} scope="all" />
												{sportsFor(l.rejectReason).map((s) => (
													<VerdictRow
														key={`${s.rejectReason}:${s.sportTag}`}
														r={s}
														scope={s.sportTag}
														indent
													/>
												))}
											</Fragment>
										))}
									</tbody>
								</table>
							</div>
						) : (
							<Empty>
								No lane rows yet. The pin-divergence rule fires rarely on liquid
								lines; the heartbeat on the terminal shows it ran.
							</Empty>
						)
					) : (
						<Empty>{isLoading ? "Loading…" : "No data."}</Empty>
					)}
				</Panel>

				{/* PROPS — record-only cohort. */}
				<Panel title="Props" span={5} meta="record-only · clean cut">
					{data && data.props.length > 0 ? (
						<Tape
							minWidth="min-w-[420px]"
							head={[
								{ label: "Subtype" },
								{ label: "n", align: "right" },
								{ label: "Pend", align: "right" },
								{ label: "W-L", align: "right" },
								{ label: "ROI", align: "right" },
								{ label: "CLV", align: "right" },
							]}
						>
							{data.props.map((p) => {
								const n = p.cleanWins + p.cleanLosses;
								return (
									<Row
										key={p.subtype}
										title={`raw: ${p.wins}-${p.losses} · ${pct(p.roiPct)}`}
									>
										<Cell className="text-ink-85">
											{PROP_SUBTYPE_LABELS[p.subtype] ?? p.subtype}
										</Cell>
										<Cell right>{p.cleanTotal}</Cell>
										<Cell right className="text-ink-55">
											{p.pending}
										</Cell>
										<Cell right className="text-ink-70">
											{p.cleanWins}-{p.cleanLosses}
										</Cell>
										<Cell right>
											<Num
												value={p.cleanRoiPct}
												text={pct(p.cleanRoiPct)}
												dim={n < MIN_N_FOR_COLOR}
											/>
										</Cell>
										<Cell right>
											<Num
												value={p.cleanAvgClvPct}
												text={pct(p.cleanAvgClvPct, 2)}
												dim={n < MIN_N_FOR_COLOR}
											/>
										</Cell>
									</Row>
								);
							})}
						</Tape>
					) : (
						<Empty>{isLoading && !data ? "Loading…" : "No prop rows."}</Empty>
					)}
				</Panel>

				{/* TIMING PAIRS — collapsed; diagnostic only. */}
				<Panel
					title="Window drift"
					span={12}
					meta="paired timing view · diagnostic"
				>
					<details>
						<summary className="cursor-pointer px-3 py-1.5 font-mono text-xs text-ink-55 hover:text-ink-85">
							Same market seen on both sides of a window boundary: did the side
							flip, and which way did price drift?{" "}
							{data ? `${data.timingPairs.length} boundaries` : ""}
						</summary>
						{data && data.timingPairs.length > 0 ? (
							<Tape
								head={[
									{ label: "Boundary" },
									{ label: "Pairs", align: "right" },
									{ label: "Side kept", align: "right" },
									{ label: "Flipped", align: "right" },
									{ label: "Avg drift", align: "right" },
									{ label: "Median", align: "right" },
									{ label: "Toward/away", align: "right" },
									{ label: "Paired W-L", align: "right" },
								]}
							>
								{data.timingPairs.map((t) => (
									<Row key={t.bucket}>
										<Cell className="text-ink-85">{t.bucket}</Cell>
										<Cell right>{t.pairs}</Cell>
										<Cell right>{t.sideMatched}</Cell>
										<Cell right>{t.sideFlipped}</Cell>
										<Cell right>
											<Num value={t.avgDriftPct} text={pct(t.avgDriftPct, 2)} />
										</Cell>
										<Cell right>
											<Num
												value={t.medianDriftPct}
												text={pct(t.medianDriftPct, 2)}
											/>
										</Cell>
										<Cell right className="text-ink-70">
											{t.movedTowardSide}/{t.movedAway}
										</Cell>
										<Cell right className="text-ink-70">
											{t.pickWins}-{t.pickLosses}
										</Cell>
									</Row>
								))}
							</Tape>
						) : (
							<Empty>No pairs yet.</Empty>
						)}
					</details>
				</Panel>

				{/* RECENT — collapsed; the raw feed. */}
				<Panel
					title="Recent shadow rows"
					span={12}
					meta={data ? `latest ${data.recent.length}` : undefined}
				>
					<details>
						<summary className="cursor-pointer px-3 py-1.5 font-mono text-xs text-ink-55 hover:text-ink-85">
							Raw feed of the latest rejects — what fired, at what price, and
							how it settled.
						</summary>
						{data && data.recent.length > 0 ? (
							<Tape
								head={[
									{ label: "Market" },
									{ label: "Gate" },
									{ label: "Side" },
									{ label: "Px", align: "right" },
									{ label: "Grd", align: "right" },
									{ label: "Mins", align: "right" },
									{ label: "R", align: "right" },
									{ label: "Units", align: "right" },
									{ label: "Recorded", align: "right" },
								]}
							>
								{data.recent.map((r, i) => (
									<Row key={`${r.marketTitle}-${r.createdAt}-${i}`}>
										<Cell className="max-w-[18rem] truncate text-ink-85">
											{r.marketTitle}
										</Cell>
										<Cell className="max-w-[12rem] truncate text-xs text-ink-55">
											{reasonLabel(r.rejectReason)}
										</Cell>
										<Cell className="max-w-[10rem] truncate">
											{formatSideLabel(
												r.sharpSideLabel,
												r.sharpSide,
												r.marketTitle,
											) ??
												r.sharpSide ??
												"—"}
										</Cell>
										<Cell right>
											{r.price !== null ? r.price.toFixed(2) : "—"}
										</Cell>
										<Cell right>{r.grade ?? "—"}</Cell>
										<Cell right className="text-ink-55">
											{r.minutesToStart ?? "—"}
										</Cell>
										<Cell
											right
											className={`font-semibold ${
												r.status === "win"
													? "text-signal-pos"
													: r.status === "loss"
														? "text-signal-bad"
														: "text-ink-40"
											}`}
										>
											{r.status === "win"
												? "W"
												: r.status === "loss"
													? "L"
													: r.status === "pending"
														? "·"
														: r.status.slice(0, 1).toUpperCase()}
										</Cell>
										<Cell right>
											<Num value={r.roi} text={units(r.roi)} />
										</Cell>
										<Cell right className="text-ink-55">
											{dateStamp(r.createdAt)}
										</Cell>
									</Row>
								))}
							</Tape>
						) : (
							<Empty>No rows.</Empty>
						)}
					</details>
				</Panel>
			</Workspace>
		</Shell>
	);
}
