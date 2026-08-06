/**
 * Render a bet side as the actual bet, not an outcome index.
 *
 * "Under" on "... O/U 8.5" → "Under 8.5"; "Washington Nationals" on
 * "WSH vs PHI: Spread: Philadelphia Phillies (-2.5)" → "Washington
 * Nationals +2.5" (the non-named team takes the opposite sign). Rows
 * without a stored label still resolve for totals: sharp-money.ts always
 * sets sideA="Over" / sideB="Under" on O/U markets — the same convention
 * the opportunity scorer relies on — so A/B alone determines direction.
 * Falls back to the raw label when the title doesn't parse, and to null
 * when nothing can be derived (moneyline with no stored label).
 */
export function formatSideLabel(
	storedLabel: string | null | undefined,
	sharpSide: string | null | undefined,
	marketTitle: string,
): string | null {
	let label = storedLabel ?? null;
	if (!label && /O\/U/i.test(marketTitle)) {
		label = sharpSide === "A" ? "Over" : sharpSide === "B" ? "Under" : null;
	}
	if (!label) return null;
	const spread = marketTitle.match(
		/Spread:\s*(.+?)\s*\(([+-]?\d+(?:\.\d+)?)\)/i,
	);
	if (spread) {
		const line = Number.parseFloat(spread[2]);
		if (Number.isFinite(line)) {
			const namedTeam = spread[1].trim().toLowerCase();
			const side = label.trim().toLowerCase();
			const isNamedTeam =
				side === namedTeam ||
				namedTeam.includes(side) ||
				side.includes(namedTeam);
			const signed = isNamedTeam ? line : -line;
			return `${label} ${signed > 0 ? "+" : ""}${signed}`;
		}
	}
	const total = marketTitle.match(/O\/U\s*(\d+(?:\.\d+)?)/i);
	if (total && /^(over|under)$/i.test(label.trim())) {
		return `${label} ${total[1]}`;
	}
	return label;
}
