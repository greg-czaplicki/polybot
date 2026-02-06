import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";

export type ManualPickStatus = "pending" | "win" | "loss" | "push";

export interface ManualPickRow {
	id: string;
	client_pick_id?: string | null;
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
	strategy_version?: string | null;
	threshold_used?: number | null;
	market_quality_score?: number | null;
	warnings_json?: string | null;
	decision_snapshot_json?: string | null;
	candidate_computed_at?: number | null;
	execution_submitted_at?: number | null;
	execution_filled_at?: number | null;
	fill_status?: string | null;
	fill_price?: number | null;
	fill_size?: number | null;
	fill_notional?: number | null;
	fill_slippage_bps?: number | null;
	order_id?: string | null;
	exchange_trade_id?: string | null;
	execution_notes?: string | null;
	status: ManualPickStatus;
	settled_at?: number | null;
}

export interface ManualPickEntry {
	id: string;
	clientPickId?: string;
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
	strategyVersion?: string;
	thresholdUsed?: number;
	marketQualityScore?: number;
	warnings?: string[];
	decisionSnapshot?: unknown;
	candidateComputedAt?: number;
	executionSubmittedAt?: number;
	executionFilledAt?: number;
	fillStatus?: string;
	fillPrice?: number;
	fillSize?: number;
	fillNotional?: number;
	fillSlippageBps?: number;
	orderId?: string;
	exchangeTradeId?: string;
	executionNotes?: string;
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

export interface ManualPickCalibrationBucket {
	label: string;
	count: number;
	wins: number;
	losses: number;
	pushes: number;
	winRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
}

export interface ManualPickCalibrationSummary {
	computedAt: number;
	totalPicks: number;
	settledPicks: number;
	withSignalScore: number;
	withQualityScore: number;
	withEventTime: number;
	bySignalScore: ManualPickCalibrationBucket[];
	byQualityScore: ManualPickCalibrationBucket[];
	byTimeToStart: ManualPickCalibrationBucket[];
}

export interface CreateManualPickInput {
	clientPickId?: string;
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
	strategyVersion?: string;
	thresholdUsed?: number;
	marketQualityScore?: number;
	warnings?: string[];
	decisionSnapshot?: unknown;
	candidateComputedAt?: number;
}

export interface UpdateManualPickExecutionInput {
	id?: string;
	clientPickId?: string;
	executionSubmittedAt?: number | null;
	executionFilledAt?: number | null;
	fillStatus?: string | null;
	fillPrice?: number | null;
	fillSize?: number | null;
	fillNotional?: number | null;
	fillSlippageBps?: number | null;
	orderId?: string | null;
	exchangeTradeId?: string | null;
	executionNotes?: string | null;
}

const SIGNAL_SCORE_BUCKETS = [
	{ label: "<20", min: Number.NEGATIVE_INFINITY, max: 20 },
	{ label: "20-40", min: 20, max: 40 },
	{ label: "40-60", min: 40, max: 60 },
	{ label: "60-80", min: 60, max: 80 },
	{ label: "80+", min: 80, max: Number.POSITIVE_INFINITY },
] as const;

const QUALITY_SCORE_BUCKETS = [
	{ label: "<0.58", min: Number.NEGATIVE_INFINITY, max: 0.58 },
	{ label: "0.58-0.62", min: 0.58, max: 0.62 },
	{ label: "0.62-0.66", min: 0.62, max: 0.66 },
	{ label: "0.66-0.70", min: 0.66, max: 0.7 },
	{ label: "0.70-0.72", min: 0.7, max: 0.72 },
	{ label: "0.72+", min: 0.72, max: Number.POSITIVE_INFINITY },
] as const;

const TIME_TO_START_BUCKETS = [
	{ label: "0-15m", min: 0, max: 15 },
	{ label: "15-60m", min: 15, max: 60 },
	{ label: "1-3h", min: 60, max: 180 },
	{ label: "3h+", min: 180, max: Number.POSITIVE_INFINITY },
] as const;

function parseStringArray(value: string | null | undefined): string[] | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return undefined;
		return parsed.filter((item) => typeof item === "string");
	} catch {
		return undefined;
	}
}

