import { describe, expect, it } from "vitest";
import type { OddsApiEvent } from "./pinnacle-odds";
import {
	evaluateR1ForEntry,
	R1_MIN_MINUTES_TO_START,
	type TennisV2Entry,
} from "./tennis-v2";

const NOW = 1_790_000_000;
const IN_TWO_HOURS = new Date((NOW + 2 * 3600) * 1000).toISOString();

// home +110 / away -120 → devigged home ≈ 0.4664
function event(overrides?: Partial<OddsApiEvent>): OddsApiEvent {
	return {
		id: "evt1",
		commence_time: IN_TWO_HOURS,
		home_team: "Aryna Sabalenka",
		away_team: "Iga Swiatek",
		bookmakers: [
			{
				key: "pinnacle",
				markets: [
					{
						key: "h2h",
						outcomes: [
							{ name: "Aryna Sabalenka", price: 110 },
							{ name: "Iga Swiatek", price: -120 },
						],
					},
				],
			},
		],
		...overrides,
	};
}

function entry(overrides?: Partial<TennisV2Entry>): TennisV2Entry {
	return {
		conditionId: "0xc1",
		marketTitle: "Aryna Sabalenka vs Iga Swiatek",
		sportTag: "wta",
		eventTime: IN_TWO_HOURS,
		sideA: { label: "Aryna Sabalenka", price: 0.4 },
		sideB: { label: "Iga Swiatek", price: 0.55 },
		...overrides,
	};
}

describe("evaluateR1ForEntry", () => {
	it("fires on the underpriced side when divergence >= theta1", () => {
		const d = evaluateR1ForEntry(entry(), [event()], NOW);
		expect(d).not.toBeNull();
		expect(d?.side).toBe("A");
		expect(d?.label).toBe("Aryna Sabalenka");
		expect(d?.pinFair).toBeCloseTo(0.4664, 3);
		expect(d?.divergence).toBeGreaterThanOrEqual(0.05);
	});

	it("holds below theta1", () => {
		const d = evaluateR1ForEntry(
			entry({ sideA: { label: "Aryna Sabalenka", price: 0.43 } }),
			[event()],
			NOW,
		);
		expect(d).toBeNull();
	});

	it("respects the entry-price floor", () => {
		// Fair 0.4664 vs pm 0.20: 26c divergence but price < 0.25.
		const d = evaluateR1ForEntry(
			entry({ sideA: { label: "Aryna Sabalenka", price: 0.2 } }),
			[event()],
			NOW,
		);
		expect(d).toBeNull();
	});

	it("holds inside the pre-start window", () => {
		const soon = new Date(
			(NOW + (R1_MIN_MINUTES_TO_START - 5) * 60) * 1000,
		).toISOString();
		const d = evaluateR1ForEntry(
			entry({ eventTime: soon }),
			[event({ commence_time: soon })],
			NOW,
		);
		expect(d).toBeNull();
	});

	it("tolerates session-start vs match-slot drift within 6h", () => {
		const slot = new Date((NOW + 5 * 3600) * 1000).toISOString();
		const d = evaluateR1ForEntry(entry(), [event({ commence_time: slot })], NOW);
		expect(d).not.toBeNull();
	});

	it("returns null when PM labels don't map onto the matched players", () => {
		const d = evaluateR1ForEntry(
			entry({
				sideA: { label: "Somebody Else", price: 0.4 },
				sideB: { label: "Iga Swiatek", price: 0.55 },
			}),
			[event()],
			NOW,
		);
		expect(d).toBeNull();
	});

	it("ignores non-moneyline tennis markets", () => {
		const d = evaluateR1ForEntry(
			entry({
				marketTitle: "Aryna Sabalenka vs Iga Swiatek: O/U 21.5",
			}),
			[event()],
			NOW,
		);
		expect(d).toBeNull();
	});

	it("de-vigs soccer three-way per side — away fair is NOT 1-homeFair", () => {
		// home -105 (.512), draw +240 (.294), away +260 (.278), sum 1.084:
		// fairHome ≈ .472, fairAway ≈ .256. PM: home .40 (fires, +.072),
		// away .30 (does NOT fire: .256 - .30 < 0). The two-way-complement
		// bug (fairAway = .528) would wrongly pick the away side (+.228).
		const soccer = event({
			home_team: "Fulham",
			away_team: "Brentford",
			bookmakers: [
				{
					key: "pinnacle",
					markets: [
						{
							key: "h2h",
							outcomes: [
								{ name: "Fulham", price: -105 },
								{ name: "Brentford", price: 260 },
								{ name: "Draw", price: 240 },
							],
						},
					],
				},
			],
		});
		const d = evaluateR1ForEntry(
			entry({
				marketTitle: "Fulham vs. Brentford",
				sportTag: "epl",
				sideA: { label: "Fulham", price: 0.4 },
				sideB: { label: "Brentford", price: 0.3 },
			}),
			[soccer],
			NOW,
		);
		expect(d).not.toBeNull();
		expect(d?.side).toBe("A");
		expect(d?.pinFair).toBeCloseTo(0.472, 2);
	});

	it("holds team sports to the tight 45-min commence gap", () => {
		// Same fixture but the feed's commence time is 3h off our event
		// time — fine for tennis (session proxy), a mismatch for football.
		const drifted = new Date((NOW + 5 * 3600) * 1000).toISOString();
		const d = evaluateR1ForEntry(
			entry({
				marketTitle: "Green Bay Packers vs. Chicago Bears",
				sportTag: "nfl",
				sideA: { label: "Green Bay Packers", price: 0.4 },
				sideB: { label: "Chicago Bears", price: 0.55 },
			}),
			[
				event({
					home_team: "Green Bay Packers",
					away_team: "Chicago Bears",
					commence_time: drifted,
					bookmakers: [
						{
							key: "pinnacle",
							markets: [
								{
									key: "h2h",
									outcomes: [
										{ name: "Green Bay Packers", price: 110 },
										{ name: "Chicago Bears", price: -120 },
									],
								},
							],
						},
					],
				}),
			],
			NOW,
		);
		expect(d).toBeNull();
	});
});
