import type { Env } from "../env";
import { getWalletTradeReport } from "../repositories/wallet-trade-report";

/** Public, read-only aggregates. Never exposes addresses or individual trades. */
export async function handleWalletTradeDigestRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	if (new URL(request.url).pathname !== "/api/wallet-trade-digest") return null;
	if (request.method !== "GET")
		return new Response("method not allowed", { status: 405 });
	return Response.json(await getWalletTradeReport(env.POLYWHALER_DB), {
		headers: { "Cache-Control": "public, max-age=60" },
	});
}
