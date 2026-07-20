import { detectBetType } from "../../lib/markets";
import { detectSportTag } from "../../lib/sports";
import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import {
	listSharpMoneyHistoryByConditionIds,
	type SharpMoneyHistoryEntryByConditionId,
} from "./sharp-money";

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
	game_id?: string | null;
	team_id?: string | null;
	opponent_id?: string | null;
	bet_type?: string | null;
	sport_tag?: string | null;
	venue_role?: string | null;
	fav_dog_role?: string | null;
	spread_line?: number | null;
	total_line?: number | null;
	actual_margin?: number | null;
	actual_total?: number | null;
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
	gameId?: string;
	teamId?: string;
	opponentId?: string;
	betType?: string;
	sportTag?: string;
	venueRole?: string;
	favDogRole?: string;
	spreadLine?: number;
	totalLine?: number;
	actualMargin?: number;
	actualTotal?: number;
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
	withEdgeRating: number;
	withScoreDifferential: number;
	withPriceEdge: number;
	withPriceEdgeRatio: number;
	bySignalScore: ManualPickCalibrationBucket[];
	byQualityScore: ManualPickCalibrationBucket[];
	byTimeToStart: ManualPickCalibrationBucket[];
	byEdgeRating: ManualPickCalibrationBucket[];
	byScoreDifferential: ManualPickCalibrationBucket[];
	byPriceEdge: ManualPickCalibrationBucket[];
	byPriceEdgeRatio: ManualPickCalibrationBucket[];
}

export interface BucketPerformanceRow {
	bucket: string;
	count: number;
	wins: number;
	losses: number;
	pushes: number;
	hitRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
}

export interface ManualPickBucketPerformanceSummary {
	computedAt: number;
	settledPicks: number;
	byTimeToStart: BucketPerformanceRow[];
	bySignalScore: BucketPerformanceRow[];
	byL2ImbalanceNearMid: BucketPerformanceRow[];
	byL2Disagreement: BucketPerformanceRow[];
}

export interface ManualPickClvTimingSegment {
	key: string;
	label: string;
	matchedPicks: number;
	withEventTime: number;
	byTimeToStart: BucketPerformanceRow[];
}

export interface ManualPickClvTimingSummary {
	computedAt: number;
	settledPicks: number;
	qualityThreshold: number;
	segments: ManualPickClvTimingSegment[];
}

export interface ManualPickShadowWindowRow {
	windowKey: string;
	windowLabel: string;
	leadMinutes: number | null;
	count: number;
	wins: number;
	losses: number;
	pushes: number;
	hitRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
}

export interface ManualPickShadowWindowSegment {
	key: string;
	label: string;
	matchedPicks: number;
	rows: ManualPickShadowWindowRow[];
}

export interface ManualPickShadowWindowSummary {
	computedAt: number;
	settledPicks: number;
	qualityThreshold: number;
	segments: ManualPickShadowWindowSegment[];
}

export interface ManualPickSportPerformanceRow {
	sportTag: string;
	label: string;
	seriesId?: number;
	totalCount: number;
	winRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
	qualityCount: number;
	qualityWinRate: number | null;
	qualityAvgRoi: number | null;
	qualityAvgClvBps: number | null;
}

export interface ManualPickSportPerformanceSummary {
	computedAt: number;
	settledPicks: number;
	qualityThreshold: number;
	rows: ManualPickSportPerformanceRow[];
}

export interface ManualPickMarketTypePerformanceRow {
	marketType: string;
	label: string;
	totalCount: number;
	winRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
	qualityCount: number;
	qualityWinRate: number | null;
	qualityAvgRoi: number | null;
	qualityAvgClvBps: number | null;
}

export interface ManualPickMarketTypePerformanceSummary {
	computedAt: number;
	settledPicks: number;
	qualityThreshold: number;
	rows: ManualPickMarketTypePerformanceRow[];
}

export interface ManualPickGradeRecalibrationRow {
	grade: string;
	count: number;
	wins: number;
	losses: number;
	pushes: number;
	winRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
	avgSignalScore: number | null;
	minSignalScore: number | null;
	maxSignalScore: number | null;
	avgEdgeRating: number | null;
	avgScoreDifferential: number | null;
	avgPriceEdge: number | null;
	avgPriceEdgeRatio: number | null;
}

