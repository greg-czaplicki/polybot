import { describe, expect, it } from "vitest";

import {
	extractSpreadFromTitle,
	identifySpreadTeamPosition,
} from "./line-ingestion";

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
