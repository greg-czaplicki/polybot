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
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-xxs tabular-nums">
			<span className="font-semibold uppercase tracking-wider text-ink-55">
				{snapshot.type}
			</span>
			<span className="text-ink-70">
				<span className="text-ink-55">SU</span> {formatPercent(snapshot.suPct)}
			</span>
			<span className="text-ink-70">
				<span className="text-ink-55">ATS</span>{" "}
				{formatPercent(snapshot.atsPct)}
			</span>
			<span className="text-ink-70">
				<span className="text-ink-55">O/U</span> {formatPercent(snapshot.ouPct)}
			</span>
			{snapshot.atsStreak && (
				<span
					className={
						snapshot.atsStreak.startsWith("W")
							? "text-signal-pos"
							: "text-signal-bad"
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
	const panelId = `pick-context-${pickId}`;

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
				aria-expanded={expanded}
				aria-controls={panelId}
				className="inline-flex h-8 items-center rounded-md px-2.5 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-70 ring-1 ring-inset ring-ink-25 transition-colors hover:bg-ink-15 hover:text-ink-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
			>
				{expanded ? "hide" : "context"}
			</button>

			{expanded && (
				<div
					id={panelId}
					className="mt-2 rounded-md bg-ink-00/50 p-3 ring-1 ring-inset ring-ink-15"
				>
					{loading && (
						<span className="font-mono text-xxs text-ink-55">loading…</span>
					)}
					{error && (
						<span className="font-mono text-xxs text-signal-bad">{error}</span>
					)}
					{!loading && !error && !context && fetched && (
						<span className="font-mono text-xxs text-ink-55">
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
			<span className="font-mono text-xxs text-ink-55">
				Pick not yet enriched with canonical data.
			</span>
		);
	}

	return (
		<div className="space-y-2">
			{/* Enrichment fields */}
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
				{team && (
					<span className="font-sans text-ink-85">
						{team.name}
						{opponent && (
							<span className="text-ink-55"> vs {opponent.name}</span>
						)}
					</span>
				)}
				{enrichment.sportTag && (
					<span className="rounded bg-ink-10 px-1.5 py-0.5 font-mono text-xxs uppercase tracking-wider text-ink-70">
						{enrichment.sportTag}
					</span>
				)}
				{enrichment.venueRole && (
					<span className="font-mono text-xxs uppercase tracking-wider text-ink-55">
						{enrichment.venueRole}
					</span>
				)}
				{enrichment.favDogRole && (
					<span
						className={`font-mono text-xxs uppercase tracking-wider ${
							enrichment.favDogRole === "favorite"
								? "text-brand-blue"
								: "text-signal-warn"
						}`}
					>
						{enrichment.favDogRole}
					</span>
				)}
			</div>

			{/* Lines */}
			{(enrichment.spreadLine != null || enrichment.totalLine != null) && (
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-xxs tabular-nums text-ink-70">
					{enrichment.spreadLine != null && (
						<span>
							<span className="text-ink-55">spread</span>{" "}
							{formatSpreadLine(enrichment.spreadLine)}
						</span>
					)}
					{enrichment.totalLine != null && (
						<span>
							<span className="text-ink-55">total</span> {enrichment.totalLine}
						</span>
					)}
					{enrichment.actualMargin != null && (
						<span className="text-ink-55">
							margin {formatSpreadLine(enrichment.actualMargin)}
						</span>
					)}
					{enrichment.actualTotal != null && (
						<span className="text-ink-55">actual {enrichment.actualTotal}</span>
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
				<span className="font-mono text-xxs text-ink-40">
					No trend snapshots at pick time.
				</span>
			)}
		</div>
	);
}
