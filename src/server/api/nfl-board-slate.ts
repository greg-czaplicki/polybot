/**
 * NFL board slate refresher (2026-09-19). The holder pipeline's cache only
 * holds markets above its $10k volume floor, which drops most game totals
 * until Sunday. The board instead snapshots the week's games straight from
 * Gamma: per event the highest-liquidity spread, game total and moneyline.
 * The events payload is ~0.8 MB per game, so it is fetched in small pages
 * and reduced immediately, and refreshed at most every 20 minutes.
 */

import { NFL_SEASON, nflWeekOf } from "../../lib/nfl-board";
import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import { getSeriesRegistrySnapshot } from "./series-registry";

const GAMMA = "https://gamma-api.polymarket.com";
const PAGE = 6;
const MAX_PAGES = 6;
export const SLATE_MAX_AGE_SECONDS = 20 * 60;

interface GammaMarket {
	conditionId?: string;
	question?: string;
	sportsMarketType?: string;
	line?: number | string | null;
	outcomes?: string;
	outcomePrices?: string;
	liquidity?: string | number;
	gameStartTime?: string;
	active?: boolean;
	closed?: boolean;
}
interface GammaEvent {
	slug?: string;
	title?: string;
	startTime?: string;
	endDate?: string;
	eventWeek?: number | string;
	teams?: Array<{ abbreviation?: string; name?: string }>;
	markets?: GammaMarket[];
}

