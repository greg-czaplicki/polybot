/**
 * NFL board — the weekly Polymarket NFL slate as a two-sided spread ladder.
 * The operator picks a side; picks lock at kickoff and settle through the
 * same Gamma resolution as everything else. Nothing here touches the bot.
 * The holder signal's sighted side is shown only as a benchmark dot.
 *
 * Layout (2026-09-19 v2): season strip on top (record, ROI, cover, streak,
 * this week), then the ladder — games grouped by kickoff slot, one row per
 * game with the two sides mirrored around a centre gutter, status carried
 * by colour on the picked side. Season splits and the settled tape sit in
 * their own panels. Panel grammar per .impeccable.md: hairlines, tabular
 * mono numbers, no cards.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ago, clock } from "@/components/terminal/format";
import {
	Cell,
	Dot,
	Empty,
	Panel,
	Row,
	Tag,
	Tape,
	type Tone,
	Workspace,
} from "@/components/terminal/panel";
import { Shell, ShellButton } from "@/components/terminal/shell";
import type { BoardSplit } from "@/lib/nfl-board";
import {
	type BoardGame,
	type BoardPick,
	clearNflBoardPickFn,
	getNflBoardFn,
	setNflBoardPickFn,
} from "../server/api/nfl-board";

export const Route = createFileRoute("/nfl")({
	component: NflBoardPage,
});

type Board = Awaited<ReturnType<typeof getNflBoardFn>>;

const DAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function slotLabel(eventTime: number): string {
	const d = new Date(eventTime * 1000);
	return `${DAY[d.getUTCDay()]} ${`${d.getUTCHours()}`.padStart(2, "0")}:${`${d.getUTCMinutes()}`.padStart(2, "0")}Z`;
}

function signedLine(line: number): string {
	return `${line > 0 ? "+" : ""}${line}`;
}

function cents(price: number | null): string {
	return typeof price === "number" ? `${Math.round(price * 100)}¢` : "—";
}

function record(s: BoardSplit): string {
	if (s.n === 0) return "—";
	return s.pushes > 0
		? `${s.wins}-${s.losses}-${s.pushes}`
		: `${s.wins}-${s.losses}`;
}

function roiText(s: BoardSplit): string {
	return s.roiPct === null
		? "—"
		: `${s.roiPct >= 0 ? "+" : "−"}${Math.abs(s.roiPct).toFixed(1)}%`;
}

function roiClass(s: BoardSplit): string {
	return s.roiPct === null
		? "text-ink-40"
		: s.roiPct >= 0
			? "text-signal-pos"
			: "text-signal-bad";
}

function units(roi: number | null): string {
	if (roi === null) return "";
	return `${roi >= 0 ? "+" : "−"}${Math.abs(roi).toFixed(2)}u`;
}

function statusClass(status: string | undefined): string {
	return status === "win"
		? "text-signal-pos"
		: status === "loss"
			? "text-signal-bad"
			: "text-ink-85";
}

/** One half of the ladder row. `mirror` puts the team name on the outside edge. */
function SideHalf({
	game,
	side,
	mirror,
	onPick,
	busy,
}: {
	game: BoardGame;
	side: "A" | "B";
	mirror: boolean;
	onPick: (game: BoardGame, side: "A" | "B") => void;
	busy: boolean;
}) {
	const s = side === "A" ? game.sideA : game.sideB;
	const pick = game.pick;
	const picked = pick?.side === side;
	const other = !!pick && !picked;
	const signal = game.signalSide === side;
	const disabled = game.locked || busy || s.price === null;
	const settled = pick && pick.status !== "pending";
	const color = picked
		? settled
			? statusClass(pick?.status)
			: "text-ink-95"
		: other || game.locked
			? "text-ink-40"
			: "text-ink-70";
	const surface = picked
		? settled
			? "bg-ink-10"
			: "bg-brand-blue/15"
		: disabled
			? ""
			: "hover:bg-ink-10";
	const name = (
		<span
			className={`truncate font-sans text-sm ${picked ? "font-semibold" : ""}`}
		>
			{signal ? (
				<span className="mr-1.5 inline-block align-middle">
					<Dot tone="warn" />
				</span>
			) : null}
			{s.label}
		</span>
	);
	const num = (
		<span className="shrink-0 font-mono text-xs tabular-nums">
			<span className={picked ? "" : "text-ink-55"}>{signedLine(s.line)}</span>
			<span className="ml-2 text-ink-40">{cents(s.price)}</span>
		</span>
	);
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={() => onPick(game, side)}
			aria-pressed={picked}
			className={`flex h-10 min-w-0 flex-1 items-center gap-3 px-3 text-left transition-colors disabled:cursor-default ${mirror ? "flex-row-reverse text-right" : ""} ${color} ${surface}`}
		>
			{name}
			<span className="flex-1" />
			{num}
		</button>
	);
}

