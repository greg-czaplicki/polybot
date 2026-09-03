import type { ReactNode } from "react";

/**
 * Terminal panel grammar. A workspace is a hairline-tiled grid of panels;
 * a panel is a titled region, not a card. Numbers are mono + tabular and
 * right-aligned; status is carried by the value's colour, never by chrome.
 */

/** Tiles panels edge-to-edge with 1px hairlines between them. */
export function Workspace({
	children,
	className = "",
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={`grid grid-cols-1 gap-px border-y border-ink-15 bg-ink-15 md:grid-cols-12 ${className}`}
		>
			{children}
		</div>
	);
}

const SPAN: Record<number, string> = {
	3: "md:col-span-3",
	4: "md:col-span-4",
	5: "md:col-span-5",
	6: "md:col-span-6",
	7: "md:col-span-7",
	8: "md:col-span-8",
	9: "md:col-span-9",
	12: "md:col-span-12",
};

export function Panel({
	title,
	meta,
	span = 12,
	children,
	className = "",
	bodyClassName = "",
	tone,
}: {
	title: ReactNode;
	meta?: ReactNode;
	span?: keyof typeof SPAN;
	children: ReactNode;
	className?: string;
	bodyClassName?: string;
	/** Tints the title word — one status word per panel at most. */
	tone?: "pos" | "warn" | "bad";
}) {
	const titleTone =
		tone === "pos"
			? "text-signal-pos"
			: tone === "warn"
				? "text-signal-warn"
				: tone === "bad"
					? "text-signal-bad"
					: "text-ink-55";
	return (
		<section
			className={`flex min-w-0 flex-col bg-ink-00 ${SPAN[span]} ${className}`}
		>
			<header className="flex h-7 shrink-0 items-center justify-between gap-3 border-b border-ink-15 px-3">
				<h2
					className={`truncate font-mono text-xxs font-semibold uppercase tracking-[0.18em] ${titleTone}`}
				>
					{title}
				</h2>
				{meta ? (
					<span className="shrink-0 font-mono text-xxs tabular-nums text-ink-40">
						{meta}
					</span>
				) : null}
			</header>
			<div className={`min-w-0 flex-1 ${bodyClassName}`}>{children}</div>
		</section>
	);
}

/** A stat: label above, mono value below. Lives inline in a flex row. */
export function Stat({
	label,
	value,
	sub,
	className = "",
	valueClassName = "",
}: {
	label: ReactNode;
	value: ReactNode;
	sub?: ReactNode;
	className?: string;
	valueClassName?: string;
}) {
	return (
		<div className={`min-w-0 ${className}`}>
			<p className="font-mono text-xxs uppercase tracking-[0.15em] text-ink-40">
				{label}
			</p>
			<p
				className={`mt-0.5 font-mono text-base tabular-nums leading-tight text-ink-95 ${valueClassName}`}
			>
				{value}
			</p>
			{sub ? (
				<p className="mt-0.5 truncate font-mono text-xxs tabular-nums text-ink-55">
					{sub}
				</p>
			) : null}
		</div>
	);
}

export function toneClass(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value))
		return "text-ink-40";
	if (value === 0) return "text-ink-70";
	return value > 0 ? "text-signal-pos" : "text-signal-bad";
}

/** A signed number coloured by sign. Dims when the sample is too small. */
export function Num({
	value,
	text,
	dim = false,
	title,
}: {
	value: number | null | undefined;
	text: string;
	dim?: boolean;
	title?: string;
}) {
	return (
		<span
			title={title}
			className={`font-mono tabular-nums ${dim ? "text-ink-40" : toneClass(value)}`}
		>
			{text}
		</span>
	);
}

export type Tone = "ok" | "warn" | "bad" | "off";

export const DOT: Record<Tone, string> = {
	ok: "bg-signal-pos",
	warn: "bg-signal-warn",
	bad: "bg-signal-bad",
	off: "bg-ink-25",
};

export function Dot({ tone }: { tone: Tone }) {
	return (
		<span
			aria-hidden
			className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`}
		/>
	);
}

/** Verdict word. The only place these three words are styled. */
export function VerdictWord({
	verdict,
	title,
}: {
	verdict: "ready" | "watch" | "hold";
	title?: string;
}) {
	const cls =
		verdict === "ready"
			? "text-signal-pos"
			: verdict === "watch"
				? "text-signal-warn"
				: "text-ink-40";
	return (
		<span
			title={title}
			className={`font-mono text-xxs font-semibold uppercase tracking-[0.15em] ${cls}`}
		>
			{verdict}
		</span>
	);
}

/** Dense table. Header xxs mono; rows 28px; numeric cells right-aligned. */
export function Tape({
	head,
	children,
	minWidth = "min-w-[560px]",
}: {
	head: { label: ReactNode; align?: "left" | "right"; className?: string }[];
	children: ReactNode;
	minWidth?: string;
}) {
	return (
		<div className="overflow-x-auto">
			<table className={`w-full ${minWidth} text-sm text-ink-85`}>
				<thead>
					<tr className="h-6 border-b border-ink-10 font-mono text-xxs uppercase tracking-[0.12em] text-ink-40">
						{head.map((h, i) => (
							<th
								// biome-ignore lint/suspicious/noArrayIndexKey: static header
								key={i}
								className={`px-3 font-medium ${
									h.align === "right" ? "text-right" : "text-left"
								} ${h.className ?? ""}`}
							>
								{h.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}

export function Row({
	children,
	className = "",
	onClick,
	title,
}: {
	children: ReactNode;
	className?: string;
	onClick?: () => void;
	title?: string;
}) {
	return (
		<tr
			title={title}
			onClick={onClick}
			className={`h-7 border-b border-ink-10 last:border-b-0 ${
				onClick ? "cursor-pointer hover:bg-ink-05" : ""
			} ${className}`}
		>
			{children}
		</tr>
	);
}

export function Cell({
	children,
	right = false,
	mono = right,
	className = "",
	title,
	colSpan,
}: {
	children: ReactNode;
	right?: boolean;
	mono?: boolean;
	className?: string;
	title?: string;
	colSpan?: number;
}) {
	return (
		<td
			title={title}
			colSpan={colSpan}
			className={`px-3 ${right ? "text-right" : "text-left"} ${
				mono ? "font-mono tabular-nums" : ""
			} ${className}`}
		>
			{children}
		</td>
	);
}

export function Empty({ children }: { children: ReactNode }) {
	return <p className="px-3 py-3 text-sm text-ink-55">{children}</p>;
}

/** Inline uppercase tag (sport, bet type). */
export function Tag({ children }: { children: ReactNode }) {
	return (
		<span className="font-mono text-xxs uppercase tracking-[0.12em] text-ink-55">
			{children}
		</span>
	);
}
