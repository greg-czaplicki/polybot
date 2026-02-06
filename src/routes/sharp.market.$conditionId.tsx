import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import {
	getClobDepthSnapshotFn,
	getSharpMoneyCacheEntryFn,
	type ClobDepthSnapshot,
	type ClobOutcomeBook,
} from "../server/api/sharp-money";

export const Route = createFileRoute("/sharp/market/$conditionId")({
	component: SharpMarketDepthPage,
});

const PRICE_FORMATTER = new Intl.NumberFormat("en-US", {
	minimumFractionDigits: 3,
	maximumFractionDigits: 3,
});

const SIZE_FORMATTER = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});

const MAX_TREND_POINTS = 120;

type BookTrendPoint = {
	timestamp: number;
	spread: number | null;
	imbalance: number | null;
};

function formatPercent(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "—";
	}
	return `${(value * 100).toFixed(2)}%`;
}

function formatPrice(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "—";
	}
	return PRICE_FORMATTER.format(value);
}

function formatSize(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "—";
	}
	return SIZE_FORMATTER.format(value);
}

function formatRelativeTime(timestamp?: number): string {
	if (!timestamp) return "Never";
	const now = Math.floor(Date.now() / 1000);
	const diff = now - timestamp;
	if (diff < 10) return "Just now";
	if (diff < 60) return `${diff}s ago`;
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	return `${Math.floor(diff / 3600)}h ago`;
}

function getDepthWallThreshold(levels: Array<{ notional: number }>): number {
	if (levels.length === 0) return Number.POSITIVE_INFINITY;
	const sorted = levels
		.map((level) => level.notional)
		.filter((value) => Number.isFinite(value) && value > 0)
		.sort((a, b) => b - a);
	if (sorted.length === 0) return Number.POSITIVE_INFINITY;
	return sorted[Math.min(2, sorted.length - 1)] ?? sorted[0];
}

