/**
 * Pick backfill — populates manual_picks linkage columns from canonical entities.
 *
 * For each manual_pick, attempts to:
 * 1. Detect bet_type from market title
 * 2. Detect sport_tag from market title / decision_snapshot
 * 3. Resolve team_id / opponent_id from canonical teams via alias lookup
 * 4. Match game_id from canonical games by teams + event_time
 * 5. Copy spread_line / total_line from game_lines
 * 6. Derive venue_role and fav_dog_role from canonical context
 * 7. Copy actual_margin / actual_total from team_game_facts (when available)
 *
 * Assumptions:
 * - decision_snapshot_json may contain eventSlug, marketTitle, eventTime
 * - Side labels from sharp_money_cache are used for team resolution
 * - actual_margin / actual_total will be null for most picks until a score
 *   feed is integrated (known limitation)
 * - Side-to-venue conventions are market-type dependent (2026-07-23 recon):
 *   moneyline side_a = first-listed (away) team; spread side_a = the team
 *   NAMED in the title (no venue guarantee); totals sides are Over/Under and
 *   get no team linkage. resolvePickedSide encodes this.
 */

import { detectBetType } from "@/lib/markets";
import { detectSportTag, toCanonicalSportTag } from "@/lib/sports";
import { resolveSportTagFromSeriesId } from "../api/series-registry";
import type { Db } from "../db/client";
import { all, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import type { FavDogRole, VenueRole } from "../types/canonical";
import {
	deriveFavDogRole,
	extractSpreadPickedLabel,
	findGameForPick,
	getFactValues,
	getLineValues,
	getSideLabels,
	mapPickedTeamToSide,
	resolvePickedSide,
} from "./pick-enrichment-helpers";
import { parseTeamsFromTitle, resolveSingleTeam } from "./team-seeder";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw manual_picks row (subset of columns needed for backfill). */
interface ManualPickRow {
	id: string;
	condition_id: string;
	market_title: string | null;
	event_time: string | null;
	decision_snapshot_json: string | null;
	game_id: string | null;
	team_id: string | null;
	opponent_id: string | null;
	bet_type: string | null;
	sport_tag: string | null;
	sharp_side: string | null;
	venue_role: string | null;
	fav_dog_role: string | null;
	spread_line: number | null;
	total_line: number | null;
	actual_margin: number | null;
	actual_total: number | null;
}

/** Parsed decision snapshot fields we care about. */
interface DecisionSnapshotFields {
	eventSlug?: string;
	marketTitle?: string;
	eventTime?: string;
	sportSeriesId?: number;
	sharpSideLabel?: string;
	selectedOutcome?: string;
}

/** Result stats for the backfill run. */
export interface BackfillResult {
	total: number;
	updated: number;
	skipped: number;
	errors: number;
	changedFieldCounts: Record<string, number>;
	failureReasonCounts: Record<string, number>;
	details: Array<{
		pickId: string;
		status: "updated" | "skipped" | "error";
		reason?: string;
		fieldsSet: string[];
		failureReasons?: string[];
	}>;
}

export interface BackfillOptions {
	mode?: "incremental" | "full";
	repairWindowHours?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDecisionSnapshot(
	raw: string | null,
): DecisionSnapshotFields | null {
	if (!raw) return null;
	try {
		const obj = JSON.parse(raw) as Record<string, unknown>;
		return {
			eventSlug: typeof obj.eventSlug === "string" ? obj.eventSlug : undefined,
			marketTitle:
				typeof obj.marketTitle === "string" ? obj.marketTitle : undefined,
			eventTime: typeof obj.eventTime === "string" ? obj.eventTime : undefined,
			sportSeriesId:
				typeof obj.sportSeriesId === "number" ? obj.sportSeriesId : undefined,
			sharpSideLabel:
				typeof obj.sharpSideLabel === "string" ? obj.sharpSideLabel : undefined,
			selectedOutcome:
				typeof obj.selectedOutcome === "string"
					? obj.selectedOutcome
					: undefined,
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Main backfill
// ---------------------------------------------------------------------------

/**
 * Backfills linkage columns on manual_picks from canonical entities.
 *
 * Iterates all picks that are missing at least one linkage field and
 * attempts to populate from canonical teams, games, game_lines, and facts.
 */
export async function backfillManualPicks(
	db: Db,
	options: BackfillOptions = {},
): Promise<BackfillResult> {
	const result: BackfillResult = {
		total: 0,
		updated: 0,
		skipped: 0,
		errors: 0,
		changedFieldCounts: {},
		failureReasonCounts: {},
		details: [],
	};

	const mode = options.mode ?? "incremental";
	const repairWindowHours = Math.max(1, options.repairWindowHours ?? 72);
	const repairWindowCutoff = nowUnixSeconds() - repairWindowHours * 60 * 60;
	const selectionWhere =
		mode === "full"
			? ""
			: `WHERE
				bet_type IS NULL
				OR sport_tag IS NULL
				OR team_id IS NULL
				OR opponent_id IS NULL
				OR game_id IS NULL
				OR venue_role IS NULL
				OR fav_dog_role IS NULL
				OR spread_line IS NULL
				OR total_line IS NULL
				OR picked_at >= ?`;

	const picks = await all<ManualPickRow>(
		db,
		`SELECT id, condition_id, market_title, event_time,
		        decision_snapshot_json, game_id, team_id, opponent_id, bet_type, sport_tag,
		        sharp_side, venue_role, fav_dog_role, spread_line, total_line,
		        actual_margin, actual_total
		 FROM manual_picks
		 ${selectionWhere}
		 ORDER BY picked_at DESC`,
		...(mode === "full" ? [] : [repairWindowCutoff]),
	);

	result.total = picks.length;

	function incrementCounter(
		bucket: Record<string, number>,
		key: string | null | undefined,
	) {
		if (!key) return;
		bucket[key] = (bucket[key] ?? 0) + 1;
	}

	for (const pick of picks) {
		try {
			const fieldsSet: string[] = [];
			const failureReasons: string[] = [];
			const snapshot = parseDecisionSnapshot(pick.decision_snapshot_json);
			const title = pick.market_title ?? snapshot?.marketTitle ?? "";

			if (!title) {
				result.skipped++;
				incrementCounter(result.failureReasonCounts, "missing_market_title");
				result.details.push({
					pickId: pick.id,
					status: "skipped",
					reason: "No market title available",
					fieldsSet: [],
				});
				continue;
			}

			// 1. Detect bet_type
			const betType = pick.bet_type ?? detectBetType({ title }) ?? null;

			// 2. Detect sport_tag
			const inferredSportTag =
				resolveSportTagFromSeriesId(snapshot?.sportSeriesId) ??
				detectSportTag({
					title,
					eventSlug: snapshot?.eventSlug,
				}) ??
				null;
			const rawSportTag = inferredSportTag ?? pick.sport_tag ?? null;
			// epl/mls store as canonical "soccer" (matches teams/games sport_tag)
			const sportTag = rawSportTag ? toCanonicalSportTag(rawSportTag) : null;

			// 3. Parse team names and resolve IDs.
			// We use the picked side label (from sharp_side, decision snapshot, or
			// sharp_money_cache) to determine which team was picked. If we cannot
			// confidently resolve the picked side, we skip team_id assignment
			// entirely rather than guessing wrong.
			let teamId = pick.team_id ?? null;
			let opponentId: string | null = null;
			let venueRole: VenueRole | null = null;
			let isHomeTeam = false;
			let homeTeamId: string | null = null;
			let awayTeamId: string | null = null;

			// Totals/prop sides (Over/Under, BTTS) are not teams; team IDs are
			// still resolved for game matching, but no picked-team linkage.
			const teamSidedMarket = betType !== "total" && betType !== "prop";

			if (!teamId && sportTag) {
				const parsed = parseTeamsFromTitle(title, sportTag);
				if (parsed) {
					const homeTeam = await resolveSingleTeam(db, sportTag, parsed.home);
					const awayTeam = await resolveSingleTeam(db, sportTag, parsed.away);

					if (homeTeam && awayTeam) {
						homeTeamId = homeTeam.id;
						awayTeamId = awayTeam.id;
						// Determine picked side label from available sources
						const pickedLabel =
							pick.sharp_side ??
							snapshot?.sharpSideLabel ??
							snapshot?.selectedOutcome ??
							null;

						// Look up side labels from sharp_money_cache for mapping
						const sideLabels = teamSidedMarket
							? await getSideLabels(db, pick.condition_id)
							: { sideALabel: null, sideBLabel: null };

						const resolved = teamSidedMarket
							? resolvePickedSide({
									pickedLabel,
									marketTitle: title,
									sideALabel: sideLabels.sideALabel,
									sideBLabel: sideLabels.sideBLabel,
									homeTeamName: homeTeam.name,
									awayTeamName: awayTeam.name,
									homeTeamId: homeTeam.id,
									awayTeamId: awayTeam.id,
									betType,
								})
							: null;

						if (resolved) {
							teamId = resolved.teamId;
							opponentId = resolved.opponentId;
							venueRole = resolved.venueRole;
							isHomeTeam = resolved.isHomeTeam;
						} else if (teamSidedMarket) {
							const explicitPickedLabel = extractSpreadPickedLabel(title);
							const resolvedPickedTeam = explicitPickedLabel
								? await resolveSingleTeam(db, sportTag, explicitPickedLabel)
								: null;
							const mappedPickedTeam = mapPickedTeamToSide({
								pickedTeamId: resolvedPickedTeam?.id ?? null,
								homeTeamId: homeTeam.id,
								awayTeamId: awayTeam.id,
							});
							if (mappedPickedTeam) {
								teamId = mappedPickedTeam.teamId;
								opponentId = mappedPickedTeam.opponentId;
								venueRole = mappedPickedTeam.venueRole;
								isHomeTeam = mappedPickedTeam.isHomeTeam;
							} else {
								failureReasons.push("picked_side_ambiguous");
							}
						}
						// If resolved is null, we skip team assignment — prefer no data
						// over likely-wrong linkage. The pick can still get bet_type and
						// sport_tag populated.
					} else {
						failureReasons.push("team_alias_not_found");
					}
				} else {
					failureReasons.push("teams_parse_failed");
				}
			} else if (!sportTag) {
				failureReasons.push("sport_tag_unknown");
			}

			// 4. Match game_id
			let gameId = pick.game_id ?? null;
			let eventTimeUnix: number | null = null;

			if (pick.event_time) {
				const parsed = new Date(pick.event_time).getTime();
				if (Number.isFinite(parsed)) {
					eventTimeUnix = Math.floor(parsed / 1000);
				}
			} else if (snapshot?.eventTime) {
				const parsed = new Date(snapshot.eventTime).getTime();
				if (Number.isFinite(parsed)) {
					eventTimeUnix = Math.floor(parsed / 1000);
				}
			}

			if (!gameId && eventTimeUnix && sportTag) {
				// Use venue roles when known; otherwise fall back to parsed teams.
				const homeId =
					teamId && opponentId
						? isHomeTeam
							? teamId
							: opponentId
						: homeTeamId;
				const awayId =
					teamId && opponentId
						? isHomeTeam
							? opponentId
							: teamId
						: awayTeamId;
				gameId = await findGameForPick(db, {
					eventSlug: snapshot?.eventSlug,
					homeTeamId: homeId,
					awayTeamId: awayId,
					eventTime: eventTimeUnix,
					sportTag,
				});
				if (!gameId && homeId && awayId) {
					failureReasons.push("game_match_failed");
				}
			}

			// 5. Get line values from game_lines
			let spreadLine: number | null = null;
			let totalLine: number | null = null;
			let homeSpread: number | null = null;

			if (gameId) {
				const lines = await getLineValues(db, gameId);
				spreadLine = lines.spreadLine;
				totalLine = lines.totalLine;
				homeSpread = lines.homeSpread;
			}

			// 6. Get facts (fav_dog_role, venue_role, actual_margin, actual_total)
			let favDogRole: FavDogRole | null = null;
			let actualMargin: number | null = null;
			let actualTotal: number | null = null;
			if (gameId && teamId) {
				const facts = await getFactValues(db, gameId, teamId);
				if (facts.favDogRole) {
					favDogRole = facts.favDogRole;
				}
				if (facts.venueRole) {
					venueRole = facts.venueRole;
					isHomeTeam = venueRole === "home";
				}
				actualMargin = facts.actualMargin;
				actualTotal = facts.actualTotal;
			} else if (gameId && betType === "total" && (homeTeamId || awayTeamId)) {
				// Totals picks have no picked team, but actual_total is a property
				// of the game — read it via either participant's fact row.
				const facts = await getFactValues(
					db,
					gameId,
					(homeTeamId ?? awayTeamId) as string,
				);
				actualTotal = facts.actualTotal;
			}
			// fav/dog is relative to a picked team; without one it's meaningless.
			if (!favDogRole && homeSpread !== null && teamId) {
				favDogRole = deriveFavDogRole(homeSpread, isHomeTeam);
			}

			// Build UPDATE SET clauses for non-null values
			const updates: string[] = [];
			const params: unknown[] = [];

			function addField(
				column: string,
				value: unknown,
				currentValue: unknown,
				label: string,
			) {
				if (value !== null && value !== undefined && value !== currentValue) {
					updates.push(`${column} = ?`);
					params.push(value);
					fieldsSet.push(label);
				}
			}

			addField("bet_type", betType, pick.bet_type, "bet_type");
			addField("sport_tag", sportTag, pick.sport_tag, "sport_tag");
			addField("team_id", teamId, pick.team_id, "team_id");
			addField("opponent_id", opponentId, pick.opponent_id, "opponent_id");
			addField("game_id", gameId, pick.game_id, "game_id");
			addField("venue_role", venueRole, pick.venue_role, "venue_role");
			addField("fav_dog_role", favDogRole, pick.fav_dog_role, "fav_dog_role");
			addField("spread_line", spreadLine, pick.spread_line, "spread_line");
			addField("total_line", totalLine, pick.total_line, "total_line");
			addField(
				"actual_margin",
				actualMargin,
				pick.actual_margin,
				"actual_margin",
			);
			addField("actual_total", actualTotal, pick.actual_total, "actual_total");

			const uniqueFailureReasons = Array.from(new Set(failureReasons));
			for (const reason of uniqueFailureReasons) {
				incrementCounter(result.failureReasonCounts, reason);
			}

			if (updates.length === 0) {
				result.skipped++;
				incrementCounter(result.failureReasonCounts, "no_effective_change");
				result.details.push({
					pickId: pick.id,
					status: "skipped",
					reason: "No new fields could be derived",
					fieldsSet: [],
					failureReasons: uniqueFailureReasons,
				});
				continue;
			}

			params.push(pick.id);
			await run(
				db,
				`UPDATE manual_picks SET ${updates.join(", ")} WHERE id = ?`,
				...params,
			);

			result.updated++;
			for (const field of fieldsSet) {
				incrementCounter(result.changedFieldCounts, field);
			}
			result.details.push({
				pickId: pick.id,
				status: "updated",
				fieldsSet,
				failureReasons: uniqueFailureReasons,
			});
		} catch (err) {
			result.errors++;
			incrementCounter(result.failureReasonCounts, "exception");
			result.details.push({
				pickId: pick.id,
				status: "error",
				reason: err instanceof Error ? err.message : String(err),
				fieldsSet: [],
			});
		}
	}

	return result;
}
