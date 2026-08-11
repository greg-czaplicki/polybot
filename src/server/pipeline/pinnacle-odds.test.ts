import { describe, expect, it } from "vitest";
import {
	mapTotalsToPick,
	parseMarketTotalLine,
	devigTwoWay,
} from "./book-odds";
import {
	extractPinnaclePrices,
	matchOddsApiEvent,
	type OddsApiEvent,
} from "./pinnacle-odds";

const T0 = 1786400000; // arbitrary fixed event time (seconds)

function iso(seconds: number): string {
	return new Date(seconds * 1000).toISOString();
}

function pinnacleEvent(overrides?: Partial<OddsApiEvent>): OddsApiEvent {
	return {
		id: "ev1",
		commence_time: iso(T0),
		home_team: "Houston Astros",
		away_team: "San Diego Padres",
		bookmakers: [
			{
				key: "pinnacle",
				markets: [
					{
						key: "h2h",
						outcomes: [
							{ name: "Houston Astros", price: -130 },
							{ name: "San Diego Padres", price: 110 },
						],
					},
					{
						key: "totals",
						outcomes: [
							{ name: "Over", price: -105, point: 8.5 },
							{ name: "Under", price: -115, point: 8.5 },
						],
					},
				],
			},
		],
		...overrides,
	};
}

describe("parseMarketTotalLine", () => {
	it("parses the O/U line from a Polymarket totals title", () => {
		expect(
			parseMarketTotalLine(
				"Houston Astros vs. San Diego Padres: O/U 9.5",
			),
		).toBe(9.5);
		expect(parseMarketTotalLine("NYC FC vs. Inter Miami: O/U 2.5")).toBe(2.5);
	});
	it("returns null for non-totals titles", () => {
		expect(parseMarketTotalLine("Houston Astros vs. San Diego Padres")).toBe(
			null,
		);
	});
});

describe("mapTotalsToPick", () => {
	const odds = {
		homeSpread: null,
		totalLine: 8.5,
		homeMoneyline: null,
		awayMoneyline: null,
		overOdds: -105,
		underOdds: -115,
	};
	it("orients over/under prices to the pick side", () => {
		expect(mapTotalsToPick(odds, "Over", 8.5)).toEqual({
			mlSide: -105,
			mlOpp: -115,
		});
		expect(mapTotalsToPick(odds, "Under", 8.5)).toEqual({
			mlSide: -115,
			mlOpp: -105,
		});
	});
	it("refuses a book line different from the market line", () => {
		expect(mapTotalsToPick(odds, "Over", 7.5)).toBe(null);
	});
	it("refuses missing sides/lines/prices", () => {
		expect(mapTotalsToPick(odds, null, 8.5)).toBe(null);
		expect(mapTotalsToPick(odds, "Yes", 8.5)).toBe(null);
		expect(mapTotalsToPick({ ...odds, overOdds: null }, "Over", 8.5)).toBe(
			null,
		);
		expect(mapTotalsToPick({ ...odds, totalLine: null }, "Over", 8.5)).toBe(
			null,
		);
	});
});

describe("matchOddsApiEvent", () => {
	const game = {
		homeName: "Houston Astros",
		awayName: "San Diego Padres",
		eventTime: T0,
	};
	it("matches on team names and commence time", () => {
		expect(matchOddsApiEvent([pinnacleEvent()], game)?.id).toBe("ev1");
	});
	it("matches flipped orientation", () => {
		const flipped = pinnacleEvent({
			home_team: "San Diego Padres",
			away_team: "Houston Astros",
		});
		expect(matchOddsApiEvent([flipped], game)?.id).toBe("ev1");
	});
	it("splits doubleheaders by proximity", () => {
		const game1 = pinnacleEvent({ id: "g1" });
		const game2 = pinnacleEvent({
			id: "g2",
			commence_time: iso(T0 + 4 * 3600),
		});
		expect(matchOddsApiEvent([game2, game1], game)?.id).toBe("g1");
		expect(
			matchOddsApiEvent([game1, game2], { ...game, eventTime: T0 + 4 * 3600 })
				?.id,
		).toBe("g2");
	});
	it("rejects events outside the 45-minute window", () => {
		const far = pinnacleEvent({ commence_time: iso(T0 + 3600) });
		expect(matchOddsApiEvent([far], game)).toBe(null);
	});
	it("rejects different matchups", () => {
		const other = pinnacleEvent({ home_team: "Texas Rangers" });
		expect(matchOddsApiEvent([other], game)).toBe(null);
	});
});

describe("extractPinnaclePrices", () => {
	it("extracts ML prices side-aware via venue role", () => {
		const prices = extractPinnaclePrices(pinnacleEvent(), {
			betType: "moneyline",
			venueRole: "home",
			sideLabel: null,
			marketTotalLine: null,
		});
		expect(prices.mlSide).toBe(-130);
		expect(prices.mlOpp).toBe(110);
		expect(prices.fairProb).toBeCloseTo(devigTwoWay(-130, 110) as number, 10);
		// raw totals stored regardless of bet type
		expect(prices.totalLine).toBe(8.5);
	});
	it("de-vigs totals only when the line matches the market", () => {
		const match = extractPinnaclePrices(pinnacleEvent(), {
			betType: "total",
			venueRole: null,
			sideLabel: "Under",
			marketTotalLine: 8.5,
		});
		expect(match.fairProb).toBeCloseTo(devigTwoWay(-115, -105) as number, 10);

		const mismatch = extractPinnaclePrices(pinnacleEvent(), {
			betType: "total",
			venueRole: null,
			sideLabel: "Under",
			marketTotalLine: 7.5,
		});
		expect(mismatch.fairProb).toBe(null);
		// raw prices still captured for line-movement analysis
		expect(mismatch.overOdds).toBe(-105);
		expect(mismatch.totalLine).toBe(8.5);
	});
	it("returns empty when pinnacle is absent from the event", () => {
		const noPin = pinnacleEvent({ bookmakers: [] });
		const prices = extractPinnaclePrices(noPin, {
			betType: "moneyline",
			venueRole: "home",
			sideLabel: null,
			marketTotalLine: null,
		});
		expect(prices.mlSide).toBe(null);
		expect(prices.fairProb).toBe(null);
	});
	it("returns no ML fair prob without a venue role", () => {
		const prices = extractPinnaclePrices(pinnacleEvent(), {
			betType: "moneyline",
			venueRole: null,
			sideLabel: null,
			marketTotalLine: null,
		});
		expect(prices.fairProb).toBe(null);
	});
});
