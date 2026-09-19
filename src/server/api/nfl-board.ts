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
	NFL_SEASON,
	nflWeekBounds,
	nflWeekOf,
	parseSpreadTitle,
	pickMainLine,
	type SpreadMarket,
} from "../../lib/nfl-board";
import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { getDb, nowUnixSeconds } from "../env";
import { fetchGammaMarket, resolvePickResult } from "./manual-picks";

export interface BoardGame {
	eventSlug: string;
	matchup: string;
	eventTime: number;
	locked: boolean;
	conditionId: string;
	marketTitle: string;
	sideA: { label: string; line: number; price: number | null };
	sideB: { label: string; line: number; price: number | null };
	/** The holder pipeline's sighted side on this market, if any (benchmark only). */
	signalSide: string | null;
	altLines: number;
	pick: BoardPick | null;
}

export interface BoardPick {
	id: string;
	week: number;
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

const PICK_COLS = `id, week, event_slug, condition_id, matchup, side, side_label, line, price,
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
		   AND market_title LIKE '%: Spread: %'
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

async function loadBoard(db: Db, week: number) {
	const now = nowUnixSeconds();
	const slate = await listSlate(db, week);
	const picks = await all<PickRow>(
		db,
		`SELECT ${PICK_COLS} FROM nfl_board_picks WHERE season = ? ORDER BY event_time ASC`,
		NFL_SEASON,
	);
	const pickBySlug = new Map(
		picks.filter((p) => p.week === week).map((p) => [p.event_slug, toPick(p)]),
	);
	const games: BoardGame[] = [];
	for (const [eventSlug, markets] of slate) {
		const main = pickMainLine(markets);
		if (!main) continue;
		const parsed = parseSpreadTitle(main.marketTitle);
		if (!parsed) continue;
		games.push({
			eventSlug,
			matchup: parsed.matchup,
			eventTime: main.eventTime,
			locked: main.eventTime <= now,
			conditionId: main.conditionId,
			marketTitle: main.marketTitle,
			sideA: {
				label: main.sideALabel,
				line: lineForSide(parsed, main.sideALabel),
				price: main.sideAPrice,
			},
			sideB: {
				label: main.sideBLabel,
				line: lineForSide(parsed, main.sideBLabel),
				price: main.sideBPrice,
			},
			signalSide:
				main.sharpSide === "A" || main.sharpSide === "B"
					? main.sharpSide
					: null,
			altLines: markets.length - 1,
			pick: pickBySlug.get(eventSlug) ?? null,
		});
	}
	// Picks whose market has left the cache (past games) still belong to the week's list.
	for (const p of pickBySlug.values()) {
		if (!games.some((g) => g.eventSlug === p.eventSlug)) {
			games.push({
				eventSlug: p.eventSlug,
				matchup: p.matchup,
				eventTime: p.eventTime,
				locked: true,
				conditionId: p.conditionId,
				marketTitle: "",
				sideA: {
					label: p.side === "A" ? p.sideLabel : "—",
					line: p.side === "A" ? p.line : -p.line,
					price: null,
				},
				sideB: {
					label: p.side === "B" ? p.sideLabel : "—",
					line: p.side === "B" ? p.line : -p.line,
					price: null,
				},
				signalSide: p.signalSide,
				altLines: 0,
				pick: p,
			});
		}
	}
	games.sort(
		(a, b) => a.eventTime - b.eventTime || a.matchup.localeCompare(b.matchup),
	);
	const statRows: BoardPickRow[] = picks.map((p) => ({
		week: p.week,
		side: p.side,
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
		const parsed = parseSpreadTitle(m.market_title);
		if (!parsed) return { error: "not_a_spread" as const };
		const label = data.side === "A" ? m.side_a_label : m.side_b_label;
		const price = data.side === "A" ? m.side_a_price : m.side_b_price;
		if (!label || typeof price !== "number" || !(price > 0 && price < 1)) {
			return { error: "no_price" as const };
		}
		const week = nflWeekOf(eventTime);
		const id = `nflb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		await run(
			db,
			`INSERT INTO nfl_board_picks (id, season, week, event_slug, condition_id, market_title, matchup,
			   side, side_label, line, price, event_time, picked_at, signal_side, signal_price, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
			 ON CONFLICT(event_slug) DO UPDATE SET
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
			m.condition_id,
			m.market_title,
			parsed.matchup,
			data.side,
			label,
			lineForSide(parsed, label),
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
	.inputValidator((d: { eventSlug: string }) => d)
	.handler(async ({ context, data }) => {
		const db = getDb(context);
		if (typeof data?.eventSlug !== "string")
			return { error: "invalid_payload" as const };
		await run(
			db,
			`DELETE FROM nfl_board_picks WHERE event_slug = ? AND status = 'pending' AND event_time > ?`,
			data.eventSlug,
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
