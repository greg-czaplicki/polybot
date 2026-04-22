import { createServerFn } from "@tanstack/react-start";
import { getDb } from "../env";
import {
	listDailyStatsSnapshots,
	maybeRefreshDailyStatsSnapshot,
	upsertDailyStatsSnapshot,
} from "../repositories/daily-stats-snapshots";

export const getDailyStatsSnapshotsFn = createServerFn({
	method: "GET",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number };
	const limit =
		typeof payload.limit === "number" && payload.limit > 0
			? Math.min(payload.limit, 30)
			: 14;
	return {
		snapshots: await listDailyStatsSnapshots(getDb(context), limit),
	};
});

export const refreshDailyStatsSnapshotFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { dayStartAt?: number; force?: boolean };
	const db = getDb(context);
	if (
		typeof payload.dayStartAt === "number" &&
		Number.isFinite(payload.dayStartAt)
	) {
		return {
			snapshot: await upsertDailyStatsSnapshot(db, payload.dayStartAt),
		};
	}
	if (payload.force) {
		return {
			snapshot: await upsertDailyStatsSnapshot(
				db,
				Math.floor(Date.now() / 1000),
			),
		};
	}
	return {
		snapshot: await maybeRefreshDailyStatsSnapshot(db),
	};
});
