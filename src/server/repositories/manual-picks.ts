import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";

export type ManualPickStatus = "pending" | "win" | "loss" | "push";

export interface ManualPickRow {
	id: string;
	condition_id: string;
	market_title: string;
	event_time?: string | null;
	picked_at: number;
	grade?: string | null;
	signal_score?: number | null;
	edge_rating?: number | null;
	score_differential?: number | null;
	sharp_side?: string | null;
	price?: number | null;
	confidence?: string | null;
	fair_price?: number | null;
	price_edge?: number | null;
	resolved_outcome?: string | null;
	close_price?: number | null;
	roi?: number | null;
	clv?: number | null;
	status: ManualPickStatus;
	settled_at?: number | null;
}

export interface ManualPickEntry {
	id: string;
	conditionId: string;
	marketTitle: string;
	eventTime?: string;
	pickedAt: number;
	grade?: string;
	signalScore?: number;
	edgeRating?: number;
	scoreDifferential?: number;
	sharpSide?: string;
	price?: number;
	confidence?: string;
	fairPrice?: number;
	priceEdge?: number;
	resolvedOutcome?: string;
	closePrice?: number;
	roi?: number;
	clv?: number;
	status: ManualPickStatus;
	settledAt?: number;
}

export interface ManualPickSummary {
	total: number;
	settled: number;
	wins: number;
	losses: number;
	pushes: number;
	avgRoi: number | null;
	totalRoi: number | null;
	avgClv: number | null;
}

export interface CreateManualPickInput {
	conditionId: string;
	marketTitle: string;
	eventTime?: string;
	grade?: string;
	signalScore?: number;
	edgeRating?: number;
	scoreDifferential?: number;
	sharpSide?: string;
	price?: number;
	confidence?: string;
	fairPrice?: number;
	priceEdge?: number;
}

function parsePickRow(row: ManualPickRow): ManualPickEntry {
	return {
		id: row.id,
		conditionId: row.condition_id,
		marketTitle: row.market_title,
		eventTime: row.event_time ?? undefined,
		pickedAt: row.picked_at,
		grade: row.grade ?? undefined,
		signalScore: row.signal_score ?? undefined,
		edgeRating: row.edge_rating ?? undefined,
		scoreDifferential: row.score_differential ?? undefined,
		sharpSide: row.sharp_side ?? undefined,
		price: row.price ?? undefined,
		confidence: row.confidence ?? undefined,
		fairPrice: row.fair_price ?? undefined,
		priceEdge: row.price_edge ?? undefined,
		resolvedOutcome: row.resolved_outcome ?? undefined,
		closePrice: row.close_price ?? undefined,
		roi: row.roi ?? undefined,
		clv: row.clv ?? undefined,
		status: row.status,
		settledAt: row.settled_at ?? undefined,
	};
}

function generateId(): string {
	return `pick_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function createManualPick(
	db: Db,
	input: CreateManualPickInput,
): Promise<ManualPickEntry> {
	const now = nowUnixSeconds();
	const id = generateId();
	await run(
		db,
		`INSERT INTO manual_picks (
      id,
      condition_id,
      market_title,
      event_time,
      picked_at,
      grade,
      signal_score,
      edge_rating,
      score_differential,
      sharp_side,
      price,
      confidence,
      fair_price,
      price_edge,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
		id,
		input.conditionId,
		input.marketTitle,
		input.eventTime ?? null,
		now,
		input.grade ?? null,
		input.signalScore ?? null,
		input.edgeRating ?? null,
		input.scoreDifferential ?? null,
		input.sharpSide ?? null,
		input.price ?? null,
		input.confidence ?? null,
		input.fairPrice ?? null,
		input.priceEdge ?? null,
		"pending",
	);
	const row = await first<ManualPickRow>(
		db,
		`SELECT * FROM manual_picks WHERE id = ?`,
		id,
	);
	if (!row) {
		throw new Error("Failed to create manual pick");
	}
	return parsePickRow(row);
}

export async function listManualPicks(
	db: Db,
	options?: { status?: ManualPickStatus; limit?: number },
): Promise<ManualPickEntry[]> {
	const { status, limit = 25 } = options ?? {};
	const params: unknown[] = [];
	let query = `SELECT * FROM manual_picks`;
	if (status) {
		query += ` WHERE status = ?`;
		params.push(status);
	}
	query += ` ORDER BY picked_at DESC LIMIT ?`;
	params.push(limit);
	const rows = await all<ManualPickRow>(db, query, ...params);
	return rows.map(parsePickRow);
}

export async function getManualPicksSummary(
	db: Db,
): Promise<ManualPickSummary> {
	const row = await first<{
		total: number;
		settled: number;
		wins: number;
		losses: number;
		pushes: number;
		avg_roi: number | null;
		total_roi: number | null;
		avg_clv: number | null;
	}>(
		db,
		`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status != 'pending' THEN 1 ELSE 0 END) AS settled,
      SUM(CASE WHEN status = 'win' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN status = 'loss' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN status = 'push' THEN 1 ELSE 0 END) AS pushes,
      AVG(roi) AS avg_roi,
      SUM(roi) AS total_roi,
      AVG(clv) AS avg_clv
    FROM manual_picks`,
	);
	return {
		total: row?.total ?? 0,
		settled: row?.settled ?? 0,
		wins: row?.wins ?? 0,
		losses: row?.losses ?? 0,
		pushes: row?.pushes ?? 0,
		avgRoi: row?.avg_roi ?? null,
		totalRoi: row?.total_roi ?? null,
		avgClv: row?.avg_clv ?? null,
	};
}

export async function updateManualPickOutcome(
	db: Db,
	input: { id: string; status: ManualPickStatus },
): Promise<ManualPickEntry | null> {
	const settledAt = input.status === "pending" ? null : nowUnixSeconds();
	await run(
		db,
		`UPDATE manual_picks SET status = ?, settled_at = ? WHERE id = ?`,
		input.status,
		settledAt,
		input.id,
	);
	const row = await first<ManualPickRow>(
		db,
		`SELECT * FROM manual_picks WHERE id = ?`,
		input.id,
	);
	return row ? parsePickRow(row) : null;
}

export async function settleManualPick(
	db: Db,
	input: {
		id: string;
		status: ManualPickStatus;
		resolvedOutcome?: string | null;
		closePrice?: number | null;
		roi?: number | null;
		clv?: number | null;
	},
): Promise<ManualPickEntry | null> {
	const settledAt = input.status === "pending" ? null : nowUnixSeconds();
	await run(
		db,
		`UPDATE manual_picks
     SET status = ?, settled_at = ?, resolved_outcome = ?, close_price = ?, roi = ?, clv = ?
     WHERE id = ?`,
		input.status,
		settledAt,
		input.resolvedOutcome ?? null,
		input.closePrice ?? null,
		input.roi ?? null,
		input.clv ?? null,
		input.id,
	);
	const row = await first<ManualPickRow>(
		db,
		`SELECT * FROM manual_picks WHERE id = ?`,
		input.id,
	);
	return row ? parsePickRow(row) : null;
}

export async function clearManualPicks(db: Db): Promise<void> {
	await run(db, `DELETE FROM manual_picks`);
}
