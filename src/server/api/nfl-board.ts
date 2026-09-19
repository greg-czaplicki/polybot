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
	lineForSide,
	type MarketKind,
	NFL_SEASON,
	nflWeekBounds,
	nflWeekOf,
	parseSpreadTitle,
	parseTotalTitle,
	pickMainLine,
	type SpreadMarket,
} from "../../lib/nfl-board";
import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { getDb, nowUnixSeconds } from "../env";
import { fetchGammaMarket, resolvePickResult } from "./manual-picks";

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

async function listSlate(
	db: Db,
	week: number,
): Promise<Map<string, SpreadMarket[]>> {
	const { start, end } = nflWeekBounds(week);
	const rows = await all<{
		condition_id: string;
		event_slug: string;
		market_title: string;
		event_time: string;
		side_a_label: string | null;
		side_b_label: string | null;
		side_a_price: number | null;
		side_b_price: number | null;
		sharp_side: string | null;
		market_volume: number | null;
	}>(
		db,
		`SELECT condition_id, event_slug, market_title, event_time, side_a_label, side_b_label,
		        side_a_price, side_b_price, sharp_side, market_volume
		 FROM sharp_money_cache
		 WHERE event_slug LIKE 'nfl-%'
		   AND (market_title LIKE '%: Spread: %' OR market_title LIKE '%: O/U %')
		   AND event_time IS NOT NULL
		   AND unixepoch(event_time) >= ? AND unixepoch(event_time) < ?`,
		start,
		end,
	);
	const byGame = new Map<string, SpreadMarket[]>();
	for (const r of rows) {
		const eventTime = Math.floor(Date.parse(r.event_time) / 1000);
		if (!Number.isFinite(eventTime) || !r.side_a_label || !r.side_b_label)
			continue;
		const list = byGame.get(r.event_slug) ?? [];
		list.push({
			conditionId: r.condition_id,
			eventSlug: r.event_slug,
			marketTitle: r.market_title,
			eventTime,
			sideALabel: r.side_a_label,
			sideBLabel: r.side_b_label,
			sideAPrice: r.side_a_price,
			sideBPrice: r.side_b_price,
			sharpSide: r.sharp_side,
			volume: r.market_volume,
		});
		byGame.set(r.event_slug, list);
	}
	return byGame;
}

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

/**
 * Canonical games for the week (season/week from the ESPN-fed games table)
 * keyed by "away-home" abbreviations, with the latest pre-kickoff trend
 * snapshot per team for overall + venue role. One query each; the slate is
 * at most ~16 games.
 */
