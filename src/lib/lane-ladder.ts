/**
 * Lane stake ladder (2026-10-08). Charter: docs/charters/lane-stake-ladder.md.
 *
 * Owner decision 2026-10-08: z >= 2 is out of reach for any single lane
 * except an MLB-sized outlier (a real +5 % edge needs ~1,600 bets), so stakes
 * scale on a ladder whose bar rises with the money at risk, and the bot
 * applies it automatically ("Looser level 1 and automatic").
 *
 * Counts only lane bets PICKED at or after `start` (forward evidence, never
 * the backtest or the pilot rows before the ladder existed). Levels are
 * recomputed from the rows on every tick — no stored state:
 *   level 0  $4  default
 *   level 1  $6  >= 100 settled, ROI > 0, event-clustered z >= 0.8
 *   level 2  $8  >= 250 settled, z >= 1.5            (= the main book's flat stake)
 *   step down one level while the last 100 settled are net negative.
 * Above $8 needs >= 250 settled and z >= 2 AND the owner: `ownerCall` flags it.
 * The lane's dollar kill (realized PnL <= -$40) is unchanged.
 */

import { clusteredZ, type LanePickRow } from "./cs2-pickem-lane";

export const LANE_LADDER = {
	/** 2026-10-08T12:00:00Z */
	start: 1791460800,
	stakes: [4, 6, 8] as const,
	level1: { minSettled: 100, minZ: 0.8 },
	level2: { minSettled: 250, minZ: 1.5 },
	ownerCall: { minSettled: 250, minZ: 2 },
	demoteTrailingN: 100,
} as const;

export interface LadderState {
	level: 0 | 1 | 2;
	stakeUsd: number;
	/** Settled lane bets picked since the ladder start. */
	settled: number;
	roi: number | null;
	z: number | null;
	/** Mean ROI of the last `demoteTrailingN` settled (null under that many). */
	trailingRoi: number | null;
	demoted: boolean;
	/** z >= 2 on >= 250: stakes above $8 are the owner's decision. */
	ownerCall: boolean;
}

export function evaluateLadder(rows: LanePickRow[]): LadderState {
	const L = LANE_LADDER;
	const settled = rows
		.filter(
			(r) =>
				r.pickedAt >= L.start &&
				(r.status === "win" || r.status === "loss") &&
				r.roi != null,
		)
		.sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
	const n = settled.length;
	const roi =
		n > 0 ? settled.reduce((s, r) => s + (r.roi as number), 0) / n : null;
	const z = clusteredZ(
		settled.map((r) => ({ roi: r.roi as number, clusterKey: r.clusterKey })),
	);
	let target: 0 | 1 | 2 = 0;
	if (n >= L.level2.minSettled && z !== null && z >= L.level2.minZ) target = 2;
	else if (
		n >= L.level1.minSettled &&
		roi !== null &&
		roi > 0 &&
		z !== null &&
		z >= L.level1.minZ
	)
		target = 1;
	const tail = settled.slice(-L.demoteTrailingN);
	const trailingRoi =
		n >= L.demoteTrailingN
			? tail.reduce((s, r) => s + (r.roi as number), 0) / tail.length
			: null;
	const demoted = target > 0 && trailingRoi !== null && trailingRoi < 0;
	const level = (demoted ? target - 1 : target) as 0 | 1 | 2;
	return {
		level,
		stakeUsd: L.stakes[level],
		settled: n,
		roi,
		z,
		trailingRoi,
		demoted,
		ownerCall:
			n >= L.ownerCall.minSettled && z !== null && z >= L.ownerCall.minZ,
	};
}