function buildSparkPath(
	points: number[],
	width: number,
	height: number,
	padding: number,
): string {
	if (points.length < 2) return "";
	const min = Math.min(...points);
	const max = Math.max(...points);
	const range = max - min;
	const safeRange = range === 0 ? Math.max(Math.abs(max), 1e-6) : range;
	return points
		.map((value, index) => {
			const x =
				padding + (index / (points.length - 1)) * (width - padding * 2);
			const normalized = (value - min) / safeRange;
			const y = height - padding - normalized * (height - padding * 2);
			return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");
}

function renderTrendChart(points: BookTrendPoint[]): JSX.Element {
	const spreadPoints = points
		.map((point) => point.spread)
		.filter((value): value is number =>
			typeof value === "number" && Number.isFinite(value),
		);
	const imbalancePoints = points
		.map((point) => point.imbalance)
		.filter((value): value is number =>
			typeof value === "number" && Number.isFinite(value),
		);

	const width = 320;
	const height = 68;
	const padding = 8;
	const spreadPath = buildSparkPath(spreadPoints, width, height, padding);
	const imbalancePath = buildSparkPath(imbalancePoints, width, height, padding);

	return (
		<div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
			<div className="mb-1 flex items-center justify-between text-[0.65rem] text-slate-400">
				<span>Trend (last {points.length} snapshots)</span>
				<span>
					Spread {formatPercent(spreadPoints.at(-1) ?? null)} • Imb {formatPercent(imbalancePoints.at(-1) ?? null)}
				</span>
			</div>
			<svg
				viewBox={`0 0 ${width} ${height}`}
				className="h-16 w-full"
				role="img"
				aria-label="Spread and imbalance trend"
			>
				<title>Spread and imbalance trend</title>
				<rect x="0" y="0" width={width} height={height} fill="transparent" />
				<line
					x1={padding}
					y1={height / 2}
					x2={width - padding}
					y2={height / 2}
					stroke="rgba(148,163,184,0.25)"
					strokeWidth="1"
					strokeDasharray="3 3"
				/>
				{spreadPath && (
					<path
						d={spreadPath}
						fill="none"
						stroke="rgb(34,211,238)"
						strokeWidth="2"
					/>
				)}
				{imbalancePath && (
					<path
						d={imbalancePath}
						fill="none"
						stroke="rgb(250,204,21)"
						strokeWidth="2"
					/>
				)}
			</svg>
			<div className="mt-1 flex items-center gap-3 text-[0.65rem] text-slate-400">
				<span className="inline-flex items-center gap-1">
					<span className="h-2 w-2 rounded-full bg-cyan-400" /> Spread
				</span>
				<span className="inline-flex items-center gap-1">
					<span className="h-2 w-2 rounded-full bg-yellow-300" /> Imbalance
				</span>
			</div>
		</div>
	);
}

function levelRowClass(
	notional: number,
	maxNotional: number,
	wallThreshold: number,
	base: string,
	highlight: string,
): string {
	if (!Number.isFinite(notional) || notional <= 0) return base;
	if (notional === maxNotional) return `${base} ${highlight} ring-1 ring-cyan-300/60`;
	if (notional >= wallThreshold) return `${base} ${highlight}`;
	return base;
}

function SharpMarketDepthPage() {
	const { conditionId } = Route.useParams();
	const [snapshot, setSnapshot] = useState<ClobDepthSnapshot | null>(null);
	const [marketTitle, setMarketTitle] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [levelLimit, setLevelLimit] = useState(10);
	const [trendByTokenId, setTrendByTokenId] = useState<
		Record<string, BookTrendPoint[]>
	>({});

	const loadSnapshot = useCallback(
		async (initial?: boolean) => {
			if (initial) {
				setIsLoading(true);
			} else {
				setIsRefreshing(true);
			}
			setError(null);
			try {
				const [cacheResult, depthResult] = await Promise.all([
					getSharpMoneyCacheEntryFn({ data: { conditionId } }),
					getClobDepthSnapshotFn({ data: { conditionId, levelLimit } }),
				]);
				setMarketTitle(cacheResult.entry?.marketTitle ?? null);
				if (depthResult.error) {
					setError(depthResult.error);
					return;
				}
				setSnapshot((depthResult.snapshot ?? null) as ClobDepthSnapshot | null);
			} catch (err) {
				console.error("Failed to load CLOB depth", err);
				setError("Failed to load CLOB depth snapshot");
			} finally {
				setIsLoading(false);
				setIsRefreshing(false);
			}
		},
		[conditionId, levelLimit],
	);

	useEffect(() => {
		void loadSnapshot(true);
	}, [loadSnapshot]);

	useEffect(() => {
		const interval = setInterval(() => {
			if (document.hidden) return;
			void loadSnapshot(false);
		}, 3000);
		return () => clearInterval(interval);
	}, [loadSnapshot]);

	useEffect(() => {
		if (!snapshot) return;
		setTrendByTokenId((prev) => {
			const next: Record<string, BookTrendPoint[]> = {};
			for (const outcome of snapshot.outcomes) {
				const current = prev[outcome.tokenId] ?? [];
				const point: BookTrendPoint = {
					timestamp: snapshot.fetchedAt,
					spread: outcome.spread,
					imbalance: outcome.imbalance,
				};
				const deduped =
					current.length > 0 && current[current.length - 1]?.timestamp === point.timestamp
						? [...current.slice(0, -1), point]
						: [...current, point];
				next[outcome.tokenId] = deduped.slice(-MAX_TREND_POINTS);
			}
			return next;
		});
	}, [snapshot]);

	const outcomeCards = useMemo(() => snapshot?.outcomes ?? [], [snapshot]);

	return (
		<AuthGate>
			<div className="min-h-screen bg-slate-950 text-slate-100">
				<div className="mx-auto w-full max-w-6xl px-6 py-10">
					<div className="mb-6 flex flex-wrap items-start justify-between gap-4">
						<div>
							<p className="text-xs uppercase tracking-[0.2em] text-slate-400">Sharp L2</p>
							<h1 className="mt-1 text-2xl font-semibold text-slate-50">
								{marketTitle ?? snapshot?.marketQuestion ?? "Market Depth"}
							</h1>
							<p className="mt-1 text-xs text-slate-500 break-all">{conditionId}</p>
						</div>
						<div className="flex items-center gap-2">
							<a
								href="/sharp"
								className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-200 hover:bg-slate-800/70"
							>
								Back to Sharp
							</a>
							<label htmlFor="depth-levels" className="text-xs text-slate-400">
								Levels
							</label>
							<select
								id="depth-levels"
								value={levelLimit}
								onChange={(event) => setLevelLimit(Number(event.target.value))}
								className="rounded-md border border-slate-700 bg-slate-900/70 px-2 py-1 text-xs text-slate-100"
							>
								<option value={5}>5</option>
								<option value={10}>10</option>
								<option value={15}>15</option>
								<option value={20}>20</option>
							</select>
							<button
								type="button"
								onClick={() => void loadSnapshot(false)}
								disabled={isRefreshing}
								className="inline-flex items-center gap-1 rounded-lg bg-cyan-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60"
							>
								<RefreshCw
									className={`h-3 w-3 ${isRefreshing ? "animate-spin" : ""}`}
								/>
								Refresh
							</button>
						</div>
					</div>

					<div className="mb-4 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">
						Last update: {formatRelativeTime(snapshot?.fetchedAt)}
					</div>

					{error && (
						<div className="mb-4 rounded-xl border border-red-500/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">
							{error}
						</div>
					)}

					{isLoading && (
						<div className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-8 text-center text-sm text-slate-400">
							Loading depth snapshot...
						</div>
					)}

					{!isLoading && outcomeCards.length === 0 && (
						<div className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-8 text-center text-sm text-slate-400">
							No order book depth available for this market.
						</div>
					)}

					<div className="grid gap-4 md:grid-cols-2">
						{outcomeCards.map((book: ClobOutcomeBook) => {
							const bidWallThreshold = getDepthWallThreshold(book.bids);
							const askWallThreshold = getDepthWallThreshold(book.asks);
							const maxBidNotional = Math.max(
								0,
								...book.bids.map((level) => level.notional),
							);
							const maxAskNotional = Math.max(
								0,
								...book.asks.map((level) => level.notional),
							);
							const trendPoints = trendByTokenId[book.tokenId] ?? [];
							return (
								<div
									key={book.tokenId}
									className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"
								>
									<div className="mb-3 flex items-start justify-between gap-3">
										<div>
											<p className="text-sm font-semibold text-slate-100">{book.outcome}</p>
											<p className="text-[0.65rem] text-slate-500 break-all">Token {book.tokenId}</p>
										</div>
										<div className="text-right text-xs text-slate-300">
											<div>Bid {formatPrice(book.bestBid)}</div>
											<div>Ask {formatPrice(book.bestAsk)}</div>
											<div>Spread {formatPercent(book.spread)}</div>
											<div>Imb {formatPercent(book.imbalance)}</div>
										</div>
									</div>

									{trendPoints.length > 1 && (
										<div className="mb-3">{renderTrendChart(trendPoints)}</div>
									)}

									<div className="grid grid-cols-2 gap-3">
										<div>
											<p className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">Bids</p>
											<div className="space-y-1">
												{book.bids.map((level, index) => (
													<div
														key={`bid-${book.tokenId}-${index}`}
														className={levelRowClass(
															level.notional,
															maxBidNotional,
															bidWallThreshold,
															"grid grid-cols-3 gap-2 rounded bg-emerald-500/10 px-2 py-1 text-xs",
															"bg-emerald-400/25",
														)}
													>
														<span>{formatPrice(level.price)}</span>
														<span className="text-right">{formatSize(level.size)}</span>
														<span className="text-right text-[0.65rem] text-emerald-200">
															${formatSize(level.notional)}
														</span>
													</div>
												))}
												{book.bids.length === 0 && <p className="text-xs text-slate-500">No bids</p>}
											</div>
										</div>
										<div>
											<p className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-rose-300">Asks</p>
											<div className="space-y-1">
												{book.asks.map((level, index) => (
													<div
														key={`ask-${book.tokenId}-${index}`}
														className={levelRowClass(
															level.notional,
															maxAskNotional,
															askWallThreshold,
															"grid grid-cols-3 gap-2 rounded bg-rose-500/10 px-2 py-1 text-xs",
															"bg-rose-400/25",
														)}
													>
														<span>{formatPrice(level.price)}</span>
														<span className="text-right">{formatSize(level.size)}</span>
														<span className="text-right text-[0.65rem] text-rose-200">
															${formatSize(level.notional)}
														</span>
													</div>
												))}
												{book.asks.length === 0 && <p className="text-xs text-slate-500">No asks</p>}
											</div>
										</div>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			</div>
		</AuthGate>
	);
}
