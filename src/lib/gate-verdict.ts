/**
 * Gate-promotion verdict — the ONE rule for "should this gate be loosened".
 *
 * Pre-registered 2026-07-30 (see docs/STRATEGY.md, shadow-book audit): a
 * gate earns a promotion REVIEW only when its sole-blocker cohort (rejected
 * by this gate alone, every other vector gate passing) reaches
 *   n >= 50 settled  AND  z >= 2 on ROI  AND  CLV > 0.
 * CLV means Pinnacle close (pin_clv) once enough rows carry it; the
 * Polymarket self-close clv is the fallback while pin coverage is thin.
 *
 * Anything short of that is HOLD. WATCH is informational only — CLV is
 * already positive and ROI is trending up, so only sample size/significance
 * is short; keep collecting — and never authorises action. A cohort the
 * sharp book prices as negative-CLV is HOLD no matter how hot its ROI.
 * Raw first-fired stats are deliberately NOT an input: they mix in rows
 * other gates would have rejected anyway (the twice-made mistake).
 */

export type GateVerdict = "ready" | "watch" | "hold";

export const PROMOTION_MIN_N = 50;
export const PROMOTION_MIN_Z = 2;
/** Below this many pin_clv rows, fall back to the Polymarket self-close clv. */
export const PIN_CLV_MIN_N = 10;
const WATCH_MIN_N = 25;
const WATCH_MIN_Z = 1;

export interface GateVerdictInput {
	/** Settled (win+loss) rows in the sole-blocker cohort. */
	settled: number;
	/** Sum of per-row ROI over settled rows (units). */
	units: number | null;
	/** Sum of per-row ROI² over settled rows — for the z-score. */
	sumSq: number | null;
	/** Mean pin_clv over settled rows carrying it, and how many do. */
	avgPinClv: number | null;
	pinN: number;
	/** Mean Polymarket self-close clv over settled rows (fallback). */
	avgClv: number | null;
}

export interface GateVerdictResult {
	verdict: GateVerdict;
	/** ROI z-score (mean / standard error); null when undefined. */
	z: number | null;
	/** Which CLV benchmark the verdict used. */
	clvSource: "pinnacle" | "polymarket" | "none";
	clv: number | null;
	/** Short human reason, e.g. "n=34/50". */
	reason: string;
}

export function roiZScore(
	settled: number,
	units: number | null,
	sumSq: number | null,
): number | null {
	if (settled < 2 || units === null || sumSq === null) return null;
	const mean = units / settled;
	const variance = Math.max(0, sumSq / settled - mean * mean);
	if (variance === 0) return null;
	const se = Math.sqrt(variance / settled);
	return mean / se;
}

export function gateVerdict(input: GateVerdictInput): GateVerdictResult {
	const z = roiZScore(input.settled, input.units, input.sumSq);
	let clvSource: GateVerdictResult["clvSource"] = "none";
	let clv: number | null = null;
	if (input.pinN >= PIN_CLV_MIN_N && input.avgPinClv !== null) {
		clvSource = "pinnacle";
		clv = input.avgPinClv;
	} else if (input.settled > 0 && input.avgClv !== null) {
		clvSource = "polymarket";
		clv = input.avgClv;
	}

	const missing: string[] = [];
	if (input.settled < PROMOTION_MIN_N) {
		missing.push(`n=${input.settled}/${PROMOTION_MIN_N}`);
	}
	if (z === null || z < PROMOTION_MIN_Z) {
		missing.push(`z=${z === null ? "—" : z.toFixed(1)}/${PROMOTION_MIN_Z}`);
	}
	if (clv === null || clv <= 0) {
		missing.push(clv === null ? "clv=—" : `clv=${(clv * 100).toFixed(1)}%≤0`);
	}

	if (missing.length === 0) {
		return { verdict: "ready", z, clvSource, clv, reason: "all criteria met" };
	}
	const roi =
		input.settled > 0 && input.units !== null
			? input.units / input.settled
			: null;
	const watching =
		input.settled >= WATCH_MIN_N &&
		z !== null &&
		z >= WATCH_MIN_Z &&
		roi !== null &&
		roi > 0 &&
		clv !== null &&
		clv > 0;
	return {
		verdict: watching ? "watch" : "hold",
		z,
		clvSource,
		clv,
		reason: missing.join(", "),
	};
}
