import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Hand-rolled SVG line chart for the /stats P/L panels. Series share one
 * daily x-grid; null values leave gaps (e.g. CLV before its validity date).
 * Interaction: crosshair snapped to the nearest day with a single tooltip
 * listing every series, mirrored on keyboard focus via arrow keys.
 */

export interface ChartSeriesDef {
	key: string;
	label: string;
	/** CSS color — marks only; all text stays on ink tokens. */
	color: string;
	values: Array<number | null>;
}

export interface ChartMarkerDef {
	dayIndex: number;
	label: string;
}

interface PlLineChartProps {
	days: number[];
	series: ChartSeriesDef[];
	markers?: ChartMarkerDef[];
	height?: number;
	formatValue: (value: number) => string;
	ariaLabel: string;
}

const MARGIN_LEFT = 44;
const MARGIN_RIGHT = 14;
const MARGIN_BOTTOM = 22;

function niceTicks(min: number, max: number, count: number): number[] {
	if (min === max) {
		const pad = Math.abs(min) || 1;
		min -= pad / 2;
		max += pad / 2;
	}
	const span = max - min;
	const rawStep = span / Math.max(1, count);
	const magnitude = 10 ** Math.floor(Math.log10(rawStep));
	const step =
		[1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep) ??
		rawStep;
	const ticks: number[] = [];
	for (
		let tick = Math.ceil(min / step) * step;
		tick <= max + step / 1e6;
		tick += step
	) {
		ticks.push(Math.abs(tick) < step / 1e6 ? 0 : tick);
	}
	return ticks;
}

function formatDay(daySec: number, withYear = false): string {
	return new Date(daySec * 1000).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(withYear ? { year: "numeric" } : {}),
	});
}

