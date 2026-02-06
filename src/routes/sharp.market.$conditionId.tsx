import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import {
	getClobDepthSnapshotFn,
	getSharpMoneyCacheEntryFn,
	type ClobDepthSnapshot,
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

function SharpMarketDepthPage() {
	const { conditionId } = Route.useParams();
	const [snapshot, setSnapshot] = useState<ClobDepthSnapshot | null>(null);
	const [marketTitle, setMarketTitle] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [levelLimit, setLevelLimit] = useState(10);

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
				])
				setMarketTitle(cacheResult.entry?.marketTitle ?? null);
				if (depthResult.error) {
					setError(depthResult.error);
					return
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
	)

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
								<RefreshCw className={`h-3 w-3 ${isRefreshing ? "animate-spin" : ""}`} />
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
						{outcomeCards.map((book) => (
							<div key={book.tokenId} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
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

								<div className="grid grid-cols-2 gap-3">
									<div>
										<p className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">Bids</p>
										<div className="space-y-1">
											{book.bids.map((level, index) => (
												<div key={`bid-${book.tokenId}-${index}`} className="grid grid-cols-2 gap-2 rounded bg-emerald-500/10 px-2 py-1 text-xs">
													<span>{formatPrice(level.price)}</span>
													<span className="text-right">{formatSize(level.size)}</span>
												</div>
											))}
											{book.bids.length === 0 && <p className="text-xs text-slate-500">No bids</p>}
										</div>
									</div>
									<div>
										<p className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-rose-300">Asks</p>
										<div className="space-y-1">
											{book.asks.map((level, index) => (
												<div key={`ask-${book.tokenId}-${index}`} className="grid grid-cols-2 gap-2 rounded bg-rose-500/10 px-2 py-1 text-xs">
													<span>{formatPrice(level.price)}</span>
													<span className="text-right">{formatSize(level.size)}</span>
												</div>
											))}
											{book.asks.length === 0 && <p className="text-xs text-slate-500">No asks</p>}
										</div>
									</div>
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
		</AuthGate>
	)
}
