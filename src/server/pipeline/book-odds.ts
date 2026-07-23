/**
 * Sportsbook anchor capture — de-vigged DraftKings odds (via ESPN pickcenter)
 * snapshotted onto picks as diagnostic columns.
 *
 * Two capture points:
 *  - Pick time: captureBookAnchorForGame, called from inline enrichment. Live
 *    ESPN summary fetch when the game has an espn_event_id; falls back to the
 *    game_lines row (first-observed line, source "game_lines_stale") with the
 *    row's own recorded_at so staleness stays visible.
 *  - Close: captureBookClosesForPicks, a scheduled sweep over settled picks.
 *    ESPN's pickcenter is frozen at the closing line once a game ends, so a
 *    post-game fetch is a true book close.
 *
 * De-vig is two-way multiplicative: fair = implied(side) / (implied(side) +
 * implied(opp)). fair-prob/EV/CLV fields are only populated for moneyline
 * picks with a home/away venue role — an ML fair prob says nothing about a
 * totals or spread pick's side. Totals and spread picks still get the book's
 * line numbers for line-movement analysis.
 *
 * book_clv = book_close_fair_prob − entry price: positive means the price we
 * paid was below the de-vigged book close (same sign convention as clv).
 */

import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import {
	type EspnPickcenterEntry,
	fetchEspnSummary,
	selectPickcenterEntry,
} from "./espn-schedule-ingestion";

export function americanToImpliedProb(ml: number): number | null {
	if (!Number.isFinite(ml) || ml === 0) return null;
	return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
}

export function devigTwoWay(mlSide: number, mlOpp: number): number | null {
	const side = americanToImpliedProb(mlSide);
	const opp = americanToImpliedProb(mlOpp);
	if (side === null || opp === null) return null;
	const overround = side + opp;
	if (overround <= 0) return null;
	return side / overround;
}

interface BookOdds {
	homeSpread: number | null;
	totalLine: number | null;
	homeMoneyline: number | null;
	awayMoneyline: number | null;
}

