import { describe, expect, it } from "vitest";

import {
	extractSpreadFromTitle,
	getMarketTypeLabel,
	identifySpreadTeamPosition,
} from "./line-ingestion";

describe("getMarketTypeLabel", () => {
	it("classifies Polymarket first-inning markets as props", () => {
		expect(
			getMarketTypeLabel(
				"Will there be a run scored in the first inning?: Minnesota Twins vs. Kansas City Royals",
			),
		).toBe("prop");
	});

	it("classifies BTTS markets as props", () => {
		expect(
			getMarketTypeLabel(
				"Chelsea FC vs. Manchester United FC: Both Teams to Score",
			),
		).toBe("prop");
	});

	it("classifies tennis set handicaps as spreads, not moneylines", () => {
		expect(
			getMarketTypeLabel("Set Handicap: Bartunkova (-1.5) vs Sherif (+1.5)"),
		).toBe("spread");
		expect(
			getMarketTypeLabel("US Open ATP: Adolfo Vallejo vs Gael Monfils"),
		).toBe("moneyline");
	});

	it("classifies team totals as props, not game totals", () => {
		expect(getMarketTypeLabel("Seahawks Team Total: O/U 25.5")).toBe("prop");
	});

	it("classifies period markets as props regardless of core keywords", () => {
		expect(getMarketTypeLabel("Seahawks vs. Patriots: 1H O/U 23.5")).toBe(
			"prop",
		);
		expect(getMarketTypeLabel("Miami vs. Indiana: 1H Moneyline")).toBe("prop");
		expect(getMarketTypeLabel("1H Spread: Seahawks (-3.5)")).toBe("prop");
		expect(getMarketTypeLabel("Lakers vs. Celtics: 1st Half O/U 112.5")).toBe(
			"prop",
		);
	});

	it("classifies soccer derivative markets as props, not game totals", () => {
		expect(
			getMarketTypeLabel(
				"Manchester City FC vs. AFC Bournemouth: O/U 10.5 Total Corners",
			),
		).toBe("prop");
		expect(
			getMarketTypeLabel(
				"Everton FC vs. Crystal Palace FC: O/U 9.5 Total Corners",
			),
		).toBe("prop");
		expect(
			getMarketTypeLabel("Chelsea FC vs. Arsenal FC: O/U 4.5 Total Cards"),
		).toBe("prop");
		expect(
			getMarketTypeLabel("Chelsea FC vs. Arsenal FC: O/U 60.5 Booking Points"),
		).toBe("prop");
		expect(
			getMarketTypeLabel("Chelsea FC vs. Arsenal FC: O/U 8.5 Shots on Target"),
		).toBe("prop");
	});

	it("does not misread Cardinals as a card prop", () => {
		expect(getMarketTypeLabel("St. Louis Cardinals vs. Chicago Cubs")).toBe(
			"moneyline",
		);
		expect(
			getMarketTypeLabel("St. Louis Cardinals vs. Chicago Cubs: O/U 8.5"),
		).toBe("total");
	});

	it("keeps core market types unchanged", () => {
		expect(getMarketTypeLabel("Yankees vs. Red Sox: O/U 8.5 Total Runs")).toBe(
			"total",
		);
		expect(getMarketTypeLabel("PHI vs CHA: Spread: Hornets (-6.5)")).toBe(
			"spread",
		);
		expect(getMarketTypeLabel("Minnesota Twins vs. Kansas City Royals")).toBe(
			"moneyline",
		);
	});

	it("classifies tennis title shapes", () => {
		// Tournament-prefixed match winner: colon, but the matchup follows it.
		expect(
			getMarketTypeLabel("Cincinnati Open: Andrey Rublev vs Nuno Borges"),
		).toBe("moneyline");
		expect(getMarketTypeLabel("Cancun: Alexandre Muller vs Coleman Wong")).toBe(
			"moneyline",
		);
		// Will-the-match-finish prop, not the winner.
		expect(
			getMarketTypeLabel(
				"Cancun: Completed Match: Alexandre Muller vs Coleman Wong",
			),
		).toBe("prop");
		// Full-match totals stay totals; per-set markets are period props.
		expect(getMarketTypeLabel("Muller vs. Wong: Total Sets O/U 2.5")).toBe(
			"total",
		);
		expect(getMarketTypeLabel("Muller vs. Wong: Match O/U 21.5")).toBe("total");
		expect(getMarketTypeLabel("Muller vs. Wong: Set 1 Games O/U 9.5")).toBe(
			"prop",
		);
		expect(getMarketTypeLabel("Muller vs. Wong: Set 2 Games O/U 10.5")).toBe(
			"prop",
		);
	});
});

describe("identifySpreadTeamPosition", () => {
	it("detects the named spread side from full market titles", () => {
		expect(
			identifySpreadTeamPosition("PHI vs CHA: Spread: Hornets (-6.5)"),
		).toBe("second");
		expect(
			identifySpreadTeamPosition(
				"Los Angeles Lakers vs Boston Celtics: Spread: Lakers (+4.5)",
			),
		).toBe("first");
	});
});

describe("extractSpreadFromTitle", () => {
	it("parses spreads from full market titles", () => {
		expect(extractSpreadFromTitle("PHI vs CHA: Spread: Hornets (-6.5)")).toBe(
			-6.5,
		);
		expect(
			extractSpreadFromTitle(
				"Los Angeles Lakers vs Boston Celtics: Spread: Lakers (+4.5)",
			),
		).toBe(4.5);
	});
});
