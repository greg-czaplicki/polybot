/**
 * Pre-registered two-block test: "lower the MLB policy grade floor by one
 * notch (B → C)". Charter: docs/charters/mlb-grade-floor.md (2026-09-15).
 *
 * Cohort: MLB `below_policy_grade` sole-blocker rows with grade = 'C'.
 *   block 1 = rows created before FORWARD_START (in-sample: the cut was
 *             found after seeing them — sign and volume only)
 *   block 2 = rows created at/after FORWARD_START (confirmatory)
 * Pass = block 2: n ≥ 30, clustered z ≥ 1.5, ROI > 0
 *        AND pooled: n ≥ 80, clustered z ≥ 2.
 * Anything else is HOLD. Grade D is never part of this test.
 */
import { clusterRoiZ } from "./gate-verdict";

/** 2026-09-16 00:00:00Z — first confirmatory row. */
export const GRADE_FLOOR_FORWARD_START = 1789516800;
export const GRADE_FLOOR_BLOCK2_MIN_N = 30;
export const GRADE_FLOOR_BLOCK2_MIN_Z = 1.5;
export const GRADE_FLOOR_POOLED_MIN_N = 80;
export const GRADE_FLOOR_POOLED_MIN_Z = 2;

export interface GradeFloorRow {
	roi: number;
	win: boolean;
	clusterKey: string;
	createdAt: number;
}

export interface GradeFloorBlock {
	settled: number;
	wins: number;
	losses: number;
	units: number;
	roiPct: number | null;
	/** Event-clustered z; null below 5 clusters. */
	z: number | null;
	clusters: number;
}

export function gradeFloorBlock(rows: GradeFloorRow[]): GradeFloorBlock {
	const byEvent = new Map<string, { sum: number; n: number }>();
	let units = 0;
	let wins = 0;
	for (const r of rows) {
		units += r.roi;
		if (r.win) wins += 1;
		const agg = byEvent.get(r.clusterKey) ?? { sum: 0, n: 0 };
		agg.sum += r.roi;
		agg.n += 1;
		byEvent.set(r.clusterKey, agg);
	}
	const means = Array.from(byEvent.values(), (a) => a.sum / a.n);
	return {
		settled: rows.length,
		wins,
		losses: rows.length - wins,
		units,
		roiPct: rows.length > 0 ? (units / rows.length) * 100 : null,
		z: clusterRoiZ(means),
		clusters: means.length,
	};
}

export interface GradeFloorRead {
	forwardStart: number;
	block1: GradeFloorBlock;
	block2: GradeFloorBlock;
	pooled: GradeFloorBlock;
	verdict: "ready" | "hold";
	reason: string;
}

export function gradeFloorRead(rows: GradeFloorRow[]): GradeFloorRead {
	const b1 = gradeFloorBlock(
		rows.filter((r) => r.createdAt < GRADE_FLOOR_FORWARD_START),
	);
	const b2 = gradeFloorBlock(
		rows.filter((r) => r.createdAt >= GRADE_FLOOR_FORWARD_START),
	);
	const pooled = gradeFloorBlock(rows);
	const missing: string[] = [];
	if (b2.settled < GRADE_FLOOR_BLOCK2_MIN_N)
		missing.push(`fwd n=${b2.settled}/${GRADE_FLOOR_BLOCK2_MIN_N}`);
	if (b2.z === null || b2.z < GRADE_FLOOR_BLOCK2_MIN_Z)
		missing.push(
			`fwd z=${b2.z === null ? "—" : b2.z.toFixed(1)}/${GRADE_FLOOR_BLOCK2_MIN_Z}`,
		);
	if (b2.roiPct === null || b2.roiPct <= 0) missing.push("fwd roi≤0");
	if (pooled.settled < GRADE_FLOOR_POOLED_MIN_N)
		missing.push(`pooled n=${pooled.settled}/${GRADE_FLOOR_POOLED_MIN_N}`);
	if (pooled.z === null || pooled.z < GRADE_FLOOR_POOLED_MIN_Z)
		missing.push(
			`pooled z=${pooled.z === null ? "—" : pooled.z.toFixed(1)}/${GRADE_FLOOR_POOLED_MIN_Z}`,
		);
	return {
		forwardStart: GRADE_FLOOR_FORWARD_START,
		block1: b1,
		block2: b2,
		pooled,
		verdict: missing.length === 0 ? "ready" : "hold",
		reason: missing.length === 0 ? "all criteria met" : missing.join(", "),
	};
}