function parseJsonValue(value: string | null | undefined): unknown {
	if (!value) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function parsePickRow(row: ManualPickRow): ManualPickEntry {
	return {
		id: row.id,
		clientPickId: row.client_pick_id ?? undefined,
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
		strategyVersion: row.strategy_version ?? undefined,
		thresholdUsed: row.threshold_used ?? undefined,
		marketQualityScore: row.market_quality_score ?? undefined,
		warnings: parseStringArray(row.warnings_json),
		decisionSnapshot: parseJsonValue(row.decision_snapshot_json),
		candidateComputedAt: row.candidate_computed_at ?? undefined,
		executionSubmittedAt: row.execution_submitted_at ?? undefined,
		executionFilledAt: row.execution_filled_at ?? undefined,
		fillStatus: row.fill_status ?? undefined,
		fillPrice: row.fill_price ?? undefined,
		fillSize: row.fill_size ?? undefined,
		fillNotional: row.fill_notional ?? undefined,
		fillSlippageBps: row.fill_slippage_bps ?? undefined,
		orderId: row.order_id ?? undefined,
		exchangeTradeId: row.exchange_trade_id ?? undefined,
		executionNotes: row.execution_notes ?? undefined,
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
	if (input.clientPickId) {
		const existing = await first<ManualPickRow>(
			db,
			`SELECT * FROM manual_picks WHERE client_pick_id = ?`,
			input.clientPickId,
		);
		if (existing) {
			return parsePickRow(existing);
		}
	}
	const now = nowUnixSeconds();
	const id = generateId();
	await run(
		db,
		`INSERT INTO manual_picks (
	      id,
	      client_pick_id,
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
	      strategy_version,
	      threshold_used,
	      market_quality_score,
	      warnings_json,
	      decision_snapshot_json,
	      candidate_computed_at,
	      status
	    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
			id,
			input.clientPickId ?? null,
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
			input.strategyVersion ?? null,
			input.thresholdUsed ?? null,
			input.marketQualityScore ?? null,
			input.warnings ? JSON.stringify(input.warnings) : null,
			input.decisionSnapshot ? JSON.stringify(input.decisionSnapshot) : null,
			input.candidateComputedAt ?? null,
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
		id?: string;
		clientPickId?: string;
		status: ManualPickStatus;
		resolvedOutcome?: string | null;
		closePrice?: number | null;
		roi?: number | null;
		clv?: number | null;
	},
): Promise<ManualPickEntry | null> {
	if (!input.id && !input.clientPickId) {
		throw new Error("id_or_clientPickId_required");
	}
	const settledAt = input.status === "pending" ? null : nowUnixSeconds();
	const whereClause = input.id ? "id = ?" : "client_pick_id = ?";
	const whereValue = input.id ?? input.clientPickId ?? null;
	await run(
		db,
		`UPDATE manual_picks
     SET status = ?, settled_at = ?, resolved_outcome = ?, close_price = ?, roi = ?, clv = ?
     WHERE ${whereClause}`,
		input.status,
		settledAt,
		input.resolvedOutcome ?? null,
		input.closePrice ?? null,
		input.roi ?? null,
		input.clv ?? null,
		whereValue,
	);
	const row = await first<ManualPickRow>(
		db,
		`SELECT * FROM manual_picks WHERE ${whereClause}`,
		whereValue,
	);
	return row ? parsePickRow(row) : null;
}

export async function updateManualPickExecution(
	db: Db,
	input: UpdateManualPickExecutionInput,
): Promise<ManualPickEntry | null> {
	if (!input.id && !input.clientPickId) {
		throw new Error("id_or_clientPickId_required");
	}
	const whereClause = input.id ? "id = ?" : "client_pick_id = ?";
	const whereValue = input.id ?? input.clientPickId ?? null;
	await run(
		db,
		`UPDATE manual_picks
	     SET execution_submitted_at = COALESCE(?, execution_submitted_at),
	         execution_filled_at = COALESCE(?, execution_filled_at),
	         fill_status = COALESCE(?, fill_status),
	         fill_price = COALESCE(?, fill_price),
	         fill_size = COALESCE(?, fill_size),
	         fill_notional = COALESCE(?, fill_notional),
	         fill_slippage_bps = COALESCE(?, fill_slippage_bps),
	         order_id = COALESCE(?, order_id),
	         exchange_trade_id = COALESCE(?, exchange_trade_id),
	         execution_notes = COALESCE(?, execution_notes)
	     WHERE ${whereClause}`,
		input.executionSubmittedAt ?? null,
		input.executionFilledAt ?? null,
		input.fillStatus ?? null,
		input.fillPrice ?? null,
		input.fillSize ?? null,
		input.fillNotional ?? null,
		input.fillSlippageBps ?? null,
		input.orderId ?? null,
		input.exchangeTradeId ?? null,
		input.executionNotes ?? null,
		whereValue,
	);
	const row = await first<ManualPickRow>(
		db,
		`SELECT * FROM manual_picks WHERE ${whereClause}`,
		whereValue,
	);
	return row ? parsePickRow(row) : null;
}

export async function clearManualPicks(db: Db): Promise<void> {
	await run(db, `DELETE FROM manual_picks`);
}

type MutableBucketStats = {
	label: string;
	count: number;
	wins: number;
	losses: number;
	pushes: number;
	roiSum: number;
	roiCount: number;
	clvBpsSum: number;
	clvBpsCount: number;
};

function createMutableBuckets(labels: string[]): MutableBucketStats[] {
	return labels.map((label) => ({
		label,
		count: 0,
		wins: 0,
		losses: 0,
		pushes: 0,
		roiSum: 0,
		roiCount: 0,
		clvBpsSum: 0,
		clvBpsCount: 0,
	}));
}

function bucketToOutput(bucket: MutableBucketStats): ManualPickCalibrationBucket {
	return {
		label: bucket.label,
		count: bucket.count,
		wins: bucket.wins,
		losses: bucket.losses,
		pushes: bucket.pushes,
		winRate:
			bucket.wins + bucket.losses > 0
				? bucket.wins / (bucket.wins + bucket.losses)
				: null,
		avgRoi: bucket.roiCount > 0 ? bucket.roiSum / bucket.roiCount : null,
		avgClvBps:
			bucket.clvBpsCount > 0 ? bucket.clvBpsSum / bucket.clvBpsCount : null,
	};
}

function bucketIndexFromRange(
	value: number,
	ranges: ReadonlyArray<{ min: number; max: number }>,
): number {
	return ranges.findIndex((range) => value >= range.min && value < range.max);
}

function applyPickToBucket(bucket: MutableBucketStats, pick: ManualPickEntry): void {
	bucket.count += 1;
	if (pick.status === "win") bucket.wins += 1;
	if (pick.status === "loss") bucket.losses += 1;
	if (pick.status === "push") bucket.pushes += 1;
	if (typeof pick.roi === "number" && Number.isFinite(pick.roi)) {
		bucket.roiSum += pick.roi;
		bucket.roiCount += 1;
	}
	if (typeof pick.clv === "number" && Number.isFinite(pick.clv)) {
		bucket.clvBpsSum += pick.clv * 10000;
		bucket.clvBpsCount += 1;
	}
}

export async function getManualPicksCalibrationSummary(
	db: Db,
	options?: { limit?: number },
): Promise<ManualPickCalibrationSummary> {
	const limit = options?.limit && options.limit > 0 ? options.limit : 2000;
	const picks = await listManualPicks(db, { limit });
	const settled = picks.filter((pick) => pick.status !== "pending");
	const signalBuckets = createMutableBuckets(
		SIGNAL_SCORE_BUCKETS.map((bucket) => bucket.label),
	);
	const qualityBuckets = createMutableBuckets(
		QUALITY_SCORE_BUCKETS.map((bucket) => bucket.label),
	);
	const timeBuckets = createMutableBuckets(
		TIME_TO_START_BUCKETS.map((bucket) => bucket.label),
	);

	let withSignalScore = 0;
	let withQualityScore = 0;
	let withEventTime = 0;

	for (const pick of settled) {
		if (
			typeof pick.signalScore === "number" &&
			Number.isFinite(pick.signalScore)
		) {
			const index = bucketIndexFromRange(pick.signalScore, SIGNAL_SCORE_BUCKETS);
			if (index >= 0) {
				withSignalScore += 1;
				applyPickToBucket(signalBuckets[index], pick);
			}
		}

		if (
			typeof pick.marketQualityScore === "number" &&
			Number.isFinite(pick.marketQualityScore)
		) {
			const index = bucketIndexFromRange(
				pick.marketQualityScore,
				QUALITY_SCORE_BUCKETS,
			);
			if (index >= 0) {
				withQualityScore += 1;
				applyPickToBucket(qualityBuckets[index], pick);
			}
		}

		if (pick.eventTime) {
			const eventTimeMs = new Date(pick.eventTime).getTime();
			if (Number.isFinite(eventTimeMs)) {
				const minutesToStart = (eventTimeMs - pick.pickedAt * 1000) / 60000;
				if (Number.isFinite(minutesToStart) && minutesToStart >= 0) {
					const index = bucketIndexFromRange(minutesToStart, TIME_TO_START_BUCKETS);
					if (index >= 0) {
						withEventTime += 1;
						applyPickToBucket(timeBuckets[index], pick);
					}
				}
			}
		}
	}

	return {
		computedAt: nowUnixSeconds(),
		totalPicks: picks.length,
		settledPicks: settled.length,
		withSignalScore,
		withQualityScore,
		withEventTime,
		bySignalScore: signalBuckets.map(bucketToOutput),
		byQualityScore: qualityBuckets.map(bucketToOutput),
		byTimeToStart: timeBuckets.map(bucketToOutput),
	};
}
