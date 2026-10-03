/**
 * NFL board API (2026-09-19): the operator's own against-the-spread picks
 * on the weekly Polymarket NFL slate. Read = this week's games (main line
 * per game from sharp_money_cache) + the operator's picks + season stats.
 * Write = set / clear a pick before kickoff. Settlement runs from the cron
 * through the same Gamma resolution as manual picks. Nothing here is read
 * by the bot or by any holder-book query.
 */

import { createServerFn } from "@tanstack/react-start";
import {
	type BoardPickRow,
	type BoardStats,
	boardStats,
	type MarketKind,
	NFL_SEASON,
	nflWeekOf,
} from "../../lib/nfl-board";
import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { getDb, nowUnixSeconds } from "../env";
import { fetchGammaMarket, resolvePickResult } from "./manual-picks";
import {
	getSlateRowByCondition,
	listSlateRows,
	refreshNflBoardSlate,
	SLATE_MAX_AGE_SECONDS,
	type SlateRow,
	slateUpdatedAt,
} from "./nfl-board-slate";

export interface BoardLine {
	kind: MarketKind;
	conditionId: string;
	marketTitle: string;
	sideA: { label: string; line: number; price: number | null };
	sideB: { label: string; line: number; price: number | null };
	/** The holder pipeline's sighted side on this market, if any (benchmark only). */
	signalSide: string | null;
	altLines: number;
	pick: BoardPick | null;
}

export interface TrendLine {
	games: number;
	su: string;
	ats: string;
	ou: string;
	atsStreak: string | null;
	ouStreak: string | null;
	/** Average margin vs the spread, points; positive = covering. */
	coverMargin: number | null;
	/** Average total vs the line, points; positive = going over. */
	totalMargin: number | null;
}

export interface TeamTrend {
	abbr: string;
	name: string;
	venue: "home" | "away";
	overall: TrendLine | null;
	/** Same team in this venue role (home or away) this season. */
	atVenue: TrendLine | null;
}

export interface BoardGame {
	eventSlug: string;
	matchup: string;
	eventTime: number;
	locked: boolean;
	spread: BoardLine | null;
	total: BoardLine | null;
	/** Canonical game match by slug (away-home); null when the games table has no row yet. */
	away: TeamTrend | null;
	home: TeamTrend | null;
	/** Which spread side is the home team ("A" | "B"), when resolvable. */
	homeSide: "A" | "B" | null;
}

export interface BoardPick {
	id: string;
	week: number;
	kind: MarketKind;
	eventSlug: string;
	conditionId: string;
	matchup: string;
	side: string;
	sideLabel: string;
	line: number;
	price: number;
	eventTime: number;
	pickedAt: number;
	signalSide: string | null;
	status: string;
	roi: number | null;
	settledAt: number | null;
}

interface PickRow {
	id: string;
	week: number;
	kind: string;
	event_slug: string;
	condition_id: string;
	matchup: string;
	side: string;
	side_label: string;
	line: number;
	price: number;
	event_time: number;
	picked_at: number;
	signal_side: string | null;
	status: string;
	roi: number | null;
	settled_at: number | null;
}

function toPick(r: PickRow): BoardPick {
	return {
		id: r.id,
		week: r.week,
		kind: r.kind === "total" ? "total" : "spread",
		eventSlug: r.event_slug,
		conditionId: r.condition_id,
		matchup: r.matchup,
		side: r.side,
		sideLabel: r.side_label,
		line: r.line,
		price: r.price,
		eventTime: r.event_time,
		pickedAt: r.picked_at,
		signalSide: r.signal_side,
		status: r.status,
		roi: r.roi,
		settledAt: r.settled_at,
	};
}

const PICK_COLS = `id, week, kind, event_slug, condition_id, matchup, side, side_label, line, price,
	event_time, picked_at, signal_side, status, roi, settled_at`;

