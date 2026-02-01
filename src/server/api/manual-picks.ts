import { createServerFn } from "@tanstack/react-start";
import { getDb } from "../env";
import {
	createManualPick,
	clearManualPicks,
	listManualPicks,
	updateManualPickOutcome,
	type CreateManualPickInput,
	type ManualPickStatus,
} from "../repositories/manual-picks";

export const createManualPickFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as CreateManualPickInput;
	if (!payload.conditionId || !payload.marketTitle) {
		return { error: "invalid_payload", pick: null };
	}
	const db = getDb(context);
	const pick = await createManualPick(db, payload);
	return { pick };
});

export const listManualPicksFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		status?: ManualPickStatus;
		limit?: number;
	};
	const db = getDb(context);
	const picks = await listManualPicks(db, {
		status: payload.status,
		limit: payload.limit,
	});
	return { picks };
});

export const updateManualPickOutcomeFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { id: string; status: ManualPickStatus };
	if (!payload.id || !payload.status) {
		return { error: "invalid_payload", pick: null };
	}
	const db = getDb(context);
	const pick = await updateManualPickOutcome(db, payload);
	return { pick };
});

export const clearManualPicksFn = createServerFn({
	method: "POST",
}).handler(async ({ context }) => {
	const db = getDb(context);
	await clearManualPicks(db);
	return { ok: true };
});
