/**
 * Line ingestion — populates game_lines with open/close spread and total snapshots.
 *
 * Extracts line values from Polymarket market titles and pick data.
 * When no external odds feed exists, uses pick prices and sharp_money_history
 * as proxy for lines.
 *
 * Assumption: In the absence of an external odds API, spread and total lines
 * are extracted from market titles (e.g., "Chiefs -3.5", "Over 47.5").
 * This is a best-effort approach — lines may not match real-world closing lines.
 */

import type { Db } from "../db/client";
import { upsertGameLine } from "../repositories/game-lines";
import type { GameLine, SnapshotType } from "../types/canonical";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for ingesting a line from market data. */
export interface MarketLineInput {
	/** Canonical game ID this line belongs to */
	gameId: string;
	/** Market title (used to extract spread/total) */
	marketTitle: string;
	/** Snapshot type: "open" or "close" */
	snapshotType: SnapshotType;
	/** Source of the line data (e.g., "polymarket", "consensus") */
	source?: string;
	/** When the line was recorded (unix seconds) */
	recordedAt?: number;
	/** Explicit home spread override (if known from external source) */
	homeSpread?: number;
	/** Explicit total line override (if known from external source) */
	totalLine?: number;
	/** Home moneyline (if available) */
	homeMoneyline?: number;
	/** Away moneyline (if available) */
	awayMoneyline?: number;
}

export interface LineIngestionResult {
	gameLine: GameLine;
	parsedSpread?: number;
	parsedTotal?: number;
	source: string;
}

// ---------------------------------------------------------------------------
// Line extraction from market titles
// ---------------------------------------------------------------------------

const GAME_PROP_KEYWORDS = [
	"nrfi",
	"yrfi",
	"btts",
	"both teams to score",
	"draw no bet",
	"first goal",
	"clean sheet",
	"double result",
	// Polymarket titles NRFI/YRFI markets as a question, not an abbreviation:
	// "Will there be a run scored in the first inning?: Twins vs. Royals"
	"first inning",
	"1st inning",
	// "Seahawks Team Total: O/U 25.5" contains "total"/"o/u", so without
	// this it reads as the game total.
	"team total",
];

// Period/derivative markets — "Seahawks vs. Patriots: 1H O/U 23.5",
// "1H Spread: Seahawks (-3.5)", "Miami vs. Indiana: 1H Moneyline". These
// carry full-game keywords and would score through full-game models
// (a 1H line vs a full-game totals model) if classified by those keywords.
const PERIOD_MARKET_PATTERN =
	/\b(?:[12]h|[1-4]q|(?:1st|first) half|(?:2nd|second) half|(?:1st|2nd|3rd|4th) quarter|halftime)\b/i;

/**
 * Classifies a market title into a bet type. Shared by the candidate scan
 * (grading, policy segments) and the shadow book (rejected-candidate rows).
 */
export function getMarketTypeLabel(
	marketTitle: string,
): "total" | "spread" | "moneyline" | "prop" | "other" {
	const lower = marketTitle.toLowerCase();
	// Prop patterns must win over the core-type keywords: team totals and
	// period markets contain "total"/"o/u"/"spread"/"moneyline" and would
	// otherwise classify as pickable full-game markets (era v7).
	if (
		GAME_PROP_KEYWORDS.some((kw) => lower.includes(kw)) ||
		PERIOD_MARKET_PATTERN.test(marketTitle)
	) {
		return "prop";
	}
	const plainMatchup =
		!marketTitle.includes(":") && /\bvs\.?\b/i.test(marketTitle);
	if (
		lower.includes("o/u") ||
		lower.includes("over/under") ||
		lower.includes("total")
	) {
		return "total";
	}
	if (lower.includes("spread")) return "spread";
	if (plainMatchup) return "moneyline";
	if (lower.includes("moneyline") || lower.includes("ml")) return "moneyline";
	return "other";
}

/**
 * Extracts a spread value from a market title.
 *
 * Examples:
 *   "Chiefs -3.5 vs Broncos" → -3.5 (home perspective if Chiefs are home)
 *   "Lions +7 at Bears" → +7
 *   "Ravens -6.5" → -6.5
 *
 * Returns the raw numeric spread as found in the title (team perspective).
 * The caller must assign home/away perspective based on team position.
 */
export function extractSpreadFromTitle(title: string): number | null {
	const explicitSpreadMatch = title.match(
		/(?:^|:\s*)spread:\s*.+?\(\s*([-+]\d+(?:\.\d+)?)\s*\)/i,
	);
	if (explicitSpreadMatch) {
		const value = Number.parseFloat(explicitSpreadMatch[1]);
		if (Number.isFinite(value)) return value;
	}

	// Match patterns like "Team -3.5" or "Team +7" or "Team -3"
	const spreadMatch = title.match(
		/\b([A-Za-z]+(?:\s+[A-Za-z]+)*)\s+([-+]\d+(?:\.\d+)?)\b/,
	);
	if (spreadMatch) {
		const value = Number.parseFloat(spreadMatch[2]);
		if (Number.isFinite(value)) return value;
	}
	return null;
}

/**
 * Extracts a total line from a market title.
 *
 * Examples:
 *   "Chiefs vs Broncos: Over 47.5" → 47.5
 *   "Over/Under 210.5" → 210.5
 *   "Total Points: 42.5" → 42.5
 */