interface SnapRow {
	team_id: string;
	snapshot_type: string;
	as_of_time: number;
	su_wins: number;
	su_losses: number;
	su_pushes: number;
	ats_wins: number;
	ats_losses: number;
	ats_pushes: number;
	ou_overs: number;
	ou_unders: number;
	ou_pushes: number;
	ats_streak_type: string | null;
	ats_streak_length: number | null;
	ou_streak_type: string | null;
	ou_streak_length: number | null;
	avg_cover_margin: number | null;
	avg_total_margin: number | null;
}

function toTrendLine(r: SnapRow | undefined): TrendLine | null {
	if (!r) return null;
	const games = r.su_wins + r.su_losses + r.su_pushes;
	if (games === 0) return null;
	const rec = (w: number, l: number, p: number) =>
		p > 0 ? `${w}-${l}-${p}` : `${w}-${l}`;
	const streak = (t: string | null, n: number | null) =>
		t && n ? `${t}${n}` : null;
	return {
		games,
		su: rec(r.su_wins, r.su_losses, r.su_pushes),
		ats: rec(r.ats_wins, r.ats_losses, r.ats_pushes),
		ou: rec(r.ou_overs, r.ou_unders, r.ou_pushes),
		atsStreak: streak(r.ats_streak_type, r.ats_streak_length),
		ouStreak: streak(r.ou_streak_type, r.ou_streak_length),
		coverMargin: r.avg_cover_margin,
		totalMargin: r.avg_total_margin,
	};
}

/** Polymarket NFL slug abbreviations that differ from the ESPN-seeded teams table. */
const POLYMARKET_NFL_ABBR: Record<string, string> = { la: "lar" };
const espnAbbr = (a: string) => POLYMARKET_NFL_ABBR[a] ?? a;

/**
 * Latest pre-kickoff trend snapshot per team (overall + venue role) for every
 * slate game, keyed by the slug's "away-home" abbreviations. Teams are resolved
 * from the slug itself, not the ESPN-fed games table: ESPN schedule ingestion
 * only looks one day ahead, so a Sunday game has no games row until Saturday.
 */
async function loadTrends(
	db: Db,
	slate: SlateRow[],
): Promise<
	Map<
		string,
		{
			away: TeamTrend;
			home: TeamTrend;
			teams: { away: TeamRow; home: TeamRow };
		}
	>
> {
	const out = new Map<
		string,
		{
			away: TeamTrend;
			home: TeamTrend;
			teams: { away: TeamRow; home: TeamRow };
		}
	>();
	const games = slate.flatMap((r) => {
		const key = slugKey(r.event_slug);
		if (!key) return [];
		const [away, home] = key.split("-");
		return [
			{ key, kickoff: r.kickoff, away: espnAbbr(away), home: espnAbbr(home) },
		];
	});
	if (games.length === 0) return out;
	const abbrs = [...new Set(games.flatMap((g) => [g.away, g.home]))];
	const teams = await all<{
		id: string;
		name: string;
		abbreviation: string;
		short_name: string | null;
	}>(
		db,
		`SELECT id, name, abbreviation, short_name FROM teams
		 WHERE sport_tag = 'nfl' AND lower(abbreviation) IN (${abbrs.map(() => "?").join(",")})`,
		...abbrs,
	);
	if (teams.length === 0) return out;
	const byAbbr = new Map(teams.map((t) => [t.abbreviation.toLowerCase(), t]));
	const snaps = await all<SnapRow>(
		db,
		`SELECT team_id, snapshot_type, as_of_time, su_wins, su_losses, su_pushes, ats_wins, ats_losses, ats_pushes,
		        ou_overs, ou_unders, ou_pushes, ats_streak_type, ats_streak_length, ou_streak_type, ou_streak_length,
		        avg_cover_margin, avg_total_margin
		 FROM team_trend_snapshots
		 WHERE sport_tag = 'nfl' AND snapshot_type IN ('overall','home','away')
		   AND team_id IN (${teams.map(() => "?").join(",")})
		 ORDER BY as_of_time DESC`,
		...teams.map((t) => t.id),
	);
	const latest = new Map<string, SnapRow>();
	for (const g of games) {
		for (const r of snaps) {
			if (r.as_of_time >= g.kickoff) continue; // pre-kickoff only
			const key = `${r.team_id}|${r.snapshot_type}|${g.key}`;
			if (!latest.has(key)) latest.set(key, r);
		}
	}
	for (const g of games) {
		const away = byAbbr.get(g.away);
		const home = byAbbr.get(g.home);
		if (!away || !home) continue;
		const trend = (
			team: { id: string; abbreviation: string; name: string },
			venue: "home" | "away",
		): TeamTrend => ({
			abbr: team.abbreviation,
			name: team.name,
			venue,
			overall: toTrendLine(latest.get(`${team.id}|overall|${g.key}`)),
			atVenue: toTrendLine(latest.get(`${team.id}|${venue}|${g.key}`)),
		});
		out.set(g.key, {
			away: trend(away, "away"),
			home: trend(home, "home"),
			teams: {
				away: {
					abbr: away.abbreviation,
					name: away.name,
					short: away.short_name,
				},
				home: {
					abbr: home.abbreviation,
					name: home.name,
					short: home.short_name,
				},
			},
		});
	}
	return out;
}