function toFiniteOrNull(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function oddsFromPickcenter(entry: EspnPickcenterEntry): BookOdds {
	return {
		homeSpread: toFiniteOrNull(entry.spread),
		totalLine: toFiniteOrNull(entry.overUnder),
		homeMoneyline: toFiniteOrNull(entry.homeTeamOdds?.moneyLine),
		awayMoneyline: toFiniteOrNull(entry.awayTeamOdds?.moneyLine),
	};
}

function mapMoneylinesToPick(
	odds: BookOdds,
	venueRole: string | null | undefined,
): { mlSide: number; mlOpp: number } | null {
	if (venueRole !== "home" && venueRole !== "away") return null;
	const mlSide = venueRole === "home" ? odds.homeMoneyline : odds.awayMoneyline;
	const mlOpp = venueRole === "home" ? odds.awayMoneyline : odds.homeMoneyline;
	if (mlSide === null || mlOpp === null || mlSide === 0 || mlOpp === 0) {
		return null;
	}
	return { mlSide, mlOpp };
}

export interface BookAnchor {
	source: string;
	capturedAt: number;
	mlSide: number | null;
	mlOpp: number | null;
	fairProb: number | null;
	ev: number | null;
	spreadLine: number | null;
	totalLine: number | null;
}

export async function captureBookAnchorForGame(
	db: Db,
	input: {
		gameId: string;
		venueRole: string | null;
		betType: string | null;
		entryPrice: number | null;
	},
): Promise<BookAnchor | null> {
	const game = await first<{
		espn_event_id: string | null;
		sport_tag: string;
	}>(
		db,
		`SELECT espn_event_id, sport_tag FROM games WHERE id = ?`,
		input.gameId,
	);
	if (!game) return null;

	let odds: BookOdds | null = null;
	let source = "espn_draftkings";
	let capturedAt = nowUnixSeconds();

	if (game.espn_event_id) {
		const summary = await fetchEspnSummary(game.sport_tag, game.espn_event_id);
		const entry = summary ? selectPickcenterEntry(summary) : null;
		if (entry) odds = oddsFromPickcenter(entry);
	}

	if (!odds) {
		const row = await first<{
			home_spread: number | null;
			total_line: number | null;
			home_moneyline: number | null;
			away_moneyline: number | null;
			recorded_at: number | null;
		}>(
			db,
			`SELECT home_spread, total_line, home_moneyline, away_moneyline, recorded_at
			 FROM game_lines
			 WHERE game_id = ?
			 ORDER BY CASE snapshot_type WHEN 'close' THEN 0 ELSE 1 END
			 LIMIT 1`,
			input.gameId,
		);
		if (!row) return null;
		odds = {
			homeSpread: toFiniteOrNull(row.home_spread),
			totalLine: toFiniteOrNull(row.total_line),
			homeMoneyline: toFiniteOrNull(row.home_moneyline),
			awayMoneyline: toFiniteOrNull(row.away_moneyline),
		};
		source = "game_lines_stale";
		capturedAt = row.recorded_at ?? capturedAt;
	}

	const mapped =
		input.betType === "moneyline"
			? mapMoneylinesToPick(odds, input.venueRole)
			: null;
	const fairProb = mapped ? devigTwoWay(mapped.mlSide, mapped.mlOpp) : null;
	const ev =
		fairProb !== null && input.entryPrice !== null && input.entryPrice > 0
			? fairProb / input.entryPrice - 1
			: null;

	return {
		source,
		capturedAt,
		mlSide: mapped?.mlSide ?? null,
		mlOpp: mapped?.mlOpp ?? null,
		fairProb,
		ev,
		spreadLine: odds.homeSpread,
		totalLine: odds.totalLine,
	};
}

/**
 * Backfills book_close_* on settled picks that don't have it yet. One ESPN
 * summary fetch per pick; only picks whose game carries an espn_event_id
 * qualify (stamped by schedule ingestion from 2026-07-23 onward), which
 * naturally excludes the pre-anchor backlog.
 */
export async function captureBookClosesForPicks(
	db: Db,
	options?: { limit?: number },
): Promise<{ checked: number; updated: number }> {
	const limit =
		typeof options?.limit === "number" && options.limit > 0
			? Math.min(options.limit, 25)
			: 8;
	const rows = await all<{
		id: string;
		price: number | null;
		venue_role: string | null;
		bet_type: string | null;
		status: string;
		espn_event_id: string;
		sport_tag: string;
	}>(
		db,
		`SELECT p.id, p.price, p.venue_role, p.bet_type, p.status,
		        g.espn_event_id, g.sport_tag
		 FROM manual_picks p
		 JOIN games g ON g.id = p.game_id
		 WHERE p.status != 'pending'
		   AND p.book_close_captured_at IS NULL
		   AND g.espn_event_id IS NOT NULL
		 ORDER BY p.picked_at DESC
		 LIMIT ?`,
		limit,
	);
	if (rows.length === 0) return { checked: 0, updated: 0 };

	let updated = 0;
	for (const row of rows) {
		const summary = await fetchEspnSummary(row.sport_tag, row.espn_event_id);
		// Network/API failure: leave untouched so the next sweep retries.
		if (!summary) continue;
		const now = nowUnixSeconds();
		const entry = selectPickcenterEntry(summary);
		if (!entry) {
			// Pickcenter absent post-game is permanent; stamp captured_at with
			// null fields so this pick doesn't burn a fetch every sweep.
			await run(
				db,
				`UPDATE manual_picks SET book_close_captured_at = ? WHERE id = ?`,
				now,
				row.id,
			);
			updated += 1;
			continue;
		}
		const odds = oddsFromPickcenter(entry);
		const mapped =
			row.bet_type === "moneyline"
				? mapMoneylinesToPick(odds, row.venue_role)
				: null;
		const closeFairProb = mapped
			? devigTwoWay(mapped.mlSide, mapped.mlOpp)
			: null;
		const entryPrice =
			typeof row.price === "number" && row.price > 0 ? row.price : null;
		const bookClv =
			row.status !== "push" && closeFairProb !== null && entryPrice !== null
				? closeFairProb - entryPrice
				: null;
		await run(
			db,
			`UPDATE manual_picks SET
				book_close_captured_at = ?,
				book_close_ml_side = ?,
				book_close_ml_opp = ?,
				book_close_fair_prob = ?,
				book_close_spread_line = ?,
				book_close_total_line = ?,
				book_clv = ?
			 WHERE id = ?`,
			now,
			mapped?.mlSide ?? null,
			mapped?.mlOpp ?? null,
			closeFairProb,
			odds.homeSpread,
			odds.totalLine,
			bookClv,
			row.id,
		);
		updated += 1;
	}
	return { checked: rows.length, updated };
}