function num(v: unknown): number | null {
	const n =
		typeof v === "number"
			? v
			: typeof v === "string"
				? Number.parseFloat(v)
				: Number.NaN;
	return Number.isFinite(n) ? n : null;
}
function parseList(v: string | undefined): string[] {
	try {
		const arr = JSON.parse(v ?? "[]");
		return Array.isArray(arr) ? arr.map(String) : [];
	} catch {
		return [];
	}
}
function best(
	markets: GammaMarket[],
	type: string,
): { m: GammaMarket; alts: number } | null {
	const list = markets.filter(
		(m) =>
			m.sportsMarketType === type &&
			m.active !== false &&
			m.closed !== true &&
			m.conditionId,
	);
	if (list.length === 0) return null;
	list.sort((a, b) => (num(b.liquidity) ?? 0) - (num(a.liquidity) ?? 0));
	return { m: list[0], alts: list.length - 1 };
}
function kickoffOf(e: GammaEvent): number | null {
	const raw =
		e.startTime ??
		e.markets?.find((m) => m.gameStartTime)?.gameStartTime ??
		e.endDate;
	if (!raw) return null;
	const t = Date.parse(raw.replace(" ", "T").replace(/\+00$/, "Z"));
	return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function nflSeriesIds(): number[] {
	const ids: number[] = [];
	for (const [id, tag] of getSeriesRegistrySnapshot().idToTag)
		if (tag === "nfl") ids.push(id);
	return ids.length > 0 ? ids : [12185];
}

/** Newest refresh stamp for a week (null when nothing stored). */
export async function slateUpdatedAt(
	db: Db,
	week: number,
): Promise<number | null> {
	const r = await first<{ t: number | null }>(
		db,
		`SELECT MAX(updated_at) AS t FROM nfl_board_slate WHERE season = ? AND week = ?`,
		NFL_SEASON,
		week,
	);
	return r?.t ?? null;
}

/**
 * Fetch open NFL events from Gamma and upsert one slate row per game.
 * Returns the number of games written. Never throws on a bad page; a
 * partial refresh still stamps the rows it managed to read.
 */
export async function refreshNflBoardSlate(
	db: Db,
): Promise<{ games: number; pages: number }> {
	const now = nowUnixSeconds();
	let games = 0;
	let pages = 0;
	for (const seriesId of nflSeriesIds()) {
		for (let page = 0; page < MAX_PAGES; page += 1) {
			const url = `${GAMMA}/events?series_id=${seriesId}&closed=false&limit=${PAGE}&offset=${page * PAGE}&order=startDate&ascending=true`;
			let events: GammaEvent[] = [];
			try {
				const res = await fetch(url, {
					headers: { accept: "application/json" },
				});
				if (!res.ok) break;
				events = (await res.json()) as GammaEvent[];
			} catch (error) {
				console.warn("[nfl-board] slate page failed", url, error);
				break;
			}
			pages += 1;
			for (const e of events) {
				const slug = e.slug ?? "";
				const kickoff = kickoffOf(e);
				if (!/^nfl-/.test(slug) || kickoff === null) continue;
				const markets = e.markets ?? [];
				const spread = best(markets, "spreads");
				const total = best(markets, "totals");
				const ml = best(markets, "moneyline");
				if (!spread && !total) continue;
				const sp = spread ? parseList(spread.m.outcomePrices) : [];
				const so = spread ? parseList(spread.m.outcomes) : [];
				const tp = total ? parseList(total.m.outcomePrices) : [];
				const mp = ml ? parseList(ml.m.outcomePrices) : [];
				const mo = ml ? parseList(ml.m.outcomes) : [];
				const teams = e.teams ?? [];
				await run(
					db,
					`INSERT INTO nfl_board_slate (event_slug, season, week, kickoff, title, away_abbr, home_abbr, away_name, home_name,
					   spread_condition_id, spread_question, spread_line, spread_a_label, spread_b_label, spread_a_price, spread_b_price, spread_alts,
					   total_condition_id, total_question, total_line, total_a_price, total_b_price, total_alts,
					   ml_condition_id, ml_a_label, ml_b_label, ml_a_price, ml_b_price, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(event_slug) DO UPDATE SET
					   week = excluded.week, kickoff = excluded.kickoff, title = excluded.title,
					   away_abbr = excluded.away_abbr, home_abbr = excluded.home_abbr, away_name = excluded.away_name, home_name = excluded.home_name,
					   spread_condition_id = excluded.spread_condition_id, spread_question = excluded.spread_question, spread_line = excluded.spread_line,
					   spread_a_label = excluded.spread_a_label, spread_b_label = excluded.spread_b_label,
					   spread_a_price = excluded.spread_a_price, spread_b_price = excluded.spread_b_price, spread_alts = excluded.spread_alts,
					   total_condition_id = excluded.total_condition_id, total_question = excluded.total_question, total_line = excluded.total_line,
					   total_a_price = excluded.total_a_price, total_b_price = excluded.total_b_price, total_alts = excluded.total_alts,
					   ml_condition_id = excluded.ml_condition_id, ml_a_label = excluded.ml_a_label, ml_b_label = excluded.ml_b_label,
					   ml_a_price = excluded.ml_a_price, ml_b_price = excluded.ml_b_price, updated_at = excluded.updated_at`,
					slug,
					NFL_SEASON,
					nflWeekOf(kickoff),
					kickoff,
					e.title ?? slug,
					teams[0]?.abbreviation?.toUpperCase() ?? null,
					teams[1]?.abbreviation?.toUpperCase() ?? null,
					teams[0]?.name ?? null,
					teams[1]?.name ?? null,
					spread?.m.conditionId ?? null,
					spread?.m.question ?? null,
					spread ? num(spread.m.line) : null,
					so[0] ?? null,
					so[1] ?? null,
					num(sp[0]),
					num(sp[1]),
					spread?.alts ?? 0,
					total?.m.conditionId ?? null,
					total?.m.question ?? null,
					total ? num(total.m.line) : null,
					num(tp[0]),
					num(tp[1]),
					total?.alts ?? 0,
					ml?.m.conditionId ?? null,
					mo[0] ?? null,
					mo[1] ?? null,
					num(mp[0]),
					num(mp[1]),
					now,
				);
				games += 1;
			}
			if (events.length < PAGE) break;
		}
	}
	return { games, pages };
}

export interface SlateRow {
	event_slug: string;
	week: number;
	kickoff: number;
	title: string;
	away_abbr: string | null;
	home_abbr: string | null;
	away_name: string | null;
	home_name: string | null;
	spread_condition_id: string | null;
	spread_question: string | null;
	spread_line: number | null;
	spread_a_label: string | null;
	spread_b_label: string | null;
	spread_a_price: number | null;
	spread_b_price: number | null;
	spread_alts: number;
	total_condition_id: string | null;
	total_question: string | null;
	total_line: number | null;
	total_a_price: number | null;
	total_b_price: number | null;
	total_alts: number;
	updated_at: number;
}

export async function listSlateRows(db: Db, week: number): Promise<SlateRow[]> {
	return all<SlateRow>(
		db,
		`SELECT * FROM nfl_board_slate WHERE season = ? AND week = ? ORDER BY kickoff, event_slug`,
		NFL_SEASON,
		week,
	);
}

export async function getSlateRowByCondition(
	db: Db,
	conditionId: string,
): Promise<SlateRow | null> {
	return first<SlateRow>(
		db,
		`SELECT * FROM nfl_board_slate WHERE spread_condition_id = ? OR total_condition_id = ? LIMIT 1`,
		conditionId,
		conditionId,
	);
}