async function loadTrends(
	db: Db,
	week: number,
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
	const games = await all<{
		id: string;
		game_time: number;
		home_id: string;
		home_name: string;
		home_abbr: string;
		home_short: string | null;
		away_id: string;
		away_name: string;
		away_abbr: string;
		away_short: string | null;
	}>(
		db,
		`SELECT g.id, g.game_time,
		        ht.id AS home_id, ht.name AS home_name, ht.abbreviation AS home_abbr, ht.short_name AS home_short,
		        at2.id AS away_id, at2.name AS away_name, at2.abbreviation AS away_abbr, at2.short_name AS away_short
		 FROM games g
		 JOIN teams ht ON ht.id = g.home_team_id
		 JOIN teams at2 ON at2.id = g.away_team_id
		 WHERE g.sport_tag = 'nfl' AND g.season = ? AND g.week = ?`,
		NFL_SEASON,
		String(week),
	);
	const out = new Map<
		string,
		{
			away: TeamTrend;
			home: TeamTrend;
			teams: { away: TeamRow; home: TeamRow };
		}
	>();
	if (games.length === 0) return out;
	const teamIds = [...new Set(games.flatMap((g) => [g.home_id, g.away_id]))];
	const snaps = await all<SnapRow>(
		db,
		`SELECT team_id, snapshot_type, as_of_time, su_wins, su_losses, su_pushes, ats_wins, ats_losses, ats_pushes,
		        ou_overs, ou_unders, ou_pushes, ats_streak_type, ats_streak_length, ou_streak_type, ou_streak_length,
		        avg_cover_margin, avg_total_margin
		 FROM team_trend_snapshots
		 WHERE sport_tag = 'nfl' AND snapshot_type IN ('overall','home','away')
		   AND team_id IN (${teamIds.map(() => "?").join(",")})
		 ORDER BY as_of_time DESC`,
		...teamIds,
	);
	const latest = new Map<string, SnapRow>();
	for (const g of games) {
		for (const r of snaps) {
			if (r.as_of_time >= g.game_time) continue; // pre-kickoff only
			const key = `${r.team_id}|${r.snapshot_type}|${g.id}`;
			if (!latest.has(key)) latest.set(key, r);
		}
	}
	for (const g of games) {
		const trend = (
			teamId: string,
			venue: "home" | "away",
			abbr: string,
			name: string,
		): TeamTrend => ({
			abbr,
			name,
			venue,
			overall: toTrendLine(latest.get(`${teamId}|overall|${g.id}`)),
			atVenue: toTrendLine(latest.get(`${teamId}|${venue}|${g.id}`)),
		});
		out.set(`${g.away_abbr.toLowerCase()}-${g.home_abbr.toLowerCase()}`, {
			away: trend(g.away_id, "away", g.away_abbr, g.away_name),
			home: trend(g.home_id, "home", g.home_abbr, g.home_name),
			teams: {
				away: { abbr: g.away_abbr, name: g.away_name, short: g.away_short },
				home: { abbr: g.home_abbr, name: g.home_name, short: g.home_short },
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
	const [slate, trends] = await Promise.all([
		listSlate(db, week),
		loadTrends(db, week),
	]);
	const picks = await all<PickRow>(
		db,
		`SELECT ${PICK_COLS} FROM nfl_board_picks WHERE season = ? ORDER BY event_time ASC`,
		NFL_SEASON,
	);
	const pickByKey = new Map(
		picks
			.filter((p) => p.week === week)
			.map((p) => [`${p.event_slug}|${p.kind}`, toPick(p)]),
	);
	const kindOf = (title: string): MarketKind | null =>
		parseSpreadTitle(title)
			? "spread"
			: parseTotalTitle(title)
				? "total"
				: null;
	const buildLine = (
		eventSlug: string,
		kind: MarketKind,
		markets: SpreadMarket[],
	): BoardLine | null => {
		const main = pickMainLine(markets);
		if (!main) return null;
		let sideA: BoardLine["sideA"];
		let sideB: BoardLine["sideB"];
		if (kind === "spread") {
			const parsed = parseSpreadTitle(main.marketTitle);
			if (!parsed) return null;
			sideA = {
				label: main.sideALabel,
				line: lineForSide(parsed, main.sideALabel),
				price: main.sideAPrice,
			};
			sideB = {
				label: main.sideBLabel,
				line: lineForSide(parsed, main.sideBLabel),
				price: main.sideBPrice,
			};
		} else {
			const parsed = parseTotalTitle(main.marketTitle);
			if (!parsed) return null;
			sideA = {
				label: main.sideALabel,
				line: parsed.line,
				price: main.sideAPrice,
			};
			sideB = {
				label: main.sideBLabel,
				line: parsed.line,
				price: main.sideBPrice,
			};
		}
		return {
			kind,
			conditionId: main.conditionId,
			marketTitle: main.marketTitle,
			sideA,
			sideB,
			signalSide:
				main.sharpSide === "A" || main.sharpSide === "B"
					? main.sharpSide
					: null,
			altLines: markets.length - 1,
			pick: pickByKey.get(`${eventSlug}|${kind}`) ?? null,
		};
	};
	const games: BoardGame[] = [];
	for (const [eventSlug, markets] of slate) {
		const spreads = markets.filter((m) => kindOf(m.marketTitle) === "spread");
		const totals = markets.filter((m) => kindOf(m.marketTitle) === "total");
		const spread = buildLine(eventSlug, "spread", spreads);
		const total = buildLine(eventSlug, "total", totals);
		if (!spread && !total) continue;
		const ref = spread ?? total;
		const matchup =
			parseSpreadTitle(spread?.marketTitle ?? "")?.matchup ??
			parseTotalTitle(total?.marketTitle ?? "")?.matchup ??
			eventSlug;
		const eventTime = markets[0].eventTime;
		const key = slugKey(eventSlug);
		const t = key ? (trends.get(key) ?? null) : null;
		let homeSide: "A" | "B" | null = null;
		if (t && spread) {
			if (labelMatchesTeam(spread.sideA.label, t.teams.home)) homeSide = "A";
			else if (labelMatchesTeam(spread.sideB.label, t.teams.home))
				homeSide = "B";
			else if (labelMatchesTeam(spread.sideA.label, t.teams.away))
				homeSide = "B";
			else if (labelMatchesTeam(spread.sideB.label, t.teams.away))
				homeSide = "A";
		}
		games.push({
			eventSlug,
			matchup,
			eventTime,
			locked: eventTime <= now,
			spread,
			total,
			away: t?.away ?? null,
			home: t?.home ?? null,
			homeSide,
		});
		void ref;
	}
	// Picks whose market has left the cache (past games) still belong to the week's list.
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
		const m = await first<{
			condition_id: string;
			event_slug: string;
			market_title: string;
			event_time: string | null;
			side_a_label: string | null;
			side_b_label: string | null;
			side_a_price: number | null;
			side_b_price: number | null;
			sharp_side: string | null;
		}>(
			db,
			`SELECT condition_id, event_slug, market_title, event_time, side_a_label, side_b_label,
			        side_a_price, side_b_price, sharp_side
			 FROM sharp_money_cache WHERE condition_id = ? AND event_slug LIKE 'nfl-%'`,
			data.conditionId,
		);
		if (!m || !m.event_time) return { error: "market_not_found" as const };
		const eventTime = Math.floor(Date.parse(m.event_time) / 1000);
		if (!Number.isFinite(eventTime))
			return { error: "market_not_found" as const };
		if (eventTime <= now) return { error: "locked" as const };
		const spreadTitle = parseSpreadTitle(m.market_title);
		const totalTitle = spreadTitle ? null : parseTotalTitle(m.market_title);
		if (!spreadTitle && !totalTitle) return { error: "not_a_spread" as const };
		const kind: MarketKind = spreadTitle ? "spread" : "total";
		const label = data.side === "A" ? m.side_a_label : m.side_b_label;
		const price = data.side === "A" ? m.side_a_price : m.side_b_price;
		if (!label || typeof price !== "number" || !(price > 0 && price < 1)) {
			return { error: "no_price" as const };
		}
		const week = nflWeekOf(eventTime);
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
			m.event_slug,
			kind,
			m.condition_id,
			m.market_title,
			spreadTitle ? spreadTitle.matchup : (totalTitle?.matchup ?? m.event_slug),
			data.side,
			label,
			spreadTitle ? lineForSide(spreadTitle, label) : (totalTitle?.line ?? 0),
			price,
			eventTime,
			now,
			m.sharp_side === "A" || m.sharp_side === "B" ? m.sharp_side : null,
			m.sharp_side === "A"
				? m.side_a_price
				: m.sharp_side === "B"
					? m.side_b_price
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
