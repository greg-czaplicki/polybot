import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";

import { MatchupCard } from "@/components/canonical/matchup-card";
import { usePickContext } from "@/components/canonical/pick-context-panel";
import { TeamTrendCard } from "@/components/canonical/team-trend-card";
import {
	PlChartSection,
	type PlRange,
	PlRangeRow,
	presetRange,
	rangeBounds,
} from "@/components/charts/pl-chart-section";
import { ago, clock, pct, units } from "@/components/terminal/format";
import {
	Cell,
	Empty,
	Num,
	Panel,
	Row,
	Tag,
	Tape,
	Workspace,
} from "@/components/terminal/panel";
import { Shell, ShellButton } from "@/components/terminal/shell";
import { formatSideLabel } from "@/lib/side-label";
import {
	clearManualPicksFn,
	listManualPicksFn,
} from "../server/api/manual-picks";
import type { ManualPickEntry } from "../server/repositories/manual-picks";

export const Route = createFileRoute("/stats")({
	component: BookPage,
});

const GRADES = ["A+", "A", "B"] as const;

function resultClass(status: string): string {
	return status === "win"
		? "text-signal-pos"
		: status === "loss"
			? "text-signal-bad"
			: status === "push"
				? "text-ink-55"
				: "text-ink-40";
}

function resultWord(status: string): string {
	return status === "win"
		? "W"
		: status === "loss"
			? "L"
			: status === "push"
				? "P"
				: "·";
}

