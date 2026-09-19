/**
 * NFL board — the weekly Polymarket NFL slate with the main spread per game.
 * The operator picks a side; picks lock at kickoff and settle through the
 * same Gamma resolution as everything else. Nothing here touches the bot.
 * The holder signal's sighted side is shown only as a benchmark.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ago, clock } from "@/components/terminal/format";
import { Cell, Empty, Panel, Row, Stat, Tag, Workspace } from "@/components/terminal/panel";
import { Shell, ShellButton } from "@/components/terminal/shell";
import type { BoardSplit } from "@/lib/nfl-board";
import {
	type BoardGame,
	clearNflBoardPickFn,
	getNflBoardFn,
	setNflBoardPickFn,
} from "../server/api/nfl-board";

export const Route = createFileRoute("/nfl")({
	component: NflBoardPage,
});

type Board = Awaited<ReturnType<typeof getNflBoardFn>>;

function signedLine(line: number): string {
	return `${line > 0 ? "+" : ""}${line}`;
}

function cents(price: number | null): string {
	return typeof price === "number" ? `${Math.round(price * 100)}¢` : "—";
}

function record(s: BoardSplit): string {
	return s.pushes > 0 ? `${s.wins}-${s.losses}-${s.pushes}` : `${s.wins}-${s.losses}`;
}

function roiText(s: BoardSplit): string {
	return s.roiPct === null ? "—" : `${s.roiPct >= 0 ? "+" : ""}${s.roiPct.toFixed(1)}%`;
}

function resultWord(status: string): string {
	return status === "win" ? "W" : status === "loss" ? "L" : status === "push" ? "P" : "";
}

function SideButton({
	game,
	side,
	onPick,
	busy,
}: {
	game: BoardGame;
	side: "A" | "B";
	onPick: (game: BoardGame, side: "A" | "B") => void;
	busy: boolean;
}) {
	const s = side === "A" ? game.sideA : game.sideB;
	const picked = game.pick?.side === side;
	const signal = game.signalSide === side;
	const settled = game.pick && game.pick.status !== "pending";
	const tone = picked
		? settled
			? game.pick?.status === "win"
				? "border-signal-pos text-signal-pos"
				: game.pick?.status === "loss"
					? "border-signal-bad text-signal-bad"
					: "border-ink-55 text-ink-95"
			: "border-brand-blue bg-brand-blue/10 text-ink-95"
		: "border-ink-15 text-ink-70 hover:border-ink-40 hover:text-ink-95";
	return (
		<button
			type="button"
			disabled={game.locked || busy || s.price === null}
			onClick={() => onPick(game, side)}
			className={`flex w-full items-center justify-between gap-2 border px-2 py-1 font-mono text-xs tabular-nums transition-colors disabled:cursor-default disabled:opacity-70 ${tone}`}
			title={signal ? "Holder signal sighted this side" : undefined}
		>
			<span className="truncate">
				{s.label} {signedLine(s.line)}
				{signal ? <span className="ml-1 text-signal-warn">•</span> : null}
			</span>
			<span className="text-ink-55">{cents(s.price)}</span>
		</button>
	);
}

function SplitRow({ label, s }: { label: string; s: BoardSplit }) {
	return (
		<Row>
			<Cell>{label}</Cell>
			<Cell right>{s.n === 0 ? "—" : record(s)}</Cell>
			<Cell right className={s.roiPct === null ? "text-ink-40" : s.roiPct >= 0 ? "text-signal-pos" : "text-signal-bad"}>
				{roiText(s)}
			</Cell>
		</Row>
	);
}

function NflBoardPage() {
	const [data, setData] = useState<Board | null>(null);
	const [week, setWeek] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (w: number | null) => {
		setBusy(true);
		try {
			const board = await getNflBoardFn({ data: w === null ? {} : { week: w } });
			setData(board);
			setWeek(board.week);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "load failed");
		} finally {
			setBusy(false);
		}
	}, []);

	useEffect(() => {
		void load(null);
	}, [load]);

	const onPick = useCallback(
		async (game: BoardGame, side: "A" | "B") => {
			setBusy(true);
			try {
				const res =
					game.pick?.side === side
						? await clearNflBoardPickFn({ data: { eventSlug: game.eventSlug } })
						: await setNflBoardPickFn({ data: { conditionId: game.conditionId, side } });
				if ("error" in res) setError(res.error ?? "error");
				else setError(null);
				await load(week);
			} finally {
				setBusy(false);
			}
		},
		[load, week],
	);

	const games = data?.games ?? [];
	const open = useMemo(() => games.filter((g) => !g.locked).length, [games]);
	const pickedThisWeek = useMemo(() => games.filter((g) => g.pick).length, [games]);
	const stats = data?.stats ?? null;

	return (
		<Shell
			wide
			actions={
				<>
					{data ? (
						<span className="hidden font-mono text-xxs tabular-nums text-ink-40 sm:inline">
							week {data.week} · {open} open · {pickedThisWeek} picked
						</span>
					) : null}
					<ShellButton onClick={() => void load((week ?? 1) - 1)} disabled={busy || (week ?? 1) <= 1}>
						‹
					</ShellButton>
					<ShellButton onClick={() => void load((week ?? 1) + 1)} disabled={busy || (week ?? 1) >= 22}>
						›
					</ShellButton>
					<ShellButton onClick={() => void load(week)} disabled={busy}>
						{busy ? "…" : "Refresh"}
					</ShellButton>
				</>
			}
		>
			{error ? <p className="px-3 py-2 font-mono text-xs text-signal-bad">{error}</p> : null}
			<Workspace>
				<Panel
					span={8}
					title={`NFL board · week ${data?.week ?? "…"}`}
					meta={
						<span>
							main line per game · click a side to pick, again to clear · locks at kickoff ·{" "}
							<span className="text-signal-warn">•</span> = holder signal side
						</span>
					}
				>
					{games.length === 0 ? (
						<Empty>{data ? "No NFL spread markets in the cache for this week." : "Loading…"}</Empty>
					) : (
						<table className="w-full text-sm">
							<thead>
								<tr className="h-6 border-b border-ink-10 font-mono text-xxs uppercase tracking-[0.12em] text-ink-40">
									<th className="px-3 text-left">kick</th>
									<th className="px-3 text-left">game</th>
									<th className="px-3 text-left">side A</th>
									<th className="px-3 text-left">side B</th>
									<th className="px-3 text-right">result</th>
								</tr>
							</thead>
							<tbody>
								{games.map((g) => (
									<Row key={g.eventSlug} className="h-9">
										<Cell mono className="whitespace-nowrap text-ink-55">
											{clock(g.eventTime)}
											{g.locked ? <span className="ml-1 text-ink-40">🔒</span> : null}
										</Cell>
										<Cell className="whitespace-nowrap text-ink-95">
											{g.matchup}
											{g.altLines > 0 ? (
												<span className="ml-1.5">
													<Tag>+{g.altLines} alt</Tag>
												</span>
											) : null}
										</Cell>
										<Cell className="min-w-[10rem]">
											<SideButton game={g} side="A" onPick={onPick} busy={busy} />
										</Cell>
										<Cell className="min-w-[10rem]">
											<SideButton game={g} side="B" onPick={onPick} busy={busy} />
										</Cell>
										<Cell right className={g.pick?.status === "win" ? "text-signal-pos" : g.pick?.status === "loss" ? "text-signal-bad" : "text-ink-55"}>
											{g.pick
												? g.pick.status === "pending"
													? `${g.pick.sideLabel} ${signedLine(g.pick.line)} @${Math.round(g.pick.price * 100)}¢`
													: `${resultWord(g.pick.status)} ${g.pick.roi !== null ? `${g.pick.roi >= 0 ? "+" : ""}${g.pick.roi.toFixed(2)}u` : ""}`
												: "—"}
										</Cell>
									</Row>
								))}
							</tbody>
						</table>
					)}
				</Panel>
				<Panel span={4} title="Season" meta={stats ? `${stats.pending} pending · streak ${stats.streak > 0 ? `W${stats.streak}` : stats.streak < 0 ? `L${-stats.streak}` : "—"}` : undefined}>
					{stats ? (
						<>
							<div className="flex divide-x divide-ink-15 border-b border-ink-10">
								<Stat label="record" value={stats.season.n === 0 ? "—" : record(stats.season)} />
								<Stat label="roi / $1" value={roiText(stats.season)} valueClassName={stats.season.roiPct === null ? "" : stats.season.roiPct >= 0 ? "text-signal-pos" : "text-signal-bad"} />
								<Stat label="cover %" value={stats.season.wins + stats.season.losses === 0 ? "—" : `${((stats.season.wins / (stats.season.wins + stats.season.losses)) * 100).toFixed(0)}%`} />
							</div>
							<table className="w-full text-sm">
								<tbody>
									<SplitRow label="favorites" s={stats.favorites} />
									<SplitRow label="dogs" s={stats.dogs} />
									<SplitRow label="with the signal" s={stats.withSignal} />
									<SplitRow label="against the signal" s={stats.againstSignal} />
									<SplitRow label="the signal itself, same games" s={stats.signalItself} />
									{stats.byWeek.map((w) => (
										<SplitRow key={w.week} label={`week ${w.week}`} s={w} />
									))}
								</tbody>
							</table>
						</>
					) : (
						<Empty>Loading…</Empty>
					)}
				</Panel>
				<Panel span={12} title="Settled picks" meta={data ? `as of ${ago(data.now)}` : undefined}>
					{!data || data.recent.length === 0 ? (
						<Empty>Nothing settled yet.</Empty>
					) : (
						<table className="w-full text-sm">
							<tbody>
								{data.recent.map((p) => (
									<Row key={p.id}>
										<Cell mono className="text-ink-55">wk {p.week}</Cell>
										<Cell className="text-ink-95">{p.matchup}</Cell>
										<Cell>
											{p.sideLabel} {signedLine(p.line)} @{Math.round(p.price * 100)}¢
											{p.signalSide ? <span className="ml-1.5"><Tag>{p.signalSide === p.side ? "with signal" : "vs signal"}</Tag></span> : null}
										</Cell>
										<Cell right className={p.status === "win" ? "text-signal-pos" : p.status === "loss" ? "text-signal-bad" : "text-ink-55"}>
											{resultWord(p.status)} {p.roi !== null ? `${p.roi >= 0 ? "+" : ""}${p.roi.toFixed(2)}u` : ""}
										</Cell>
									</Row>
								))}
							</tbody>
						</table>
					)}
				</Panel>
			</Workspace>
		</Shell>
	);
}