export function PlLineChart({
	days,
	series,
	markers,
	height = 240,
	formatValue,
	ariaLabel,
}: PlLineChartProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);
	const [hoverIndex, setHoverIndex] = useState<number | null>(null);

	useEffect(() => {
		const node = containerRef.current;
		if (!node) return;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				setWidth(Math.floor(entry.contentRect.width));
			}
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	const marginTop = markers && markers.length > 0 ? 18 : 10;
	const plotWidth = Math.max(0, width - MARGIN_LEFT - MARGIN_RIGHT);
	const plotHeight = Math.max(0, height - marginTop - MARGIN_BOTTOM);

	const { yMin, yMax, yTicks } = useMemo(() => {
		let min = 0;
		let max = 0;
		for (const s of series) {
			for (const v of s.values) {
				if (v === null) continue;
				if (v < min) min = v;
				if (v > max) max = v;
			}
		}
		if (min === max) {
			min -= 1;
			max += 1;
		}
		const pad = (max - min) * 0.08;
		min -= pad;
		max += pad;
		return { yMin: min, yMax: max, yTicks: niceTicks(min, max, 4) };
	}, [series]);

	const xAt = (index: number) =>
		MARGIN_LEFT +
		(days.length > 1 ? (index / (days.length - 1)) * plotWidth : plotWidth / 2);
	const yAt = (value: number) =>
		marginTop + ((yMax - value) / (yMax - yMin)) * plotHeight;

	// Cheap enough (a few hundred points) to recompute every render.
	const paths = series.map((s) => {
		let d = "";
		let pen = false;
		s.values.forEach((v, i) => {
			if (v === null) {
				pen = false;
				return;
			}
			d += `${pen ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`;
			pen = true;
		});
		return d;
	});

	const xTickIndexes = useMemo(() => {
		if (days.length <= 1) return days.length === 1 ? [0] : [];
		const count = Math.max(2, Math.min(6, Math.floor(plotWidth / 90)));
		const step = (days.length - 1) / (count - 1);
		const indexes = new Set<number>();
		for (let i = 0; i < count; i += 1) {
			indexes.add(Math.round(i * step));
		}
		return [...indexes];
	}, [days.length, plotWidth]);

	// End-of-line dots + direct value labels; colliding labels fall back to
	// the legend + tooltip rather than stacking.
	const endPoints = (() => {
		const points = series.flatMap((s) => {
			for (let i = s.values.length - 1; i >= 0; i -= 1) {
				const v = s.values[i];
				if (v !== null) return [{ s, index: i, value: v }];
			}
			return [];
		});
		const withY = points.map((p) => ({ ...p, y: yAt(p.value) }));
		const visible = new Set<string>();
		const taken: number[] = [];
		for (const p of withY) {
			if (taken.every((y) => Math.abs(y - p.y) >= 14)) {
				visible.add(p.s.key);
				taken.push(p.y);
			}
		}
		return withY.map((p) => ({ ...p, labelVisible: visible.has(p.s.key) }));
	})();

	const moveHover = (clientX: number) => {
		const node = containerRef.current;
		if (!node || days.length === 0) return;
		const rect = node.getBoundingClientRect();
		const x = clientX - rect.left - MARGIN_LEFT;
		const ratio = plotWidth > 0 ? x / plotWidth : 0;
		const index = Math.round(ratio * (days.length - 1));
		setHoverIndex(Math.max(0, Math.min(days.length - 1, index)));
	};

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (days.length === 0) return;
		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault();
			const delta = event.key === "ArrowLeft" ? -1 : 1;
			setHoverIndex((prev) => {
				const base = prev ?? days.length - 1;
				return Math.max(0, Math.min(days.length - 1, base + delta));
			});
		} else if (event.key === "Escape") {
			setHoverIndex(null);
		}
	};

	const hover =
		hoverIndex !== null && hoverIndex >= 0 && hoverIndex < days.length
			? {
					index: hoverIndex,
					x: xAt(hoverIndex),
					rows: series
						.map((s) => ({ s, value: s.values[hoverIndex] }))
						.filter(
							(row): row is { s: ChartSeriesDef; value: number } =>
								row.value !== null,
						),
				}
			: null;

	// Tooltip flips sides of the crosshair near the right edge.
	const tooltipOnLeft = hover !== null && width > 0 && hover.x > width * 0.62;

	return (
		<div className="relative">
			<div
				ref={containerRef}
				// overflow-hidden lets the container track its parent's width down
				// as well as up — otherwise the fixed-width svg wedges it open and
				// the ResizeObserver never reports the smaller size.
				className="relative w-full cursor-crosshair touch-pan-y overflow-hidden"
				onPointerMove={(event) => moveHover(event.clientX)}
				onPointerLeave={() => setHoverIndex(null)}
			>
				{/* biome-ignore-start lint/a11y/noNoninteractiveTabindex: keyboard-interactive chart (arrow keys move the crosshair readout, mirroring hover); role is "application". */}
				{width > 0 && days.length > 0 && (
					<svg
						width={width}
						height={height}
						viewBox={`0 0 ${width} ${height}`}
						role="application"
						aria-roledescription="interactive chart"
						aria-label={ariaLabel}
						tabIndex={0}
						className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
						onKeyDown={handleKeyDown}
						onBlur={() => setHoverIndex(null)}
					>
						{/* Gridlines — hairline, recessive */}
						{yTicks.map((tick) => (
							<g key={`grid-${tick}`}>
								<line
									x1={MARGIN_LEFT}
									x2={MARGIN_LEFT + plotWidth}
									y1={yAt(tick)}
									y2={yAt(tick)}
									stroke={tick === 0 ? "var(--ink-25)" : "var(--ink-15)"}
									strokeWidth={1}
								/>
								<text
									x={MARGIN_LEFT - 8}
									y={yAt(tick)}
									textAnchor="end"
									dominantBaseline="middle"
									className="font-mono text-xxs tabular-nums"
									fill="var(--ink-55)"
								>
									{formatValue(tick)}
								</text>
							</g>
						))}

						{/* X tick labels */}
						{xTickIndexes.map((index) => (
							<text
								key={`x-${index}`}
								x={xAt(index)}
								y={height - 6}
								textAnchor="middle"
								className="font-mono text-xxs tabular-nums"
								fill="var(--ink-55)"
							>
								{formatDay(days[index])}
							</text>
						))}

						{/* Strategy-era markers */}
						{(markers ?? []).map((marker) => (
							<g key={`marker-${marker.label}`}>
								<line
									x1={xAt(marker.dayIndex)}
									x2={xAt(marker.dayIndex)}
									y1={marginTop}
									y2={marginTop + plotHeight}
									stroke="var(--ink-25)"
									strokeWidth={1}
								/>
								<text
									x={xAt(marker.dayIndex) + 4}
									y={marginTop - 5}
									className="font-mono text-xxs"
									fill="var(--ink-55)"
								>
									{marker.label}
								</text>
							</g>
						))}

						{/* Series lines */}
						{series.map((s, i) => (
							<path
								key={s.key}
								d={paths[i]}
								fill="none"
								stroke={s.color}
								strokeWidth={2}
								strokeLinejoin="round"
								strokeLinecap="round"
							/>
						))}

						{/* End dots with surface ring */}
						{endPoints.map((p) => (
							<circle
								key={`end-${p.s.key}`}
								cx={xAt(p.index)}
								cy={p.y}
								r={4}
								fill={p.s.color}
								stroke="var(--ink-05)"
								strokeWidth={2}
							/>
						))}

						{/* Direct end labels (dropped on collision) */}
						{endPoints
							.filter((p) => p.labelVisible)
							.map((p) => (
								<text
									key={`endlabel-${p.s.key}`}
									x={Math.min(xAt(p.index), MARGIN_LEFT + plotWidth) - 8}
									y={Math.max(p.y - 8, marginTop + 4)}
									textAnchor="end"
									className="font-mono text-xxs font-semibold tabular-nums"
									fill="var(--ink-85)"
								>
									{formatValue(p.value)}
								</text>
							))}

						{/* Crosshair + hover dots */}
						{hover && (
							<g>
								<line
									x1={hover.x}
									x2={hover.x}
									y1={marginTop}
									y2={marginTop + plotHeight}
									stroke="var(--ink-40)"
									strokeWidth={1}
								/>
								{hover.rows.map((row) => (
									<circle
										key={`hover-${row.s.key}`}
										cx={hover.x}
										cy={yAt(row.value)}
										r={3.5}
										fill={row.s.color}
										stroke="var(--ink-05)"
										strokeWidth={2}
									/>
								))}
							</g>
						)}
					</svg>
				)}
				{/* biome-ignore-end lint/a11y/noNoninteractiveTabindex: end of keyboard-interactive svg. */}

				{/* Tooltip — HTML overlay; values lead, labels follow */}
				{hover && hover.rows.length > 0 && (
					<div
						className="pointer-events-none absolute z-10 rounded-md bg-ink-10 px-2.5 py-2 ring-1 ring-inset ring-ink-25"
						style={{
							top: marginTop,
							...(tooltipOnLeft
								? { right: width - hover.x + 8 }
								: { left: hover.x + 8 }),
						}}
					>
						<div className="mb-1 font-mono text-xxs uppercase tracking-wider text-ink-55">
							{formatDay(days[hover.index], true)}
						</div>
						{hover.rows.map((row) => (
							<div
								key={row.s.key}
								className="flex items-center gap-2 whitespace-nowrap"
							>
								<span
									aria-hidden
									className="inline-block h-0.5 w-2.5 rounded-full"
									style={{ backgroundColor: row.s.color }}
								/>
								<span className="font-mono text-xs font-semibold tabular-nums text-ink-95">
									{formatValue(row.value)}
								</span>
								{series.length > 1 && (
									<span className="font-sans text-xs text-ink-55">
										{row.s.label}
									</span>
								)}
							</div>
						))}
					</div>
				)}
			</div>

			{/* Legend — only for two or more series */}
			{series.length > 1 && (
				<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
					{series.map((s) => (
						<span key={s.key} className="flex items-center gap-1.5">
							<span
								aria-hidden
								className="inline-block h-0.5 w-3 rounded-full"
								style={{ backgroundColor: s.color }}
							/>
							<span className="font-sans text-xs text-ink-70">{s.label}</span>
						</span>
					))}
				</div>
			)}
		</div>
	);
}