function GutterStatus({ game }: { game: BoardGame }) {
	const p = game.pick;
	if (p && p.status !== "pending") {
		return (
			<span
				className={`font-mono text-xs tabular-nums ${statusClass(p.status)}`}
			>
				{p.status === "win" ? "W" : p.status === "loss" ? "L" : "P"}{" "}
				{units(p.roi)}
			</span>
		);
	}
	if (game.locked)
		return (
			<span className="font-mono text-xxs uppercase tracking-[0.15em] text-ink-40">
				live
			</span>
		);
	if (p)
		return (
			<span className="font-mono text-xxs uppercase tracking-[0.15em] text-brand-blue">
				picked
			</span>
		);
	return <span className="font-mono text-xxs text-ink-25">vs</span>;
}

function SplitRow({ label, s }: { label: string; s: BoardSplit }) {
	return (
		<Row>
			<Cell className="text-ink-70">{label}</Cell>
			<Cell right className="text-ink-85">
				{record(s)}
			</Cell>
			<Cell right className={roiClass(s)}>
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
			const board = await getNflBoardFn({
				data: w === null ? {} : { week: w },
			});
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
						: await setNflBoardPickFn({
								data: { conditionId: game.conditionId, side },
							});
				setError("error" in res ? (res.error ?? "error") : null);
				await load(week);
			} finally {
				setBusy(false);
			}
		},
		[load, week],
	);

	const games = data?.games ?? [];
	const stats = data?.stats ?? null;
	const slots = useMemo(() => {
		const map = new Map<number, BoardGame[]>();
		for (const g of games)
			map.set(g.eventTime, [...(map.get(g.eventTime) ?? []), g]);
		return [...map.entries()].sort((a, b) => a[0] - b[0]);
	}, [games]);
	const open = games.filter((g) => !g.locked).length;
	const picked = games.filter((g) => g.pick).length;
	const weekRecord = useMemo(() => {
		const s = { n: 0, wins: 0, losses: 0, pushes: 0 };
		for (const g of games) {
			const st = g.pick?.status;
			if (st === "win") s.wins += 1;
			else if (st === "loss") s.losses += 1;
			else if (st === "push") s.pushes += 1;
			else continue;
			s.n += 1;
		}
		return s;
	}, [games]);

	const strip: { key: string; label: string; value: string; tone: Tone }[] =
		stats
			? [
					{
						key: "record",
						label: "Season",
						value: record(stats.season),
						tone:
							stats.season.n === 0
								? "off"
								: stats.season.wins >= stats.season.losses
									? "ok"
									: "bad",
					},
					{
						key: "roi",
						label: "ROI / $1",
						value: roiText(stats.season),
						tone:
							stats.season.roiPct === null
								? "off"
								: stats.season.roiPct >= 0
									? "ok"
									: "bad",
					},
					{
						key: "cover",
						label: "Cover",
						value:
							stats.season.wins + stats.season.losses === 0
								? "—"
								: `${((stats.season.wins / (stats.season.wins + stats.season.losses)) * 100).toFixed(0)}%`,
						tone: "off",
					},
					{
						key: "streak",
						label: "Streak",
						value:
							stats.streak > 0
								? `W${stats.streak}`
								: stats.streak < 0
									? `L${-stats.streak}`
									: "—",
						tone: stats.streak > 0 ? "ok" : stats.streak < 0 ? "bad" : "off",
					},
					{
						key: "week",
						label: `Week ${data?.week ?? ""}`,
						value:
							weekRecord.n > 0
								? `${weekRecord.wins}-${weekRecord.losses}${weekRecord.pushes ? `-${weekRecord.pushes}` : ""} · ${picked}/${games.length} picked`
								: `${picked}/${games.length} picked · ${open} open`,
						tone: open > 0 && picked < games.length ? "warn" : "ok",
					},
				]
			: [];

	return (
		<Shell
			wide
			actions={
				<>
					<ShellButton
						onClick={() => void load((week ?? 1) - 1)}
						disabled={busy || (week ?? 1) <= 1}
						title="Previous week"
					>
						‹
					</ShellButton>
					<ShellButton
						onClick={() => void load((week ?? 1) + 1)}
						disabled={busy || (week ?? 1) >= 22}
						title="Next week"
					>
						›
					</ShellButton>
					<ShellButton onClick={() => void load(week)} disabled={busy}>
						{busy ? "…" : "Refresh"}
					</ShellButton>
				</>
			}
		>
			{/* Season strip — the three-second read. */}
			<div className="flex flex-wrap items-stretch divide-x divide-ink-15 bg-ink-05">
				{strip.map((item) => (
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
				{!data ? (
					<p className="px-3 py-2 text-sm text-ink-55">Loading…</p>
				) : null}
			</div>
			{error ? (
				<p className="border-t border-ink-15 bg-signal-bad/10 px-3 py-1.5 font-mono text-xs text-signal-bad">
					{error}
				</p>
			) : null}

			<Workspace>
				<Panel
					span={8}
					title={`Spread ladder · week ${data?.week ?? "…"}`}
					meta={
						<>
							<span className="sm:hidden">tap a side · locks at kickoff</span>
							<span className="hidden sm:inline">
								tap a side to pick · tap again to clear · locks at kickoff ·{" "}
								<span className="inline-block align-middle">
									<Dot tone="warn" />
								</span>{" "}
								holder signal
							</span>
						</>
					}
					bodyClassName="p-0"
				>
					{games.length === 0 ? (
						<Empty>
							{data
								? "No NFL spread markets in the cache for this week yet."
								: "Loading…"}
						</Empty>
					) : (
						slots.map(([eventTime, list]) => (
							<section key={eventTime}>
								<header className="flex h-7 items-center justify-between border-b border-ink-10 bg-ink-05 px-3 font-mono text-xxs uppercase tracking-[0.15em] text-ink-40">
									<span>
										{slotLabel(eventTime)}
										<span className="ml-2 normal-case tracking-normal text-ink-25">
											{clock(eventTime)} local
										</span>
									</span>
									<span>
										{list.length} {list.length === 1 ? "game" : "games"}
										{list[0].locked ? " · started" : ""}
									</span>
								</header>
								<ul>
									{list.map((g) => (
										<li
											key={g.eventSlug}
											className="flex items-stretch border-b border-ink-10 last:border-b-0"
										>
											<SideHalf
												game={g}
												side="A"
												mirror={false}
												onPick={onPick}
												busy={busy}
											/>
											<div className="flex w-12 shrink-0 flex-col items-center justify-center border-x border-ink-10 bg-ink-05 px-1 text-center sm:w-20">
												<GutterStatus game={g} />
												{g.altLines > 0 && !g.locked ? (
													<span className="mt-0.5 font-mono text-xxs text-ink-25">
														+{g.altLines} alt
													</span>
												) : null}
											</div>
											<SideHalf
												game={g}
												side="B"
												mirror
												onPick={onPick}
												busy={busy}
											/>
										</li>
									))}
								</ul>
							</section>
						))
					)}
				</Panel>

				<Panel
					span={4}
					title="Season splits"
					meta={stats ? `${stats.pending} pending` : undefined}
					bodyClassName="p-0"
				>
					{stats ? (
						<table className="w-full text-sm">
							<thead>
								<tr className="h-6 border-b border-ink-10 font-mono text-xxs uppercase tracking-[0.12em] text-ink-40">
									<th className="px-3 text-left font-medium">cut</th>
									<th className="px-3 text-right font-medium">record</th>
									<th className="px-3 text-right font-medium">roi</th>
								</tr>
							</thead>
							<tbody>
								<SplitRow label="favorites" s={stats.favorites} />
								<SplitRow label="dogs" s={stats.dogs} />
								<SplitRow label="with the signal" s={stats.withSignal} />
								<SplitRow label="against the signal" s={stats.againstSignal} />
								<SplitRow
									label="signal itself, same games"
									s={stats.signalItself}
								/>
								{stats.byWeek.length > 0 ? (
									<tr className="h-6 border-y border-ink-10 bg-ink-05 font-mono text-xxs uppercase tracking-[0.12em] text-ink-40">
										<td className="px-3" colSpan={3}>
											by week
										</td>
									</tr>
								) : null}
								{stats.byWeek.map((w) => (
									<SplitRow key={w.week} label={`week ${w.week}`} s={w} />
								))}
							</tbody>
						</table>
					) : (
						<Empty>Loading…</Empty>
					)}
				</Panel>

				<Panel
					span={12}
					title="Settled picks"
					meta={data ? `as of ${ago(data.now)}` : undefined}
					bodyClassName="p-0"
				>
					{!data || data.recent.length === 0 ? (
						<Empty>
							Nothing settled yet. Picks grade about fifteen minutes after the
							final.
						</Empty>
					) : (
						<Tape
							head={[
								{ label: "wk" },
								{ label: "game" },
								{ label: "pick" },
								{ label: "price", align: "right" },
								{ label: "signal" },
								{ label: "result", align: "right" },
							]}
						>
							{data.recent.map((p: BoardPick) => (
								<Row key={p.id}>
									<Cell mono className="text-ink-55">
										{p.week}
									</Cell>
									<Cell className="text-ink-85">{p.matchup}</Cell>
									<Cell className="text-ink-95">
										{p.sideLabel}{" "}
										<span className="font-mono text-xs text-ink-55">
											{signedLine(p.line)}
										</span>
									</Cell>
									<Cell right className="text-ink-55">
										{cents(p.price)}
									</Cell>
									<Cell>
										{p.signalSide ? (
											<Tag>{p.signalSide === p.side ? "with" : "against"}</Tag>
										) : (
											<span className="text-ink-25">—</span>
										)}
									</Cell>
									<Cell right className={statusClass(p.status)}>
										{p.status === "win" ? "W" : p.status === "loss" ? "L" : "P"}{" "}
										{units(p.roi)}
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
