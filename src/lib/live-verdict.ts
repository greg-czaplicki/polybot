/**
 * Live-book stake ladder — pre-registered 2026-08-27 (docs/STRATEGY.md).
 *
 * The shadow verdict answers "should a GATE be loosened". This answers the
 * other question the record keeps raising: "when does the live book earn
 * bigger stakes than the flat base?" Written down before the data exists
 * so the day a trigger fires is a fact, not a feeling.
 *
 * Cohort: every live pick settled after LIVE_OOS_SINCE — the post-gate
 * out-of-sample window (the 2026-05-11 and 06-25 calibrations were fit on
 * earlier picks; nothing scoring-related has been fit on rows after this).
 *
 * Why CLV alone doesn't decide it here: Polymarket is a vig-free two-sided
 * market, and our entry price sits ~0.3% above a de-vigged book by
 * construction (docs/KNOWN-ISSUES.md), so the offset-free Pinnacle MOVEMENT
 * (pin_move = close − anchor) is the sharp-book criterion, and a
 * results-only override exists for the case where the signal predicts
 * outcomes the close never prices. Never above 1× Kelly on the shrunk edge.
 */

import { roiZScore } from "./gate-verdict";

/** 2026-07-20 00:00Z — post-gate out-of-sample boundary. */
export const LIVE_OOS_SINCE = 1784505600;

export interface LiveCohortInput {
	settled: number;
	units: number | null;
	sumSq: number | null;
	/** Rows with both a Pinnacle anchor and close (anchors from 2026-08-25). */
	pinMoveN: number;
	avgPinMove: number | null;
}

export interface LiveLadderInput {
	all: LiveCohortInput;
	totals: LiveCohortInput;
	moneyline: LiveCohortInput;
	/** The most recent 100 settled rows of `all` (stop-rule window). */
	trailing100: LiveCohortInput;
}

export interface LiveTrigger {
	key: "totals_lean_in" | "results_override" | "ml_lean_in" | "stop";
	label: string;
	met: boolean;
	/** Progress toward each criterion, e.g. "n=62/100 · z=2.3/2.5 · move n=9/30". */
	detail: string;
	/** What the trigger authorises when met. */
	action: string;
}

export const TOTALS_MIN_N = 100;
export const TOTALS_MIN_Z = 2.5;
export const PIN_MOVE_MIN_N = 30;
export const OVERRIDE_MIN_N = 200;
export const OVERRIDE_MIN_Z = 3;
export const ML_MIN_N = 100;
export const ML_MIN_Z = 2;
export const STOP_WINDOW = 100;

function fmtZ(z: number | null): string {
	return z === null ? "—" : z.toFixed(1);
}
function fmtMove(c: LiveCohortInput): string {
	return c.avgPinMove === null ? "—" : `${(c.avgPinMove * 100).toFixed(2)}%`;
}

export function evaluateLiveLadder(input: LiveLadderInput): LiveTrigger[] {
	const zAll = roiZScore(input.all.settled, input.all.units, input.all.sumSq);
	const zTot = roiZScore(
		input.totals.settled,
		input.totals.units,
		input.totals.sumSq,
	);
	const zMl = roiZScore(
		input.moneyline.settled,
		input.moneyline.units,
		input.moneyline.sumSq,
	);
	const zTrail = roiZScore(
		input.trailing100.settled,
		input.trailing100.units,
		input.trailing100.sumSq,
	);

	const totalsMet =
		input.totals.settled >= TOTALS_MIN_N &&
		zTot !== null &&
		zTot >= TOTALS_MIN_Z &&
		input.totals.pinMoveN >= PIN_MOVE_MIN_N &&
		input.totals.avgPinMove !== null &&
		input.totals.avgPinMove >= 0;

	const overrideMet =
		input.all.settled >= OVERRIDE_MIN_N &&
		zAll !== null &&
		zAll >= OVERRIDE_MIN_Z;

	const mlMoveMet =
		input.moneyline.pinMoveN >= PIN_MOVE_MIN_N &&
		input.moneyline.avgPinMove !== null &&
		input.moneyline.avgPinMove > 0;
	const mlResultsMet =
		input.moneyline.settled >= ML_MIN_N && zMl !== null && zMl >= ML_MIN_Z;

	// Stop rule only has meaning once a full window exists.
	const stopMet =
		input.trailing100.settled >= STOP_WINDOW && zTrail !== null && zTrail < 0;

	return [
		{
			key: "totals_lean_in",
			label: "Totals lean-in",
			met: totalsMet,
			detail: `n=${input.totals.settled}/${TOTALS_MIN_N} · z=${fmtZ(zTot)}/${TOTALS_MIN_Z} · pin move ${fmtMove(input.totals)} (n=${input.totals.pinMoveN}/${PIN_MOVE_MIN_N}, need ≥0)`,
			action: "raise TOTALS stake to ~1× Kelly on the shrunk edge",
		},
		{
			key: "results_override",
			label: "Results override",
			met: overrideMet,
			detail: `n=${input.all.settled}/${OVERRIDE_MIN_N} · z=${fmtZ(zAll)}/${OVERRIDE_MIN_Z}`,
			action: "treat the live book as edge regardless of CLV",
		},
		{
			key: "ml_lean_in",
			label: "Moneyline lean-in",
			met: mlMoveMet || mlResultsMet,
			detail: `pin move ${fmtMove(input.moneyline)} (n=${input.moneyline.pinMoveN}/${PIN_MOVE_MIN_N}, need >0) OR n=${input.moneyline.settled}/${ML_MIN_N} · z=${fmtZ(zMl)}/${ML_MIN_Z}`,
			action: "raise MONEYLINE stake to ~1× Kelly on the shrunk edge",
		},
		{
			key: "stop",
			label: "Stop rule",
			met: stopMet,
			detail: `trailing ${input.trailing100.settled}/${STOP_WINDOW} · z=${fmtZ(zTrail)} (fires when <0)`,
			action: "drop every stake back to base",
		},
	];
}
