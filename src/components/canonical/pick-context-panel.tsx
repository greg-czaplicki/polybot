import { useCallback, useState } from "react";

import { getPickContextFn } from "../../server/api/canonical-analytics";
import { formatPercent, formatSpreadLine } from "./formatters";

// ---------------------------------------------------------------------------
// Types — matches the PickContext shape from canonical-analytics.ts
// ---------------------------------------------------------------------------

interface PickContextData {
	pickId: string;
	marketTitle: string;
	pickedAt: number;
	enrichment: {
		gameId: string | null;
		teamId: string | null;
		opponentId: string | null;
		betType: string | null;
		sportTag: string | null;
		venueRole: string | null;
		favDogRole: string | null;
		spreadLine: number | null;
		totalLine: number | null;
		actualMargin: number | null;
		actualTotal: number | null;
	};
	team: { id: string; name: string; sportTag: string } | null;
	opponent: { id: string; name: string; sportTag: string } | null;
	trendSnapshot: {
		overall: CompactSnapshot | null;
		contextual: CompactSnapshot | null;
	};
}

interface CompactSnapshot {
	type: string;
	window: number;
	suPct: number | null;
	atsPct: number | null;
	ouPct: number | null;
	atsStreak: string | null;
}

function SnapshotBadge({ snapshot }: { snapshot: CompactSnapshot }) {
	return (
		<div className="flex flex-wrap items-center gap-2 text-[0.65rem]">
			<span className="font-semibold uppercase text-slate-500">
				{snapshot.type}
			</span>
			<span className="text-slate-400">SU {formatPercent(snapshot.suPct)}</span>
			<span className="text-slate-400">
				ATS {formatPercent(snapshot.atsPct)}
			</span>
			<span className="text-slate-400">
				O/U {formatPercent(snapshot.ouPct)}
			</span>
			{snapshot.atsStreak && (
				<span
					className={
						snapshot.atsStreak.startsWith("W")
							? "text-emerald-400"
							: "text-red-400"
					}
				>
					{snapshot.atsStreak}
				</span>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// PickContextPanel — expandable per-pick canonical context
// ---------------------------------------------------------------------------

export function PickContextPanel({ pickId }: { pickId: string }) {
	const [expanded, setExpanded] = useState(false);
	const [context, setContext] = useState<PickContextData | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [fetched, setFetched] = useState(false);

	const toggle = useCallback(async () => {
		if (expanded) {
			setExpanded(false);
			return;
		}
		setExpanded(true);
		if (fetched) return;

		setLoading(true);
		setError(null);
		try {
			const res = await getPickContextFn({ data: { pickId } });
			if (res.error) {
				setError(res.error);
			} else {
				setContext((res.context as PickContextData) ?? null);
			}
			setFetched(true);
		} catch {
			setError("Failed to load context");
		} finally {
			setLoading(false);
		}
	}, [expanded, fetched, pickId]);

	return (
		<div>
			<button
				type="button"
				onClick={toggle}
				className="rounded border border-slate-700/60 bg-slate-900/60 px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-slate-200"
			>
				{expanded ? "Hide" : "Context"}
			</button>

			{expanded && (
				<div className="mt-2 rounded-lg border border-slate-800/50 bg-slate-950/50 p-3">
					{loading && (
						<span className="text-[0.65rem] text-slate-500">Loading...</span>
					)}
					{error && (
						<span className="text-[0.65rem] text-red-400">{error}</span>
					)}
					{!loading && !error && !context && fetched && (
						<span className="text-[0.65rem] text-slate-500">
							No canonical context available for this pick.
						</span>
					)}
					{context && <PickContextContent context={context} />}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// PickContextContent — actual enrichment + trend display
// ---------------------------------------------------------------------------

function PickContextContent({ context }: { context: PickContextData }) {
	const { enrichment, team, opponent, trendSnapshot } = context;
	const hasEnrichment = enrichment.teamId || enrichment.sportTag;

	if (!hasEnrichment) {
		return (
			<span className="text-[0.65rem] text-slate-500">
				Pick not yet enriched with canonical data.
			</span>
		);
	}

	return (
		<div className="space-y-2">
			{/* Enrichment fields */}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.65rem]">
				{team && (
					<span className="text-slate-200">
						{team.name}
						{opponent && (
							<span className="text-slate-500"> vs {opponent.name}</span>
						)}
					</span>
				)}
				{enrichment.sportTag && (
					<span className="rounded border border-slate-700/40 bg-slate-800/30 px-1.5 py-0.5 text-[0.6rem] uppercase text-slate-400">
						{enrichment.sportTag}
					</span>
				)}
				{enrichment.venueRole && (
					<span className="text-slate-400">{enrichment.venueRole}</span>
				)}
				{enrichment.favDogRole && (
					<span
						className={
							enrichment.favDogRole === "favorite"
								? "text-cyan-400"
								: "text-amber-400"
						}
					>
						{enrichment.favDogRole}
					</span>
				)}
			</div>

			{/* Lines */}
			{(enrichment.spreadLine != null || enrichment.totalLine != null) && (
				<div className="flex flex-wrap items-center gap-3 text-[0.65rem] text-slate-400">
					{enrichment.spreadLine != null && (
						<span>Spread {formatSpreadLine(enrichment.spreadLine)}</span>
					)}
					{enrichment.totalLine != null && (
						<span>Total {enrichment.totalLine}</span>
					)}
					{enrichment.actualMargin != null && (
						<span className="text-slate-500">
							Margin {formatSpreadLine(enrichment.actualMargin)}
						</span>
					)}
					{enrichment.actualTotal != null && (
						<span className="text-slate-500">
							Actual {enrichment.actualTotal}
						</span>
					)}
				</div>
			)}

			{/* Trend snapshots */}
			{trendSnapshot.overall && (
				<SnapshotBadge snapshot={trendSnapshot.overall} />
			)}
			{trendSnapshot.contextual && (
				<SnapshotBadge snapshot={trendSnapshot.contextual} />
			)}
			{!trendSnapshot.overall && !trendSnapshot.contextual && (
				<span className="text-[0.65rem] text-slate-600">
					No trend snapshots at pick time.
				</span>
			)}
		</div>
	);
}
