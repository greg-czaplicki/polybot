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

	it("keeps core market types unchanged", () => {
		expect(
			getMarketTypeLabel("Yankees vs. Red Sox: O/U 8.5 Total Runs"),
		).toBe("total");
		expect(
			getMarketTypeLabel("PHI vs CHA: Spread: Hornets (-6.5)"),
		).toBe("spread");
		expect(getMarketTypeLabel("Minnesota Twins vs. Kansas City Royals")).toBe(
			"moneyline",
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