function BookPage() {
	const [picks, setPicks] = useState<ManualPickEntry[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [isClearing, setIsClearing] = useState(false);
	const [confirmingClear, setConfirmingClear] = useState(false);
	const [range, setRange] = useState<PlRange>(() => presetRange("30d", null));

	useEffect(() => {
		if (!confirmingClear) return;
		const t = setTimeout(() => setConfirmingClear(false), 3000);
		return () => clearTimeout(t);
	}, [confirmingClear]);

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			setIsLoading(true);
			try {
				const result = (await listManualPicksFn({
					data: { limit: 500 },
				})) as { picks?: ManualPickEntry[] };
				if (cancelled) return;
				setPicks(result.picks ?? []);
			} catch (error) {
				console.error("Failed to load picks:", error);
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, []);

	const handleClear = async () => {
		if (isClearing) return;
		if (!confirmingClear) {
			setConfirmingClear(true);
			return;
		}
		setConfirmingClear(false);
		setIsClearing(true);
		try {
			await clearManualPicksFn();
			setPicks([]);
		} catch (error) {
			console.error("Failed to clear picks:", error);
		} finally {
			setIsClearing(false);
		}
	};

	const firstPickSec = useMemo(
		() => (picks.length > 0 ? Math.min(...picks.map((p) => p.pickedAt)) : null),
		[picks],
	);

	// One range scopes everything: strip, chart (settled-time basis), ledger
	// (picked-time basis).
	const filtered = useMemo(() => {
		const bounds = rangeBounds(range);
		if (!bounds) return picks;
		return picks.filter(
			(p) =>
				p.pickedAt >= bounds.startSec && p.pickedAt < bounds.endExclusiveSec,
		);
	}, [picks, range]);

	const strip = useMemo(() => {
		const c = { win: 0, loss: 0, push: 0, pending: 0 };
		let unitsSum = 0;
		let clvSum = 0;
		let clvN = 0;
		for (const p of filtered) {
			c[p.status] = (c[p.status] ?? 0) + 1;
			if ((p.status === "win" || p.status === "loss") && p.roi != null)
				unitsSum += p.roi;
			if ((p.status === "win" || p.status === "loss") && p.clv != null) {
				clvSum += p.clv;
				clvN += 1;
			}
		}
		const settled = c.win + c.loss;
		return {
			...c,
			total: filtered.length,
			settled,
			units: settled > 0 ? unitsSum : null,
			roiPct: settled > 0 ? (unitsSum / settled) * 100 : null,
			winPct: settled > 0 ? (c.win / settled) * 100 : null,
			clvPct: clvN > 0 ? (clvSum / clvN) * 100 : null,
			clvN,
		};
	}, [filtered]);

	const byGrade = useMemo(
		() =>
			GRADES.map((g) => {
				const rows = filtered.filter((p) => p.grade === g);
				const win = rows.filter((p) => p.status === "win").length;
				const loss = rows.filter((p) => p.status === "loss").length;
				const push = rows.filter((p) => p.status === "push").length;
				const pending = rows.filter((p) => p.status === "pending").length;
				const u = rows.reduce(
					(s, p) =>
						s +
						((p.status === "win" || p.status === "loss") && p.roi != null
							? p.roi
							: 0),
					0,
				);
				const settled = win + loss;
				return {
					grade: g,
					n: rows.length,
					win,
					loss,
					push,
					pending,
					units: settled > 0 ? u : null,
					roiPct: settled > 0 ? (u / settled) * 100 : null,
					winPct: settled > 0 ? (win / settled) * 100 : null,
				};
			}),
		[filtered],
	);

	return (
		<Shell
			wide
			actions={
				<ShellButton
					onClick={() => void handleClear()}
					disabled={isClearing}
					title={
						confirmingClear
							? "Tap again to confirm clearing all picks"
							: "Clear all picks (two taps)"
					}
				>
					<span className={confirmingClear ? "text-signal-bad" : undefined}>
						{isClearing
							? "clearing…"
							: confirmingClear
								? "confirm clear"
								: "clear picks"}
					</span>
				</ShellButton>
			}
		>
			{/* Range + strip: one row that scopes every panel below. */}
			<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 bg-ink-05 px-3 py-2">
				<PlRangeRow
					range={range}
					onChange={setRange}
					firstDateSec={firstPickSec}
				/>
				<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-xs tabular-nums">
					<span>
						<span className="text-ink-95">{strip.total}</span>{" "}
						<span className="text-xxs uppercase tracking-wider text-ink-40">
							picks
						</span>
					</span>
					<span>
						<span className="text-signal-pos">{strip.win}</span>
						<span className="text-ink-40">-</span>
						<span className="text-signal-bad">{strip.loss}</span>
						{strip.push > 0 ? (
							<span className="text-ink-55">-{strip.push}p</span>
						) : null}
						{strip.pending > 0 ? (
							<span className="ml-1 text-ink-40">{strip.pending} open</span>
						) : null}
					</span>
					<Num value={strip.units} text={units(strip.units)} />
					<span>
						<Num value={strip.roiPct} text={pct(strip.roiPct)} />{" "}
						<span className="text-xxs uppercase tracking-wider text-ink-40">
							roi
						</span>
					</span>
					<span>
						<span className="text-ink-85">
							{strip.winPct === null ? "—" : `${strip.winPct.toFixed(0)}%`}
						</span>{" "}
						<span className="text-xxs uppercase tracking-wider text-ink-40">
							win
						</span>
					</span>
					<span title={`${strip.clvN} settled picks carry Polymarket CLV`}>
						<Num
							value={strip.clvPct}
							text={pct(strip.clvPct, 2)}
							dim={strip.clvN < 10}
						/>{" "}
						<span className="text-xxs uppercase tracking-wider text-ink-40">
							clv
						</span>
					</span>
				</div>
			</div>

			<Workspace>
				<Panel title="P&L" span={12} meta="cumulative · settled-time basis">
					<PlChartSection range={range} />
				</Panel>

				<Panel
					title="Ledger"
					span={9}
					meta={`${filtered.length} picks · picked-time basis`}
				>
					{isLoading && picks.length === 0 ? (
						<Empty>loading…</Empty>
					) : filtered.length === 0 ? (
						<Empty>No picks in range.</Empty>
					) : (
						<Tape
							minWidth="min-w-[760px]"
							head={[
								{ label: "Market" },
								{ label: "Side" },
								{ label: "Grd", align: "right" },
								{ label: "Sig", align: "right" },
								{ label: "Px", align: "right" },
								{ label: "Fill" },
								{ label: "R", align: "right" },
								{ label: "Units", align: "right" },
								{ label: "CLV", align: "right" },
								{ label: "Picked", align: "right" },
								{ label: "" },
							]}
						>
							{filtered.map((p) => (
								<LedgerRow key={p.id} pick={p} />
							))}
						</Tape>
					)}
				</Panel>

				<Panel title="By grade" span={3} meta="in range">
					<table className="w-full text-sm text-ink-85">
						<thead>
							<tr className="h-6 border-b border-ink-10 font-mono text-xxs uppercase tracking-[0.12em] text-ink-40">
								<th className="px-3 text-left font-medium">Grd</th>
								<th className="px-3 text-right font-medium">W-L</th>
								<th className="px-3 text-right font-medium">ROI</th>
								<th className="px-3 text-right font-medium">Win</th>
							</tr>
						</thead>
						<tbody>
							{byGrade.map((g) => (
								<Row
									key={g.grade}
									title={`${g.n} picks · ${g.pending} open · ${units(g.units)}`}
								>
									<Cell className="font-sans font-semibold text-ink-95">
										{g.grade}
									</Cell>
									<Cell right className="text-ink-70">
										{g.win}-{g.loss}
										{g.push ? (
											<span className="text-ink-40">-{g.push}p</span>
										) : null}
									</Cell>
									<Cell right>
										<Num
											value={g.roiPct}
											text={pct(g.roiPct)}
											dim={g.win + g.loss < 20}
										/>
									</Cell>
									<Cell right className="text-ink-85">
										{g.winPct === null ? "—" : `${g.winPct.toFixed(0)}%`}
									</Cell>
								</Row>
							))}
						</tbody>
					</table>
				</Panel>

				<Panel title="Team context" span={12} meta="canonical analytics">
					<div className="grid gap-px bg-ink-15 lg:grid-cols-2">
						<div className="bg-ink-00 p-3">
							<TeamTrendCard />
						</div>
						<div className="bg-ink-00 p-3">
							<MatchupCard />
						</div>
					</div>
				</Panel>
			</Workspace>
		</Shell>
	);
}

function LedgerRow({ pick }: { pick: ManualPickEntry }) {
	const { button, body } = usePickContext(pick.id);
	const side = formatSideLabel(
		pick.sharpSideLabel,
		pick.sharpSide,
		pick.marketTitle,
	);
	return (
		<Fragment>
			<Row>
				<Cell className="max-w-[18rem]">
					<a
						href={`/sharp/market/${pick.conditionId}`}
						className="block truncate text-ink-95 hover:text-brand-blue"
					>
						{pick.marketTitle}
					</a>
				</Cell>
				<Cell className="max-w-[11rem] truncate">
					{side ?? pick.sharpSide ?? "—"}
					{pick.betType ? (
						<span className="ml-1.5">
							<Tag>{pick.betType === "moneyline" ? "ML" : pick.betType}</Tag>
						</span>
					) : null}
				</Cell>
				<Cell right className="font-sans font-semibold text-ink-85">
					{pick.grade ?? "—"}
				</Cell>
				<Cell right className="text-ink-55">
					{pick.signalScore?.toFixed(0) ?? "—"}
				</Cell>
				<Cell right>{pick.price != null ? pick.price.toFixed(2) : "—"}</Cell>
				<Cell className="text-xs text-ink-55">{pick.fillStatus ?? "—"}</Cell>
				<Cell right className={`font-semibold ${resultClass(pick.status)}`}>
					{resultWord(pick.status)}
				</Cell>
				<Cell right>
					<Num
						value={pick.roi}
						text={pick.status === "pending" ? "—" : units(pick.roi)}
					/>
				</Cell>
				<Cell right>
					<Num
						value={pick.clv}
						text={pick.clv != null ? pct(pick.clv * 100) : "—"}
					/>
				</Cell>
				<Cell right className="text-ink-55" title={clock(pick.pickedAt)}>
					{ago(pick.pickedAt)}
				</Cell>
				<Cell right className="text-xs">
					{button}
				</Cell>
			</Row>
			{body ? (
				<tr className="border-b border-ink-10 bg-ink-05/60">
					<td colSpan={11} className="px-3 py-2">
						{body}
					</td>
				</tr>
			) : null}
		</Fragment>
	);
}