export interface ManualPickGradeRecalibrationSummary {
	computedAt: number;
	settledPicks: number;
	rows: ManualPickGradeRecalibrationRow[];
	observations: string[];
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

// Rebucketed 2026-05-11: all 160 settled picks were piling into the old 0.72+
// bin because policy already gates at 0.72+. New buckets target the actual
// population range above the gate (typical microstructureScore ~0.85-0.95).
const QUALITY_SCORE_BUCKETS = [
	{ label: "<0.85", min: Number.NEGATIVE_INFINITY, max: 0.85 },
	{ label: "0.85-0.90", min: 0.85, max: 0.9 },
	{ label: "0.90-0.92", min: 0.9, max: 0.92 },
	{ label: "0.92-0.95", min: 0.92, max: 0.95 },
	{ label: "0.95+", min: 0.95, max: Number.POSITIVE_INFINITY },
] as const;

const TIME_TO_START_BUCKETS = [
	{ label: "0-15m", min: 0, max: 15 },
	{ label: "15-60m", min: 15, max: 60 },
	{ label: "1-3h", min: 60, max: 180 },
	{ label: "3h+", min: 180, max: Number.POSITIVE_INFINITY },
] as const;

const PERFORMANCE_SIGNAL_BUCKETS = [
	{ label: "<60", min: Number.NEGATIVE_INFINITY, max: 60 },
	{ label: "60-75", min: 60, max: 75 },
	{ label: "75-90", min: 75, max: 90 },
	{ label: "90+", min: 90, max: Number.POSITIVE_INFINITY },
] as const;

const PERFORMANCE_L2_IMBALANCE_BUCKETS = [
	{ label: "<=-0.10", min: Number.NEGATIVE_INFINITY, max: -0.1 },
	{ label: "-0.10 to 0.10", min: -0.1, max: 0.1 },
	{ label: ">=0.10", min: 0.1, max: Number.POSITIVE_INFINITY },
] as const;

const EDGE_RATING_BUCKETS = [
	{ label: "<66", min: Number.NEGATIVE_INFINITY, max: 66 },
	{ label: "66-72", min: 66, max: 72 },
	{ label: "72-80", min: 72, max: 80 },
	{ label: "80-90", min: 80, max: 90 },
	{ label: "90+", min: 90, max: Number.POSITIVE_INFINITY },
] as const;

const SCORE_DIFFERENTIAL_BUCKETS = [
	{ label: "<10", min: Number.NEGATIVE_INFINITY, max: 10 },
	{ label: "10-20", min: 10, max: 20 },
	{ label: "20-30", min: 20, max: 30 },
	{ label: "30-45", min: 30, max: 45 },
	{ label: "45+", min: 45, max: Number.POSITIVE_INFINITY },
] as const;

// Rebucketed 2026-05-11: 151/160 picks were in the old 0.08+ bin (avg priceEdge
// at A+/A/B is ~0.19-0.28). New buckets split the populated range so we can see
// whether higher priceEdge actually pays.
const PRICE_EDGE_BUCKETS = [
	{ label: "<0.10", min: Number.NEGATIVE_INFINITY, max: 0.1 },
	{ label: "0.10-0.15", min: 0.1, max: 0.15 },
	{ label: "0.15-0.20", min: 0.15, max: 0.2 },
	{ label: "0.20-0.30", min: 0.2, max: 0.3 },
	{ label: "0.30+", min: 0.3, max: Number.POSITIVE_INFINITY },
] as const;

// Rebucketed 2026-05-11: 155/160 picks were in the old 3.0+ bin (avg ratio at
// A+/A/B is ~10-18). New buckets split the populated range.
const PRICE_EDGE_RATIO_BUCKETS = [
	{ label: "<5", min: Number.NEGATIVE_INFINITY, max: 5 },
	{ label: "5-10", min: 5, max: 10 },
	{ label: "10-15", min: 10, max: 15 },
	{ label: "15-25", min: 15, max: 25 },
	{ label: "25+", min: 25, max: Number.POSITIVE_INFINITY },
] as const;

const GRADE_TO_SIGNAL_SCORE: Record<string, number> = {
	"A+": 95,
	A: 85,
	B: 70,
	C: 55,
	D: 40,
};

const SERIES_LABELS: Record<number, string> = {
	10187: "NFL",
	10345: "NBA",
	10210: "College Football",
	10470: "College Basketball",
	3: "MLB",
	10346: "NHL",
	10188: "Premier League",
};

const SPORT_TAG_TO_SERIES_ID: Record<string, number> = {
	nfl: 10187,
	nba: 10345,
	cfb: 10210,
	ncaab: 10470,
	mlb: 3,
	nhl: 10346,
	epl: 10188,
};

function parseStringArray(
	value: string | null | undefined,
): string[] | undefined {
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
		gameId: row.game_id ?? undefined,
		teamId: row.team_id ?? undefined,
		opponentId: row.opponent_id ?? undefined,
		betType: row.bet_type ?? undefined,
		sportTag: row.sport_tag ?? undefined,
		venueRole: row.venue_role ?? undefined,
		favDogRole: row.fav_dog_role ?? undefined,
		spreadLine: row.spread_line ?? undefined,
		totalLine: row.total_line ?? undefined,
		actualMargin: row.actual_margin ?? undefined,
		actualTotal: row.actual_total ?? undefined,
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
	    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
	options?: {
		status?: ManualPickStatus;
		limit?: number;
		sincePickedAt?: number;
		untilPickedAt?: number;
	},
): Promise<ManualPickEntry[]> {
	const { status, limit = 25, sincePickedAt, untilPickedAt } = options ?? {};
	const params: unknown[] = [];
	const conditions: string[] = [];
	if (status) {
		conditions.push(`status = ?`);
		params.push(status);
	}
	if (typeof sincePickedAt === "number" && Number.isFinite(sincePickedAt)) {
		conditions.push(`picked_at >= ?`);
		params.push(sincePickedAt);
	}
	if (typeof untilPickedAt === "number" && Number.isFinite(untilPickedAt)) {
		conditions.push(`picked_at < ?`);
		params.push(untilPickedAt);
	}
	let query = `SELECT * FROM manual_picks`;
	if (conditions.length > 0) {
		query += ` WHERE ${conditions.join(" AND ")}`;
	}
	query += ` ORDER BY picked_at DESC LIMIT ?`;
	params.push(limit);
	const rows = await all<ManualPickRow>(db, query, ...params);
	return rows.map(parsePickRow);
}

export async function getManualPicksSummary(
	db: Db,
	options?: {
		sincePickedAt?: number;
		untilPickedAt?: number;
	},
): Promise<ManualPickSummary> {
	const params: unknown[] = [];
	const conditions: string[] = [];
	if (
		typeof options?.sincePickedAt === "number" &&
		Number.isFinite(options.sincePickedAt)
	) {
		conditions.push("picked_at >= ?");
		params.push(options.sincePickedAt);
	}
	if (
		typeof options?.untilPickedAt === "number" &&
		Number.isFinite(options.untilPickedAt)
	) {
		conditions.push("picked_at < ?");
		params.push(options.untilPickedAt);
	}
	const whereClause =
		conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
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
    FROM manual_picks
		${whereClause}`,
		...params,
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

type MutableGradeBucketStats = MutableBucketStats & {
	signalScoreSum: number;
	signalScoreCount: number;
	minSignalScore: number | null;
	maxSignalScore: number | null;
	edgeRatingSum: number;
	edgeRatingCount: number;
	scoreDiffSum: number;
	scoreDiffCount: number;
	priceEdgeSum: number;
	priceEdgeCount: number;
	priceEdgeRatioSum: number;
	priceEdgeRatioCount: number;
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

function initMutableGradeBucket(label: string): MutableGradeBucketStats {
	return {
		label,
		count: 0,
		wins: 0,
		losses: 0,
		pushes: 0,
		roiSum: 0,
		roiCount: 0,
		clvBpsSum: 0,
		clvBpsCount: 0,
		signalScoreSum: 0,
		signalScoreCount: 0,
		minSignalScore: null,
		maxSignalScore: null,
		edgeRatingSum: 0,
		edgeRatingCount: 0,
		scoreDiffSum: 0,
		scoreDiffCount: 0,
		priceEdgeSum: 0,
		priceEdgeCount: 0,
		priceEdgeRatioSum: 0,
		priceEdgeRatioCount: 0,
	};
}

function bucketToOutput(
	bucket: MutableBucketStats,
): ManualPickCalibrationBucket {
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

function computeMinPriceEdgeForPick(pick: ManualPickEntry): number | null {
	const confidence = pick.confidence;
	const edgeRating = pick.edgeRating;
	if (
		!confidence ||
		typeof edgeRating !== "number" ||
		!Number.isFinite(edgeRating)
	)
		return null;
	const base =
		confidence === "HIGH" ? 0.02 : confidence === "MEDIUM" ? 0.03 : 0.04;
	const edgeBoost = Math.max(0, Math.min((edgeRating - 70) / 30, 1)) * 0.01;
	return Math.max(0.01, base - edgeBoost);
}

function applyPickToBucket(
	bucket: MutableBucketStats,
	pick: ManualPickEntry,
): void {
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

function applyPickToGradeBucket(
	bucket: MutableGradeBucketStats,
	pick: ManualPickEntry,
): void {
	applyPickToBucket(bucket, pick);
	const signalScore = resolveSignalScore(pick);
	if (signalScore !== null && Number.isFinite(signalScore)) {
		bucket.signalScoreSum += signalScore;
		bucket.signalScoreCount += 1;
		bucket.minSignalScore =
			bucket.minSignalScore === null
				? signalScore
				: Math.min(bucket.minSignalScore, signalScore);
		bucket.maxSignalScore =
			bucket.maxSignalScore === null
				? signalScore
				: Math.max(bucket.maxSignalScore, signalScore);
	}
	if (typeof pick.edgeRating === "number" && Number.isFinite(pick.edgeRating)) {
		bucket.edgeRatingSum += pick.edgeRating;
		bucket.edgeRatingCount += 1;
	}
	if (
		typeof pick.scoreDifferential === "number" &&
		Number.isFinite(pick.scoreDifferential)
	) {
		bucket.scoreDiffSum += pick.scoreDifferential;
		bucket.scoreDiffCount += 1;
	}
	if (typeof pick.priceEdge === "number" && Number.isFinite(pick.priceEdge)) {
		bucket.priceEdgeSum += pick.priceEdge;
		bucket.priceEdgeCount += 1;
		const minPriceEdge = computeMinPriceEdgeForPick(pick);
		if (minPriceEdge !== null && minPriceEdge > 0) {
			bucket.priceEdgeRatioSum += pick.priceEdge / minPriceEdge;
			bucket.priceEdgeRatioCount += 1;
		}
	}
}

function toPerformanceRows(
	buckets: MutableBucketStats[],
): BucketPerformanceRow[] {
	return buckets.map((bucket) => ({
		bucket: bucket.label,
		count: bucket.count,
		wins: bucket.wins,
		losses: bucket.losses,
		pushes: bucket.pushes,
		hitRate:
			bucket.wins + bucket.losses > 0
				? bucket.wins / (bucket.wins + bucket.losses)
				: null,
		avgRoi: bucket.roiCount > 0 ? bucket.roiSum / bucket.roiCount : null,
		avgClvBps:
			bucket.clvBpsCount > 0 ? bucket.clvBpsSum / bucket.clvBpsCount : null,
	}));
}

function extractNumber(obj: unknown, keys: string[]): number | null {
	if (typeof obj !== "object" || obj === null || Array.isArray(obj))
		return null;
	const record = obj as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return null;
}

function extractBoolean(obj: unknown, keys: string[]): boolean | null {
	if (typeof obj !== "object" || obj === null || Array.isArray(obj))
		return null;
	const record = obj as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "boolean") return value;
	}
	return null;
}

function resolveSignalScore(pick: ManualPickEntry): number | null {
	if (
		typeof pick.signalScore === "number" &&
		Number.isFinite(pick.signalScore)
	) {
		return pick.signalScore;
	}
	const snapshotScore = extractNumber(pick.decisionSnapshot, ["signalScore"]);
	if (snapshotScore !== null) return snapshotScore;
	if (!pick.grade) return null;
	return GRADE_TO_SIGNAL_SCORE[pick.grade] ?? null;
}

function resolveMarketQualityScore(pick: ManualPickEntry): number | null {
	if (
		typeof pick.marketQualityScore === "number" &&
		Number.isFinite(pick.marketQualityScore)
	) {
		return pick.marketQualityScore;
	}
	return extractNumber(pick.decisionSnapshot, ["marketQualityScore"]);
}

function extractString(obj: unknown, keys: string[]): string | null {
	if (typeof obj !== "object" || obj === null || Array.isArray(obj))
		return null;
	const record = obj as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0)
			return value.trim();
	}
	return null;
}

function extractSportSeriesId(pick: ManualPickEntry): number | null {
	const raw =
		extractNumber(pick.decisionSnapshot, ["sportSeriesId"]) ??
		extractNumber(pick.decisionSnapshot, ["sport_series_id"]);
	if (raw === null) return null;
	const asInt = Math.trunc(raw);
	return Number.isFinite(asInt) && asInt > 0 ? asInt : null;
}

function resolveSportForPick(
	pick: ManualPickEntry,
	fallbackSeriesId?: number,
): {
	sportTag: string;
	label: string;
	seriesId?: number;
} {
	const seriesId = extractSportSeriesId(pick) ?? fallbackSeriesId ?? null;
	if (seriesId && SERIES_LABELS[seriesId]) {
		return {
			sportTag: `series_${seriesId}`,
			label: SERIES_LABELS[seriesId],
			seriesId,
		};
	}

	const eventSlug = extractString(pick.decisionSnapshot, ["eventSlug"]);
	const marketSlug = extractString(pick.decisionSnapshot, ["marketSlug"]);
	const detected = detectSportTag({
		title: pick.marketTitle,
		eventSlug,
		slug: marketSlug,
	});
	if (detected) {
		const mappedSeriesId = SPORT_TAG_TO_SERIES_ID[detected];
		if (mappedSeriesId && SERIES_LABELS[mappedSeriesId]) {
			return {
				sportTag: `series_${mappedSeriesId}`,
				label: SERIES_LABELS[mappedSeriesId],
				seriesId: mappedSeriesId,
			};
		}
		return {
			sportTag: detected,
			label: detected.toUpperCase(),
		};
	}

	return {
		sportTag: "unknown",
		label: "Unknown",
	};
}

function formatMarketTypeLabel(marketType: string): string {
	switch (marketType) {
		case "moneyline":
			return "Moneyline";
		case "spread":
			return "Spread";
		case "total":
			return "Total";
		case "future":
			return "Future";
		case "prop":
			return "Prop";
		case "parlay":
			return "Parlay";
		default:
			return "Other";
	}
}

function resolveMarketTypeForPick(pick: ManualPickEntry): {
	marketType: string;
	label: string;
} {
	const snapshotMarketType = extractString(pick.decisionSnapshot, [
		"marketType",
		"market_type",
	]);
	const normalizedSnapshotMarketType = snapshotMarketType?.toLowerCase();
	if (
		normalizedSnapshotMarketType &&
		[
			"moneyline",
			"spread",
			"total",
			"future",
			"prop",
			"parlay",
			"other",
		].includes(normalizedSnapshotMarketType)
	) {
		return {
			marketType: normalizedSnapshotMarketType,
			label: formatMarketTypeLabel(normalizedSnapshotMarketType),
		};
	}

	const eventSlug = extractString(pick.decisionSnapshot, ["eventSlug"]);
	const marketSlug = extractString(pick.decisionSnapshot, ["marketSlug"]);
	const outcome = extractString(pick.decisionSnapshot, [
		"sharpSideLabel",
		"selectedOutcome",
		"outcomeLabel",
	]);
	const detected = detectBetType({
		title: pick.marketTitle,
		outcome,
		eventSlug,
		slug: marketSlug,
	});
	return {
		marketType: detected,
		label: formatMarketTypeLabel(detected),
	};
}

function buildTimeToStartRows(picks: ManualPickEntry[]): {
	withEventTime: number;
	rows: BucketPerformanceRow[];
} {
	const buckets = createMutableBuckets(
		TIME_TO_START_BUCKETS.map((bucket) => bucket.label),
	);
	let withEventTime = 0;
	for (const pick of picks) {
		if (!pick.eventTime) continue;
		const eventTimeMs = new Date(pick.eventTime).getTime();
		if (!Number.isFinite(eventTimeMs)) continue;
		const minutesToStart = (eventTimeMs - pick.pickedAt * 1000) / 60000;
		if (!Number.isFinite(minutesToStart) || minutesToStart < 0) continue;
		const index = bucketIndexFromRange(minutesToStart, TIME_TO_START_BUCKETS);
		if (index < 0) continue;
		withEventTime += 1;
		applyPickToBucket(buckets[index], pick);
	}
	return { withEventTime, rows: toPerformanceRows(buckets) };
}

function getPriceForSide(
	entry: {
		sideA?: { price?: number | null };
		sideB?: { price?: number | null };
	},
	sharpSide: "A" | "B",
): number | null {
	const value = sharpSide === "A" ? entry.sideA?.price : entry.sideB?.price;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;
}

export function findPriceAtOrBefore(
	history: NonNullable<SharpMoneyHistoryEntryByConditionId[string]>,
	sharpSide: "A" | "B",
	targetSeconds: number,
): number | null {
	for (let i = history.length - 1; i >= 0; i -= 1) {
		const row = history[i];
		if (row.recordedAt > targetSeconds) continue;
		const price = getPriceForSide(row, sharpSide);
		if (price !== null) return price;
	}
	return null;
}

function initMutableBucket(label: string): MutableBucketStats {
	return {
		label,
		count: 0,
		wins: 0,
		losses: 0,
		pushes: 0,
		roiSum: 0,
		roiCount: 0,
		clvBpsSum: 0,
		clvBpsCount: 0,
	};
}

function bucketToShadowWindowRow(
	bucket: MutableBucketStats,
	windowKey: string,
	windowLabel: string,
	leadMinutes: number | null,
): ManualPickShadowWindowRow {
	return {
		windowKey,
		windowLabel,
		leadMinutes,
		count: bucket.count,
		wins: bucket.wins,
		losses: bucket.losses,
		pushes: bucket.pushes,
		hitRate:
			bucket.wins + bucket.losses > 0
				? bucket.wins / (bucket.wins + bucket.losses)
				: null,
		avgRoi: bucket.roiCount > 0 ? bucket.roiSum / bucket.roiCount : null,
		avgClvBps:
			bucket.clvBpsCount > 0 ? bucket.clvBpsSum / bucket.clvBpsCount : null,
	};
}

export async function getManualPicksCalibrationSummary(
	db: Db,
	options?: { limit?: number; sincePickedAt?: number; untilPickedAt?: number },
): Promise<ManualPickCalibrationSummary> {
	const limit = options?.limit && options.limit > 0 ? options.limit : 2000;
	const picks = await listManualPicks(db, {
		limit,
		sincePickedAt: options?.sincePickedAt,
		untilPickedAt: options?.untilPickedAt,
	});
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
	const edgeRatingBuckets = createMutableBuckets(
		EDGE_RATING_BUCKETS.map((bucket) => bucket.label),
	);
	const scoreDiffBuckets = createMutableBuckets(
		SCORE_DIFFERENTIAL_BUCKETS.map((bucket) => bucket.label),
	);
	const priceEdgeBuckets = createMutableBuckets(
		PRICE_EDGE_BUCKETS.map((bucket) => bucket.label),
	);
	const priceEdgeRatioBuckets = createMutableBuckets(
		PRICE_EDGE_RATIO_BUCKETS.map((bucket) => bucket.label),
	);

	let withSignalScore = 0;
	let withQualityScore = 0;
	let withEventTime = 0;
	let withEdgeRating = 0;
	let withScoreDifferential = 0;
	let withPriceEdge = 0;
	let withPriceEdgeRatio = 0;

	for (const pick of settled) {
		const signalScore = resolveSignalScore(pick);
		if (signalScore !== null) {
			const index = bucketIndexFromRange(signalScore, SIGNAL_SCORE_BUCKETS);
			if (index >= 0) {
				withSignalScore += 1;
				applyPickToBucket(signalBuckets[index], pick);
			}
		}

		const marketQualityScore = resolveMarketQualityScore(pick);
		if (marketQualityScore !== null) {
			const index = bucketIndexFromRange(
				marketQualityScore,
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
					const index = bucketIndexFromRange(
						minutesToStart,
						TIME_TO_START_BUCKETS,
					);
					if (index >= 0) {
						withEventTime += 1;
						applyPickToBucket(timeBuckets[index], pick);
					}
				}
			}
		}

		if (
			typeof pick.edgeRating === "number" &&
			Number.isFinite(pick.edgeRating)
		) {
			const index = bucketIndexFromRange(pick.edgeRating, EDGE_RATING_BUCKETS);
			if (index >= 0) {
				withEdgeRating += 1;
				applyPickToBucket(edgeRatingBuckets[index], pick);
			}
		}

		if (
			typeof pick.scoreDifferential === "number" &&
			Number.isFinite(pick.scoreDifferential)
		) {
			const index = bucketIndexFromRange(
				pick.scoreDifferential,
				SCORE_DIFFERENTIAL_BUCKETS,
			);
			if (index >= 0) {
				withScoreDifferential += 1;
				applyPickToBucket(scoreDiffBuckets[index], pick);
			}
		}

		if (typeof pick.priceEdge === "number" && Number.isFinite(pick.priceEdge)) {
			const index = bucketIndexFromRange(pick.priceEdge, PRICE_EDGE_BUCKETS);
			if (index >= 0) {
				withPriceEdge += 1;
				applyPickToBucket(priceEdgeBuckets[index], pick);
			}

			const minPriceEdge = computeMinPriceEdgeForPick(pick);
			if (minPriceEdge !== null && minPriceEdge > 0) {
				const ratio = pick.priceEdge / minPriceEdge;
				const ratioIndex = bucketIndexFromRange(
					ratio,
					PRICE_EDGE_RATIO_BUCKETS,
				);
				if (ratioIndex >= 0) {
					withPriceEdgeRatio += 1;
					applyPickToBucket(priceEdgeRatioBuckets[ratioIndex], pick);
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
		withEdgeRating,
		withScoreDifferential,
		withPriceEdge,
		withPriceEdgeRatio,
		bySignalScore: signalBuckets.map(bucketToOutput),
		byQualityScore: qualityBuckets.map(bucketToOutput),
		byTimeToStart: timeBuckets.map(bucketToOutput),
		byEdgeRating: edgeRatingBuckets.map(bucketToOutput),
		byScoreDifferential: scoreDiffBuckets.map(bucketToOutput),
		byPriceEdge: priceEdgeBuckets.map(bucketToOutput),
		byPriceEdgeRatio: priceEdgeRatioBuckets.map(bucketToOutput),
	};
}

export async function getManualPicksBucketPerformanceSummary(
	db: Db,
	options?: { limit?: number; sincePickedAt?: number; untilPickedAt?: number },
): Promise<ManualPickBucketPerformanceSummary> {
	const limit = options?.limit && options.limit > 0 ? options.limit : 2000;
	const picks = await listManualPicks(db, {
		limit,
		sincePickedAt: options?.sincePickedAt,
		untilPickedAt: options?.untilPickedAt,
	});
	const settled = picks.filter((pick) => pick.status !== "pending");
	const timeBuckets = createMutableBuckets(
		TIME_TO_START_BUCKETS.map((bucket) => bucket.label),
	);
	const signalBuckets = createMutableBuckets(
		PERFORMANCE_SIGNAL_BUCKETS.map((bucket) => bucket.label),
	);
	const l2ImbalanceBuckets = createMutableBuckets(
		PERFORMANCE_L2_IMBALANCE_BUCKETS.map((bucket) => bucket.label),
	);
	const l2DisagreementBuckets = createMutableBuckets([
		"disagree",
		"agree_or_neutral",
	]);

	for (const pick of settled) {
		const signalScore = resolveSignalScore(pick);
		if (signalScore !== null) {
			const signalBucketIndex = bucketIndexFromRange(
				signalScore,
				PERFORMANCE_SIGNAL_BUCKETS,
			);
			if (signalBucketIndex >= 0) {
				applyPickToBucket(signalBuckets[signalBucketIndex], pick);
			}
		}

		if (pick.eventTime) {
			const eventTimeMs = new Date(pick.eventTime).getTime();
			if (Number.isFinite(eventTimeMs)) {
				const minutesToStart = (eventTimeMs - pick.pickedAt * 1000) / 60000;
				if (Number.isFinite(minutesToStart) && minutesToStart >= 0) {
					const timeBucketIndex = bucketIndexFromRange(
						minutesToStart,
						TIME_TO_START_BUCKETS,
					);
					if (timeBucketIndex >= 0) {
						applyPickToBucket(timeBuckets[timeBucketIndex], pick);
					}
				}
			}
		}

		const l2ImbalanceNearMid = extractNumber(pick.decisionSnapshot, [
			"l2ImbalanceNearMid",
			"imbalanceNearMid",
		]);
		if (l2ImbalanceNearMid !== null) {
			const l2BucketIndex = bucketIndexFromRange(
				l2ImbalanceNearMid,
				PERFORMANCE_L2_IMBALANCE_BUCKETS,
			);
			if (l2BucketIndex >= 0) {
				applyPickToBucket(l2ImbalanceBuckets[l2BucketIndex], pick);
			}
		}

		const l2Disagreement = extractBoolean(pick.decisionSnapshot, [
			"l2Disagreement",
			"imbalanceDisagree",
		]);
		if (l2Disagreement !== null) {
			applyPickToBucket(
				l2Disagreement ? l2DisagreementBuckets[0] : l2DisagreementBuckets[1],
				pick,
			);
		}
	}

	return {
		computedAt: nowUnixSeconds(),
		settledPicks: settled.length,
		byTimeToStart: toPerformanceRows(timeBuckets),
		bySignalScore: toPerformanceRows(signalBuckets),
		byL2ImbalanceNearMid: toPerformanceRows(l2ImbalanceBuckets),
		byL2Disagreement: toPerformanceRows(l2DisagreementBuckets),
	};
}

export async function getManualPicksClvTimingSummary(
	db: Db,
	options?: {
		limit?: number;
		qualityThreshold?: number;
		sincePickedAt?: number;
		untilPickedAt?: number;
	},
): Promise<ManualPickClvTimingSummary> {
	const limit = options?.limit && options.limit > 0 ? options.limit : 2000;
	const qualityThreshold =
		typeof options?.qualityThreshold === "number" &&
		Number.isFinite(options.qualityThreshold)
			? options.qualityThreshold
			: 0.66;
	const picks = await listManualPicks(db, {
		limit,
		sincePickedAt: options?.sincePickedAt,
		untilPickedAt: options?.untilPickedAt,
	});
	const settled = picks.filter((pick) => pick.status !== "pending");
	const segments = [
		{
			key: "all",
			label: "All settled",
			filter: (_pick: ManualPickEntry) => true,
		},
		{
			key: "grade_a_plus",
			label: "Grade A+",
			filter: (pick: ManualPickEntry) => pick.grade === "A+",
		},
		{
			key: "grade_a_or_better",
			label: "Grade A/A+",
			filter: (pick: ManualPickEntry) =>
				pick.grade === "A+" || pick.grade === "A",
		},
		{
			key: "quality_threshold",
			label: `Quality >= ${qualityThreshold.toFixed(2)}`,
			filter: (pick: ManualPickEntry) =>
				(resolveMarketQualityScore(pick) ?? Number.NEGATIVE_INFINITY) >=
				qualityThreshold,
		},
		{
			key: "grade_and_quality",
			label: `Grade A/A+ and Quality >= ${qualityThreshold.toFixed(2)}`,
			filter: (pick: ManualPickEntry) =>
				(pick.grade === "A+" || pick.grade === "A") &&
				(resolveMarketQualityScore(pick) ?? Number.NEGATIVE_INFINITY) >=
					qualityThreshold,
		},
	] as const;

	return {
		computedAt: nowUnixSeconds(),
		settledPicks: settled.length,
		qualityThreshold,
		segments: segments.map((segment) => {
			const matchedPicks = settled.filter((pick) => segment.filter(pick));
			const timeRows = buildTimeToStartRows(matchedPicks);
			return {
				key: segment.key,
				label: segment.label,
				matchedPicks: matchedPicks.length,
				withEventTime: timeRows.withEventTime,
				byTimeToStart: timeRows.rows,
			};
		}),
	};
}

export async function getManualPicksShadowWindowSummary(
	db: Db,
	options?: {
		limit?: number;
		qualityThreshold?: number;
		sincePickedAt?: number;
		untilPickedAt?: number;
	},
): Promise<ManualPickShadowWindowSummary> {
	const limit = options?.limit && options.limit > 0 ? options.limit : 2000;
	const qualityThreshold =
		typeof options?.qualityThreshold === "number" &&
		Number.isFinite(options.qualityThreshold)
			? options.qualityThreshold
			: 0.66;
	const picks = await listManualPicks(db, {
		limit,
		sincePickedAt: options?.sincePickedAt,
		untilPickedAt: options?.untilPickedAt,
	});
	const settled = picks.filter(
		(pick) =>
			pick.status !== "pending" &&
			(pick.sharpSide === "A" || pick.sharpSide === "B"),
	);
	const candidates = settled
		.map((pick) => {
			const eventTimeMs = pick.eventTime
				? new Date(pick.eventTime).getTime()
				: Number.NaN;
			if (!Number.isFinite(eventTimeMs)) return null;
			return {
				pick,
				eventTimeSeconds: Math.floor(eventTimeMs / 1000),
				sharpSide: pick.sharpSide as "A" | "B",
			};
		})
		.filter((value): value is NonNullable<typeof value> => value !== null);

	if (candidates.length === 0) {
		return {
			computedAt: nowUnixSeconds(),
			settledPicks: settled.length,
			qualityThreshold,
			segments: [],
		};
	}

	const earliestEventTime = Math.min(
		...candidates.map((entry) => entry.eventTimeSeconds),
	);
	const historySince = earliestEventTime - 4 * 60 * 60;
	const conditionIds = Array.from(
		new Set(candidates.map((entry) => entry.pick.conditionId)),
	);
	let historyByConditionId: SharpMoneyHistoryEntryByConditionId = {};
	try {
		historyByConditionId = await listSharpMoneyHistoryByConditionIds(
			db,
			conditionIds,
			historySince,
		);
	} catch (error) {
		console.warn(
			"[manual-picks] shadow window history lookup failed; using empty history",
			error,
		);
	}

	const windows = [
		{
			key: "actual",
			label: "Actual entry",
			leadMinutes: null as number | null,
		},
		{ key: "t120", label: "T-120m", leadMinutes: 120 },
		{ key: "t60", label: "T-60m", leadMinutes: 60 },
		{ key: "t30", label: "T-30m", leadMinutes: 30 },
		{ key: "t15", label: "T-15m", leadMinutes: 15 },
		{ key: "t5", label: "T-5m", leadMinutes: 5 },
		{ key: "t2", label: "T-2m", leadMinutes: 2 },
	] as const;

	const segments = [
		{
			key: "all",
			label: "All settled",
			filter: (_pick: ManualPickEntry) => true,
		},
		{
			key: "grade_a_plus",
			label: "Grade A+",
			filter: (pick: ManualPickEntry) => pick.grade === "A+",
		},
		{
			key: "grade_a_or_better",
			label: "Grade A/A+",
			filter: (pick: ManualPickEntry) =>
				pick.grade === "A+" || pick.grade === "A",
		},
		{
			key: "quality_threshold",
			label: `Quality >= ${qualityThreshold.toFixed(2)}`,
			filter: (pick: ManualPickEntry) =>
				(resolveMarketQualityScore(pick) ?? Number.NEGATIVE_INFINITY) >=
				qualityThreshold,
		},
		{
			key: "grade_and_quality",
			label: `Grade A/A+ and Quality >= ${qualityThreshold.toFixed(2)}`,
			filter: (pick: ManualPickEntry) =>
				(pick.grade === "A+" || pick.grade === "A") &&
				(resolveMarketQualityScore(pick) ?? Number.NEGATIVE_INFINITY) >=
					qualityThreshold,
		},
	] as const;

	return {
		computedAt: nowUnixSeconds(),
		settledPicks: settled.length,
		qualityThreshold,
		segments: segments.map((segment) => {
			const segmentCandidates = candidates.filter(({ pick }) =>
				segment.filter(pick),
			);
			const rows = windows.map((window) => {
				const bucket = initMutableBucket(window.label);
				for (const candidate of segmentCandidates) {
					const history = historyByConditionId[candidate.pick.conditionId];
					if (!history || history.length === 0) continue;
					const closePrice = findPriceAtOrBefore(
						history,
						candidate.sharpSide,
						candidate.eventTimeSeconds,
					);
					if (window.key === "actual") {
						const entryPrice =
							(typeof candidate.pick.price === "number" &&
							Number.isFinite(candidate.pick.price) &&
							candidate.pick.price > 0
								? candidate.pick.price
								: findPriceAtOrBefore(
										history,
										candidate.sharpSide,
										candidate.pick.pickedAt,
									)) ?? null;
						if (entryPrice === null) continue;
						applyPickToBucket(bucket, {
							...candidate.pick,
							clv:
								closePrice !== null && Number.isFinite(closePrice)
									? closePrice - entryPrice
									: undefined,
						});
						continue;
					}
					const targetSeconds =
						candidate.eventTimeSeconds - (window.leadMinutes ?? 0) * 60;
					const entryPrice = findPriceAtOrBefore(
						history,
						candidate.sharpSide,
						targetSeconds,
					);
					if (entryPrice === null) continue;
					const syntheticRoi =
						candidate.pick.status === "win"
							? 1 / entryPrice - 1
							: candidate.pick.status === "loss"
								? -1
								: 0;
					applyPickToBucket(bucket, {
						...candidate.pick,
						price: entryPrice,
						roi: syntheticRoi,
						clv:
							closePrice !== null && Number.isFinite(closePrice)
								? closePrice - entryPrice
								: undefined,
					});
				}
				return bucketToShadowWindowRow(
					bucket,
					window.key,
					window.label,
					window.leadMinutes,
				);
			});
			return {
				key: segment.key,
				label: segment.label,
				matchedPicks: segmentCandidates.length,
				rows,
			};
		}),
	};
}

export async function getManualPicksSportPerformanceSummary(
	db: Db,
	options?: {
		limit?: number;
		qualityThreshold?: number;
		sincePickedAt?: number;
		untilPickedAt?: number;
	},
): Promise<ManualPickSportPerformanceSummary> {
	const limit = options?.limit && options.limit > 0 ? options.limit : 2000;
	const qualityThreshold =
		typeof options?.qualityThreshold === "number" &&
		Number.isFinite(options.qualityThreshold)
			? options.qualityThreshold
			: 0.66;
	const picks = await listManualPicks(db, {
		limit,
		sincePickedAt: options?.sincePickedAt,
		untilPickedAt: options?.untilPickedAt,
	});
	const settled = picks.filter((pick) => pick.status !== "pending");
	const conditionIds = Array.from(
		new Set(settled.map((pick) => pick.conditionId)),
	);
	let historyByConditionId: SharpMoneyHistoryEntryByConditionId = {};
	try {
		historyByConditionId = await listSharpMoneyHistoryByConditionIds(
			db,
			conditionIds,
			nowUnixSeconds() - 30 * 24 * 60 * 60,
		);
	} catch (error) {
		console.warn(
			"[manual-picks] sport performance history lookup failed; using fallback sport detection only",
			error,
		);
	}
	const fallbackSeriesIdByConditionId = new Map<string, number>();
	for (const [conditionId, rows] of Object.entries(historyByConditionId)) {
		for (let i = rows.length - 1; i >= 0; i -= 1) {
			const seriesId = rows[i].sportSeriesId;
			if (typeof seriesId === "number" && Number.isFinite(seriesId)) {
				fallbackSeriesIdByConditionId.set(conditionId, seriesId);
				break;
			}
		}
	}

	const statsBySport = new Map<
		string,
		{
			sportTag: string;
			label: string;
			seriesId?: number;
			all: MutableBucketStats;
			quality: MutableBucketStats;
		}
	>();

	for (const pick of settled) {
		const sport = resolveSportForPick(
			pick,
			fallbackSeriesIdByConditionId.get(pick.conditionId),
		);
		const existing = statsBySport.get(sport.sportTag) ?? {
			sportTag: sport.sportTag,
			label: sport.label,
			seriesId: sport.seriesId,
			all: initMutableBucket("all"),
			quality: initMutableBucket("quality"),
		};
		applyPickToBucket(existing.all, pick);
		const qualityScore = resolveMarketQualityScore(pick);
		if (
			qualityScore !== null &&
			Number.isFinite(qualityScore) &&
			qualityScore >= qualityThreshold
		) {
			applyPickToBucket(existing.quality, pick);
		}
		statsBySport.set(sport.sportTag, existing);
	}

	const rows: ManualPickSportPerformanceRow[] = Array.from(
		statsBySport.values(),
	)
		.map((entry) => {
			const allRow = bucketToShadowWindowRow(entry.all, "all", "all", null);
			const qualityRow = bucketToShadowWindowRow(
				entry.quality,
				"quality",
				"quality",
				null,
			);
			return {
				sportTag: entry.sportTag,
				label: entry.label,
				seriesId: entry.seriesId,
				totalCount: allRow.count,
				winRate: allRow.hitRate,
				avgRoi: allRow.avgRoi,
				avgClvBps: allRow.avgClvBps,
				qualityCount: qualityRow.count,
				qualityWinRate: qualityRow.hitRate,
				qualityAvgRoi: qualityRow.avgRoi,
				qualityAvgClvBps: qualityRow.avgClvBps,
			};
		})
		.sort((a, b) => {
			if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
			return a.label.localeCompare(b.label);
		});

	return {
		computedAt: nowUnixSeconds(),
		settledPicks: settled.length,
		qualityThreshold,
		rows,
	};
}

export async function getManualPicksMarketTypePerformanceSummary(
	db: Db,
	options?: {
		limit?: number;
		qualityThreshold?: number;
		sincePickedAt?: number;
		untilPickedAt?: number;
	},
): Promise<ManualPickMarketTypePerformanceSummary> {
	const limit = options?.limit && options.limit > 0 ? options.limit : 2000;
	const qualityThreshold =
		typeof options?.qualityThreshold === "number" &&
		Number.isFinite(options.qualityThreshold)
			? options.qualityThreshold
			: 0.66;
	const picks = await listManualPicks(db, {
		limit,
		sincePickedAt: options?.sincePickedAt,
		untilPickedAt: options?.untilPickedAt,
	});
	const settled = picks.filter((pick) => pick.status !== "pending");

	const statsByMarketType = new Map<
		string,
		{
			marketType: string;
			label: string;
			all: MutableBucketStats;
			quality: MutableBucketStats;
		}
	>();

	for (const pick of settled) {
		const marketType = resolveMarketTypeForPick(pick);
		const existing = statsByMarketType.get(marketType.marketType) ?? {
			marketType: marketType.marketType,
			label: marketType.label,
			all: initMutableBucket("all"),
			quality: initMutableBucket("quality"),
		};
		applyPickToBucket(existing.all, pick);
		const qualityScore = resolveMarketQualityScore(pick);
		if (
			qualityScore !== null &&
			Number.isFinite(qualityScore) &&
			qualityScore >= qualityThreshold
		) {
			applyPickToBucket(existing.quality, pick);
		}
		statsByMarketType.set(marketType.marketType, existing);
	}

	const rows: ManualPickMarketTypePerformanceRow[] = Array.from(
		statsByMarketType.values(),
	)
		.map((entry) => {
			const allRow = bucketToShadowWindowRow(entry.all, "all", "all", null);
			const qualityRow = bucketToShadowWindowRow(
				entry.quality,
				"quality",
				"quality",
				null,
			);
			return {
				marketType: entry.marketType,
				label: entry.label,
				totalCount: allRow.count,
				winRate: allRow.hitRate,
				avgRoi: allRow.avgRoi,
				avgClvBps: allRow.avgClvBps,
				qualityCount: qualityRow.count,
				qualityWinRate: qualityRow.hitRate,
				qualityAvgRoi: qualityRow.avgRoi,
				qualityAvgClvBps: qualityRow.avgClvBps,
			};
		})
		.sort((a, b) => {
			if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
			return a.label.localeCompare(b.label);
		});

	return {
		computedAt: nowUnixSeconds(),
		settledPicks: settled.length,
		qualityThreshold,
		rows,
	};
}

export async function getManualPicksGradeRecalibrationSummary(
	db: Db,
	options?: { limit?: number; sincePickedAt?: number; untilPickedAt?: number },
): Promise<ManualPickGradeRecalibrationSummary> {
	const limit = options?.limit && options.limit > 0 ? options.limit : 2000;
	const picks = await listManualPicks(db, {
		limit,
		sincePickedAt: options?.sincePickedAt,
		untilPickedAt: options?.untilPickedAt,
	});
	const settled = picks.filter((pick) => pick.status !== "pending");
	const gradeOrder = ["A+", "A", "B", "C", "D", "Unknown"];
	const statsByGrade = new Map<string, MutableGradeBucketStats>(
		gradeOrder.map((grade) => [grade, initMutableGradeBucket(grade)]),
	);

	for (const pick of settled) {
		const grade = pick.grade?.trim() ? pick.grade.trim() : "Unknown";
		const bucket = statsByGrade.get(grade) ?? initMutableGradeBucket(grade);
		applyPickToGradeBucket(bucket, pick);
		statsByGrade.set(grade, bucket);
	}

	const rows: ManualPickGradeRecalibrationRow[] = Array.from(
		statsByGrade.entries(),
	)
		.map(([grade, bucket]) => ({
			grade,
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
			avgSignalScore:
				bucket.signalScoreCount > 0
					? bucket.signalScoreSum / bucket.signalScoreCount
					: null,
			minSignalScore: bucket.minSignalScore,
			maxSignalScore: bucket.maxSignalScore,
			avgEdgeRating:
				bucket.edgeRatingCount > 0
					? bucket.edgeRatingSum / bucket.edgeRatingCount
					: null,
			avgScoreDifferential:
				bucket.scoreDiffCount > 0
					? bucket.scoreDiffSum / bucket.scoreDiffCount
					: null,
			avgPriceEdge:
				bucket.priceEdgeCount > 0
					? bucket.priceEdgeSum / bucket.priceEdgeCount
					: null,
			avgPriceEdgeRatio:
				bucket.priceEdgeRatioCount > 0
					? bucket.priceEdgeRatioSum / bucket.priceEdgeRatioCount
					: null,
		}))
		.filter((row) => row.count > 0)
		.sort((a, b) => {
			const aIndex = gradeOrder.indexOf(a.grade);
			const bIndex = gradeOrder.indexOf(b.grade);
			if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
			if (aIndex >= 0) return -1;
			if (bIndex >= 0) return 1;
			return a.grade.localeCompare(b.grade);
		});

	const observations: string[] = [];
	const aPlus = rows.find((row) => row.grade === "A+");
	const a = rows.find((row) => row.grade === "A");
	const b = rows.find((row) => row.grade === "B");
	if (
		aPlus &&
		a &&
		aPlus.count >= 20 &&
		a.count >= 20 &&
		(aPlus.avgClvBps ?? Number.NEGATIVE_INFINITY) <=
			(a.avgClvBps ?? Number.NEGATIVE_INFINITY)
	) {
		observations.push("A+ is not outperforming A on average CLV.");
	}
	if (
		a &&
		b &&
		a.count >= 20 &&
		b.count >= 20 &&
		(a.avgClvBps ?? Number.NEGATIVE_INFINITY) <=
			(b.avgClvBps ?? Number.NEGATIVE_INFINITY)
	) {
		observations.push("A is not outperforming B on average CLV.");
	}
	const highScoreBucket = settled.filter((pick) => {
		const signalScore = resolveSignalScore(pick);
		return signalScore !== null && signalScore >= 90;
	});
	const midScoreBucket = settled.filter((pick) => {
		const signalScore = resolveSignalScore(pick);
		return signalScore !== null && signalScore >= 75 && signalScore < 90;
	});
	const avgClvFor = (items: ManualPickEntry[]) => {
		let sum = 0;
		let count = 0;
		for (const item of items) {
			if (typeof item.clv === "number" && Number.isFinite(item.clv)) {
				sum += item.clv * 10000;
				count += 1;
			}
		}
		return count > 0 ? sum / count : null;
	};
	const highScoreAvgClv = avgClvFor(highScoreBucket);
	const midScoreAvgClv = avgClvFor(midScoreBucket);
	if (
		highScoreBucket.length >= 20 &&
		midScoreBucket.length >= 20 &&
		(highScoreAvgClv ?? Number.NEGATIVE_INFINITY) <=
			(midScoreAvgClv ?? Number.NEGATIVE_INFINITY)
	) {
		observations.push("90+ signal scores are not outperforming 75-90 scores.");
	}
	if (observations.length === 0) {
		observations.push(
			"No obvious grade-order inversion detected in current sample.",
		);
	}

	return {
		computedAt: nowUnixSeconds(),
		settledPicks: settled.length,
		rows,
		observations,
	};
}