export function extractTotalFromTitle(title: string): number | null {
	// "Over X.X" or "Under X.X"
	const ouMatch = title.match(/\b(?:over|under|o\/u)\s+(\d+(?:\.\d+)?)\b/i);
	if (ouMatch) {
		const value = Number.parseFloat(ouMatch[1]);
		if (Number.isFinite(value)) return value;
	}

	// "Total X.X" or "Total Points: X.X"
	const totalMatch = title.match(
		/\btotal(?:\s+points?)?\s*:?\s*(\d+(?:\.\d+)?)\b/i,
	);
	if (totalMatch) {
		const value = Number.parseFloat(totalMatch[1]);
		if (Number.isFinite(value)) return value;
	}

	return null;
}

/**
 * Determines if the spread in the title belongs to the away or home team.
 * Uses "Away @ Home" / "Away vs Home" convention.
 *
 * Returns "first" if the spread is on the first-listed team (away),
 * "second" for the second-listed team (home), or null if indeterminate.
 */
export function identifySpreadTeamPosition(
	title: string,
): "first" | "second" | null {
	// Split on vs/at/@
	const parts = title.split(/\s+(?:vs\.?|at|@)\s+/i);
	if (parts.length !== 2) return null;

	const explicitSpreadLabel = title.match(
		/(?:^|:\s*)spread:\s*(.+?)\s*\([-+]\d+(?:\.\d+)?\)/i,
	)?.[1];
	if (explicitSpreadLabel) {
		const normalizedLabel = explicitSpreadLabel.trim().toLowerCase();
		const firstTeam = parts[0].split(":")[0]?.trim().toLowerCase() ?? "";
		const secondTeam = parts[1].split(":")[0]?.trim().toLowerCase() ?? "";
		const matchesFirst =
			firstTeam.includes(normalizedLabel) ||
			normalizedLabel.includes(firstTeam);
		const matchesSecond =
			secondTeam.includes(normalizedLabel) ||
			normalizedLabel.includes(secondTeam);
		if (matchesFirst && !matchesSecond) return "first";
		if (matchesSecond && !matchesFirst) return "second";
	}

	const firstHasSpread = /[-+]\d+(?:\.\d+)?/.test(parts[0]);
	const secondHasSpread = /[-+]\d+(?:\.\d+)?/.test(parts[1]);

	if (firstHasSpread && !secondHasSpread) return "first";
	if (secondHasSpread && !firstHasSpread) return "second";
	return null;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Ingests a game line from market data.
 *
 * If explicit homeSpread/totalLine are provided, uses those directly.
 * Otherwise, attempts to parse from the market title.
 *
 * Spread perspective: The extracted spread is assigned to home_spread.
 * If the spread was on the first-listed team (away in "Away vs Home"),
 * the home spread is the negation.
 */
export async function ingestLineFromMarket(
	db: Db,
	input: MarketLineInput,
): Promise<LineIngestionResult | null> {
	const source = input.source ?? "polymarket";

	let homeSpread = input.homeSpread ?? null;
	let awaySpread: number | null = null;
	let totalLine = input.totalLine ?? null;

	// Parse from title if not provided explicitly
	const parsedSpread = extractSpreadFromTitle(input.marketTitle);
	const parsedTotal = extractTotalFromTitle(input.marketTitle);

	if (homeSpread === null && parsedSpread !== null) {
		// Determine which team the spread belongs to
		const position = identifySpreadTeamPosition(input.marketTitle);
		if (position === "first") {
			// Spread is on the away team → home spread is the negation
			awaySpread = parsedSpread;
			homeSpread = -parsedSpread;
		} else {
			// Spread is on the home team (or indeterminate — assume home)
			homeSpread = parsedSpread;
			awaySpread = -parsedSpread;
		}
	} else if (homeSpread !== null) {
		awaySpread = -homeSpread;
	}

	if (totalLine === null && parsedTotal !== null) {
		totalLine = parsedTotal;
	}

	// Need at least one line value to persist
	if (homeSpread === null && totalLine === null) {
		return null;
	}

	const gameLine = await upsertGameLine(db, {
		gameId: input.gameId,
		snapshotType: input.snapshotType,
		source,
		homeSpread: homeSpread ?? undefined,
		awaySpread: awaySpread ?? undefined,
		totalLine: totalLine ?? undefined,
		homeMoneyline: input.homeMoneyline,
		awayMoneyline: input.awayMoneyline,
		recordedAt: input.recordedAt,
	});

	return {
		gameLine,
		parsedSpread: parsedSpread ?? undefined,
		parsedTotal: parsedTotal ?? undefined,
		source,
	};
}

// ---------------------------------------------------------------------------
// Batch ingestion
// ---------------------------------------------------------------------------

export interface BatchLineIngestionResult {
	ingested: number;
	skipped: number;
	errors: number;
	details: Array<{
		gameId: string;
		snapshotType: SnapshotType;
		status: "ingested" | "skipped" | "error";
		reason?: string;
	}>;
}

/**
 * Ingests multiple lines in batch.
 */
export async function batchIngestLines(
	db: Db,
	inputs: MarketLineInput[],
): Promise<BatchLineIngestionResult> {
	const result: BatchLineIngestionResult = {
		ingested: 0,
		skipped: 0,
		errors: 0,
		details: [],
	};

	for (const input of inputs) {
		try {
			const ingested = await ingestLineFromMarket(db, input);
			if (ingested) {
				result.ingested++;
				result.details.push({
					gameId: input.gameId,
					snapshotType: input.snapshotType,
					status: "ingested",
				});
			} else {
				result.skipped++;
				result.details.push({
					gameId: input.gameId,
					snapshotType: input.snapshotType,
					status: "skipped",
					reason: "No spread or total could be extracted",
				});
			}
		} catch (err) {
			result.errors++;
			result.details.push({
				gameId: input.gameId,
				snapshotType: input.snapshotType,
				status: "error",
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return result;
}