interface TeamRow {
	abbr: string;
	name: string;
	short: string | null;
}

function labelMatchesTeam(label: string, t: TeamRow): boolean {
	const l = label.trim().toLowerCase();
	if (!l) return false;
	return (
		l === t.abbr.toLowerCase() ||
		l === t.name.toLowerCase() ||
		(t.short ?? "").toLowerCase() === l ||
		t.name.toLowerCase().endsWith(` ${l}`) ||
		t.name.toLowerCase().includes(l)
	);
}

/** "nfl-gb-nyj-2026-09-20" → "gb-nyj" (Polymarket lists away first). */
function slugKey(eventSlug: string): string | null {
	const m = eventSlug.match(/^nfl-([a-z0-9]+)-([a-z0-9]+)-\d{4}-\d{2}-\d{2}$/i);
	return m ? `${m[1].toLowerCase()}-${m[2].toLowerCase()}` : null;
}

async function loadBoard(db: Db, week: number) {
	const now = nowUnixSeconds();
	// Refresh the Gamma slate when this week's rows are missing or stale.
	const stamp = await slateUpdatedAt(db, week);
	if (stamp === null || now - stamp > SLATE_MAX_AGE_SECONDS) {
		try {
			await refreshNflBoardSlate(db);
		} catch (error) {
			console.warn("[nfl-board] slate refresh failed", error);
		}
	}
	const slate = await listSlateRows(db, week);
	const [trends, picks] = await Promise.all([
		loadTrends(db, slate),
		all<PickRow>(
			db,
			`SELECT ${PICK_COLS} FROM nfl_board_picks WHERE season = ? ORDER BY event_time ASC`,
			NFL_SEASON,
		),
	]);
	// Holder-signal sighted side per market (benchmark only), from the pipeline cache.
	const conditionIds = slate
		.flatMap((r) => [r.spread_condition_id, r.total_condition_id])
		.filter((c): c is string => !!c);
	const signalByCondition = new Map<string, string>();
	if (conditionIds.length > 0) {
		const rows = await all<{ condition_id: string; sharp_side: string | null }>(
			db,
			`SELECT condition_id, sharp_side FROM sharp_money_cache WHERE condition_id IN (${conditionIds.map(() => "?").join(",")})`,
			...conditionIds,
		);
		for (const r of rows)
			if (r.sharp_side === "A" || r.sharp_side === "B")
				signalByCondition.set(r.condition_id, r.sharp_side);
	}
	const pickByKey = new Map(
		picks
			.filter((p) => p.week === week)
			.map((p) => [`${p.event_slug}|${p.kind}`, toPick(p)]),
	);
	const games: BoardGame[] = [];
	for (const r of slate) {
		const spread: BoardLine | null =
			r.spread_condition_id &&
			r.spread_a_label &&
			r.spread_b_label &&
			r.spread_line !== null
				? {
						kind: "spread",
						conditionId: r.spread_condition_id,
						marketTitle: r.spread_question ?? "",
						// Gamma's `line` is the named (first-outcome) team's line.
						sideA: {
							label: r.spread_a_label,
							line: r.spread_line,
							price: r.spread_a_price,
						},
						sideB: {
							label: r.spread_b_label,
							line: -r.spread_line,
							price: r.spread_b_price,
						},
						signalSide: signalByCondition.get(r.spread_condition_id) ?? null,
						altLines: r.spread_alts,
						pick: pickByKey.get(`${r.event_slug}|spread`) ?? null,
					}
				: null;
		const total: BoardLine | null =
			r.total_condition_id && r.total_line !== null
				? {
						kind: "total",
						conditionId: r.total_condition_id,
						marketTitle: r.total_question ?? "",
						sideA: {
							label: "Over",
							line: r.total_line,
							price: r.total_a_price,
						},
						sideB: {
							label: "Under",
							line: r.total_line,
							price: r.total_b_price,
						},
						signalSide: signalByCondition.get(r.total_condition_id) ?? null,
						altLines: r.total_alts,
						pick: pickByKey.get(`${r.event_slug}|total`) ?? null,
					}
				: null;
		const key = slugKey(r.event_slug);
		const t = key ? (trends.get(key) ?? null) : null;
		const homeTeam: TeamRow | null =
			r.home_name && r.home_abbr
				? { abbr: r.home_abbr, name: r.home_name, short: null }
				: (t?.teams.home ?? null);
		const awayTeam: TeamRow | null =
			r.away_name && r.away_abbr
				? { abbr: r.away_abbr, name: r.away_name, short: null }
				: (t?.teams.away ?? null);
		let homeSide: "A" | "B" | null = null;
		if (spread && homeTeam && awayTeam) {
			if (labelMatchesTeam(spread.sideA.label, homeTeam)) homeSide = "A";
			else if (labelMatchesTeam(spread.sideB.label, homeTeam)) homeSide = "B";
			else if (labelMatchesTeam(spread.sideA.label, awayTeam)) homeSide = "B";
			else if (labelMatchesTeam(spread.sideB.label, awayTeam)) homeSide = "A";
		}
		games.push({
			eventSlug: r.event_slug,
			matchup: r.title,
			eventTime: r.kickoff,
			locked: r.kickoff <= now,
			spread,
			total,
			away:
				t?.away ??
				(awayTeam
					? {
							abbr: awayTeam.abbr,
							name: awayTeam.name,
							venue: "away",
							overall: null,
							atVenue: null,
						}
					: null),
			home:
				t?.home ??
				(homeTeam
					? {
							abbr: homeTeam.abbr,
							name: homeTeam.name,
							venue: "home",
							overall: null,
							atVenue: null,
						}
					: null),
			homeSide,
		});
	}
	// Picks whose game has left the slate (past weeks) still belong to the week's list.
	for (const p of pickByKey.values()) {
		const found = games.find((g) => g.eventSlug === p.eventSlug);
		const game: BoardGame = found ?? {
			eventSlug: p.eventSlug,
			matchup: p.matchup,
			eventTime: p.eventTime,
			locked: true,
			spread: null,
			total: null,
			away: null,
			home: null,
			homeSide: null,
		};
		if (!found) games.push(game);
		if (game[p.kind]) continue;
		const isA = p.side === "A";
		game[p.kind] = {
			kind: p.kind,
			conditionId: p.conditionId,
			marketTitle: "",
			sideA: {
				label: isA ? p.sideLabel : "—",
				line: p.kind === "total" ? p.line : isA ? p.line : -p.line,
				price: null,
			},
			sideB: {
				label: isA ? "—" : p.sideLabel,
				line: p.kind === "total" ? p.line : isA ? -p.line : p.line,
				price: null,
			},
			signalSide: p.signalSide,
			altLines: 0,
			pick: p,
		};
	}
	games.sort(
		(a, b) => a.eventTime - b.eventTime || a.matchup.localeCompare(b.matchup),
	);
	const statRows: BoardPickRow[] = picks.map((p) => ({
		week: p.week,
		kind: p.kind === "total" ? "total" : "spread",
		side: p.side,
		sideLabel: p.side_label,
		line: p.line,
		price: p.price,
		status: p.status,
		roi: p.roi,
		signalSide: p.signal_side,
		eventTime: p.event_time,
	}));
	const stats: BoardStats = boardStats(statRows);
	const recent = picks
		.filter((p) => p.status !== "pending")
		.sort((a, b) => (b.settled_at ?? 0) - (a.settled_at ?? 0))
		.slice(0, 40)
		.map(toPick);
	return {
		season: NFL_SEASON,
		week,
		currentWeek: nflWeekOf(now),
		now,
		slateUpdatedAt: await slateUpdatedAt(db, week),
		games,
		stats,
		recent,
	};
}

export const getNflBoardFn = createServerFn({ method: "POST" })
	.inputValidator((d: { week?: number }) => d)
	.handler(async ({ context, data }) => {
		const db = getDb(context);
		const week =
			typeof data?.week === "number" &&
			Number.isInteger(data.week) &&
			data.week >= 1 &&
			data.week <= 22
				? data.week
				: nflWeekOf(nowUnixSeconds());
		return loadBoard(db, week);
	});

export const setNflBoardPickFn = createServerFn({ method: "POST" })
	.inputValidator((d: { conditionId: string; side: "A" | "B" }) => d)
	.handler(async ({ context, data }) => {
		const db = getDb(context);
		const now = nowUnixSeconds();
		if (
			typeof data?.conditionId !== "string" ||
			(data.side !== "A" && data.side !== "B")
		) {
			return { error: "invalid_payload" as const };
		}
		const r = await getSlateRowByCondition(db, data.conditionId);
		if (!r) return { error: "market_not_found" as const };
		if (r.kickoff <= now) return { error: "locked" as const };
		const kind: MarketKind =
			r.spread_condition_id === data.conditionId ? "spread" : "total";
		const isA = data.side === "A";
		let label: string | null;
		let line: number | null;
		let price: number | null;
		if (kind === "spread") {
			label = isA ? r.spread_a_label : r.spread_b_label;
			line =
				r.spread_line === null ? null : isA ? r.spread_line : -r.spread_line;
			price = isA ? r.spread_a_price : r.spread_b_price;
		} else {
			label = isA ? "Over" : "Under";
			line = r.total_line;
			price = isA ? r.total_a_price : r.total_b_price;
		}
		if (
			!label ||
			line === null ||
			typeof price !== "number" ||
			!(price > 0 && price < 1)
		) {
			return { error: "no_price" as const };
		}
		const signal = await first<{
			sharp_side: string | null;
			side_a_price: number | null;
			side_b_price: number | null;
		}>(
			db,
			`SELECT sharp_side, side_a_price, side_b_price FROM sharp_money_cache WHERE condition_id = ?`,
			data.conditionId,
		);
		const signalSide =
			signal?.sharp_side === "A" || signal?.sharp_side === "B"
				? signal.sharp_side
				: null;
		const week = nflWeekOf(r.kickoff);
		const id = `nflb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		await run(
			db,
			`INSERT INTO nfl_board_picks (id, season, week, event_slug, kind, condition_id, market_title, matchup,
			   side, side_label, line, price, event_time, picked_at, signal_side, signal_price, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
			 ON CONFLICT(event_slug, kind) DO UPDATE SET
			   condition_id = excluded.condition_id, market_title = excluded.market_title,
			   side = excluded.side, side_label = excluded.side_label, line = excluded.line,
			   price = excluded.price, picked_at = excluded.picked_at,
			   signal_side = excluded.signal_side, signal_price = excluded.signal_price,
			   status = 'pending', resolved_outcome = NULL, roi = NULL, settled_at = NULL,
			   settle_attempts = 0, last_checked_at = NULL
			 WHERE nfl_board_picks.status = 'pending'`,
			id,
			NFL_SEASON,
			week,
			r.event_slug,
			kind,
			data.conditionId,
			(kind === "spread" ? r.spread_question : r.total_question) ?? r.title,
			r.title,
			data.side,
			label,
			line,
			price,
			r.kickoff,
			now,
			signalSide,
			signalSide === "A"
				? (signal?.side_a_price ?? null)
				: signalSide === "B"
					? (signal?.side_b_price ?? null)
					: null,
		);
		return { ok: true as const, week };
	});

export const clearNflBoardPickFn = createServerFn({ method: "POST" })
	.inputValidator((d: { eventSlug: string; kind: MarketKind }) => d)
	.handler(async ({ context, data }) => {
		const db = getDb(context);
		if (typeof data?.eventSlug !== "string")
			return { error: "invalid_payload" as const };
		const kind: MarketKind = data.kind === "total" ? "total" : "spread";
		await run(
			db,
			`DELETE FROM nfl_board_picks WHERE event_slug = ? AND kind = ? AND status = 'pending' AND event_time > ?`,
			data.eventSlug,
			kind,
			nowUnixSeconds(),
		);
		return { ok: true as const };
	});

/**
 * Cron settlement: same eligibility and resolution path as shadow rows
 * (kickoff + 15 min, Gamma resolution, backoff on attempts).
 */
/**
 * Fill in the holder signal on pending picks made before their market reached
 * sharp_money_cache (a pick made days ahead finds no signal yet). Fill-only:
 * a side recorded at pick time is never overwritten, and nothing is stamped
 * at or after kickoff, so every stamp is a pre-game signal.
 */
export async function stampNflBoardSignals(db: Db): Promise<number> {
	const result = await run(
		db,
		`UPDATE nfl_board_picks SET
		   signal_side = (SELECT c.sharp_side FROM sharp_money_cache c WHERE c.condition_id = nfl_board_picks.condition_id),
		   signal_price = (SELECT CASE c.sharp_side WHEN 'A' THEN c.side_a_price ELSE c.side_b_price END
		                   FROM sharp_money_cache c WHERE c.condition_id = nfl_board_picks.condition_id)
		 WHERE status = 'pending' AND signal_side IS NULL AND event_time > ?
		   AND EXISTS (SELECT 1 FROM sharp_money_cache c
		               WHERE c.condition_id = nfl_board_picks.condition_id AND c.sharp_side IN ('A','B'))`,
		nowUnixSeconds(),
	);
	return Number(result.meta?.changes ?? 0);
}

export async function settleNflBoardPicks(
	db: Db,
	options?: { limit?: number },
): Promise<{ checked: number; updated: number }> {
	const limit = Math.min(Math.max(options?.limit ?? 8, 1), 25);
	const now = nowUnixSeconds();
	const rows = await all<{
		id: string;
		condition_id: string;
		side: string;
		price: number;
	}>(
		db,
		`SELECT id, condition_id, side, price FROM nfl_board_picks
		 WHERE status = 'pending' AND event_time <= ?
		   AND (settle_attempts < 6 OR last_checked_at IS NULL OR last_checked_at <= ?)
		 ORDER BY settle_attempts ASC, event_time ASC LIMIT ?`,
		now - 15 * 60,
		now - 6 * 3600,
		limit,
	);
	let updated = 0;
	for (const row of rows) {
		const market = await fetchGammaMarket(row.condition_id);
		const resolution = market
			? resolvePickResult({
					sharpSide: row.side,
					entryPrice: row.price,
					market,
				})
			: null;
		if (!resolution || resolution.status === "pending") {
			await run(
				db,
				`UPDATE nfl_board_picks SET settle_attempts = settle_attempts + 1, last_checked_at = ? WHERE id = ?`,
				now,
				row.id,
			);
			continue;
		}
		await run(
			db,
			`UPDATE nfl_board_picks SET status = ?, resolved_outcome = ?, roi = ?, settled_at = ? WHERE id = ?`,
			resolution.status,
			resolution.resolvedOutcome ?? null,
			resolution.roi ?? null,
			now,
			row.id,
		);
		updated += 1;
	}
	return { checked: rows.length, updated };
}
