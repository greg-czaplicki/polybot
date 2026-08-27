/**
 * Read API for the wallet-CLV foundation (wallet_entries). Powers /wallets:
 * live entry feed + per-wallet closing-line-value leaderboard.
 */

import { createServerFn } from "@tanstack/react-start";
import { all, first } from "../db/client";
import { getDb } from "../env";
import { resolveSportTagFromSeriesId } from "./series-registry";

export interface WalletClvTotals {
	entries: number;
	distinctWallets: number;
	open: number;
	closed: number;
	voided: number;
	avgClv: number | null;
	entriesLast24h: number;
	specialistWallets: number;
}

export interface WalletEntryRow {
	walletAddress: string;
	marketTitle: string;
	side: string;
	kind: string;
	sport: string | null;
	deltaUsd: number;
	totalUsd: number;
	entryPrice: number;
	closePrice: number | null;
	clv: number | null;
	status: string;
	observedAt: number;
	eventTime: number;
}

export interface WalletLeaderboardRow {
	walletAddress: string;
	entries: number;
	closed: number;
	avgClv: number;
	avgRelClv: number | null;
	beatCloseCount: number;
	totalDeltaUsd: number;
	lastSeenAt: number;
	topSport: string | null;
	topSportShare: number | null;
	sportsCount: number;
	markets: number;
}

export interface WalletSpecialistRow {
	walletAddress: string;
	sport: string;
	sportShare: number;
	markets: number;
	entries: number;
	closed: number;
	avgClv: number | null;
	avgRelClv: number | null;
	beatCloseCount: number;
	totalDeltaUsd: number;
	lastSeenAt: number;
}

/**
 * Specialist = ≥90% concentration in one sport. Counted and shared on
 * DISTINCT MARKETS (condition_id), not raw entries: increments pyramided
 * into one game are one observation, not five (a market's ML and total are
 * still separate condition_ids — no game_id on wallet_entries to merge them).
 */
const SPECIALIST_SHARE = 0.9;
/** Minimum distinct markets before concentration means anything. */
const SPECIALIST_MIN_MARKETS = 5;

interface WalletSportMix {
	topSport: string | null;
	topSportShare: number | null;
	sportsCount: number;
	markets: number;
	entries: number;
	closed: number;
	clvSum: number;
	relClvSum: number;
	relClvN: number;
	beatClose: number;
	totalDelta: number;
	lastSeen: number;
}

export const getWalletClvSummaryFn = createServerFn({ method: "GET" }).handler(
	async ({ context }) => {
		const db = getDb(context);
		const nowSec = Math.floor(Date.now() / 1000);

		const totalsRow = await first<{
			entries: number;
			distinct_wallets: number;
			open: number;
			closed: number;
			voided: number;
			avg_clv: number | null;
			last_24h: number;
		}>(
			db,
			`SELECT COUNT(*) AS entries,
			        COUNT(DISTINCT wallet_address) AS distinct_wallets,
			        SUM(status = 'open') AS open,
			        SUM(status = 'closed') AS closed,
			        SUM(status = 'void') AS voided,
			        AVG(CASE WHEN status = 'closed' THEN clv END) AS avg_clv,
			        SUM(observed_at > ?) AS last_24h
			 FROM wallet_entries`,
			nowSec - 86400,
		);

		const recentRows = await all<{
			wallet_address: string;
			market_title: string;
			side: string;
			kind: string;
			sport_series_id: number | null;
			delta_usd: number;
			total_usd: number;
			entry_price: number;
			close_price: number | null;
			clv: number | null;
			status: string;
			observed_at: number;
			event_time: number;
		}>(
			db,
			`SELECT wallet_address, market_title, side, kind, sport_series_id,
			        delta_usd, total_usd, entry_price, close_price, clv, status,
			        observed_at, event_time
			 FROM wallet_entries
			 ORDER BY observed_at DESC, id DESC
			 LIMIT 40`,
		);

		// Skill needs repetition: require >=3 settled entries before a wallet
		// earns a leaderboard row. Ranked by RELATIVE CLV (clv / entry_price):
		// a 2¢ beat on a 10¢ entry is a 20% edge, on a 90¢ entry it's noise —
		// absolute cents would bias the ranking toward mid-priced entries.
		const leaderboardRows = await all<{
			wallet_address: string;
			entries: number;
			closed: number;
			avg_clv: number;
			avg_rel_clv: number | null;
			beat_close: number;
			total_delta: number;
			last_seen: number;
		}>(
			db,
			`SELECT wallet_address,
			        COUNT(*) AS entries,
			        SUM(status = 'closed') AS closed,
			        AVG(CASE WHEN status = 'closed' THEN clv END) AS avg_clv,
			        AVG(CASE WHEN status = 'closed' AND entry_price > 0 THEN clv / entry_price END) AS avg_rel_clv,
			        SUM(CASE WHEN status = 'closed' AND clv > 0 THEN 1 ELSE 0 END) AS beat_close,
			        SUM(delta_usd) AS total_delta,
			        MAX(observed_at) AS last_seen
			 FROM wallet_entries
			 GROUP BY wallet_address
			 HAVING SUM(status = 'closed') >= 3
			 ORDER BY avg_rel_clv DESC
			 LIMIT 25`,
		);

		// Per-wallet sport mix (wallets with >=3 entries — covers every
		// leaderboard wallet). Grouped by raw series id and merged into sport
		// tags in JS: per-season ids (nfl-2025 vs nfl-2026) share one tag, and
		// SQLite can't apply the registry mapping. Sums, not AVGs, so tag-level
		// merges recombine exactly.
		const sportRows = await all<{
			wallet_address: string;
			sport_series_id: number;
			n: number;
			markets: number;
			closed: number;
			clv_sum: number | null;
			rel_clv_sum: number | null;
			rel_clv_n: number;
			beat_close: number;
			total_delta: number;
			last_seen: number;
		}>(
			db,
			`SELECT wallet_address, sport_series_id,
			        COUNT(*) AS n,
			        COUNT(DISTINCT condition_id) AS markets,
			        SUM(status = 'closed') AS closed,
			        SUM(CASE WHEN status = 'closed' THEN clv END) AS clv_sum,
			        SUM(CASE WHEN status = 'closed' AND entry_price > 0 THEN clv / entry_price END) AS rel_clv_sum,
			        SUM(CASE WHEN status = 'closed' AND entry_price > 0 THEN 1 ELSE 0 END) AS rel_clv_n,
			        SUM(CASE WHEN status = 'closed' AND clv > 0 THEN 1 ELSE 0 END) AS beat_close,
			        SUM(delta_usd) AS total_delta,
			        MAX(observed_at) AS last_seen
			 FROM wallet_entries
			 WHERE sport_series_id IS NOT NULL
			   AND wallet_address IN (
			     SELECT wallet_address FROM wallet_entries
			     GROUP BY wallet_address HAVING COUNT(*) >= 3
			   )
			 GROUP BY wallet_address, sport_series_id`,
		);

		const mixByWallet = new Map<string, WalletSportMix>();
		// Per-wallet per-tag DISTINCT MARKET counts (a condition_id belongs to
		// exactly one series, so summing per-series counts into a tag is exact).
		const tagMarketsByWallet = new Map<string, Map<string, number>>();
		for (const row of sportRows) {
			const tag =
				resolveSportTagFromSeriesId(row.sport_series_id) ??
				String(row.sport_series_id);
			let mix = mixByWallet.get(row.wallet_address);
			if (!mix) {
				mix = {
					topSport: null,
					topSportShare: null,
					sportsCount: 0,
					markets: 0,
					entries: 0,
					closed: 0,
					clvSum: 0,
					relClvSum: 0,
					relClvN: 0,
					beatClose: 0,
					totalDelta: 0,
					lastSeen: 0,
				};
				mixByWallet.set(row.wallet_address, mix);
				tagMarketsByWallet.set(row.wallet_address, new Map());
			}
			mix.entries += row.n;
			mix.markets += row.markets;
			mix.closed += row.closed;
			mix.clvSum += row.clv_sum ?? 0;
			mix.relClvSum += row.rel_clv_sum ?? 0;
			mix.relClvN += row.rel_clv_n;
			mix.beatClose += row.beat_close;
			mix.totalDelta += row.total_delta;
			mix.lastSeen = Math.max(mix.lastSeen, row.last_seen);
			const tags = tagMarketsByWallet.get(row.wallet_address);
			if (tags) tags.set(tag, (tags.get(tag) ?? 0) + row.markets);
		}
		for (const [wallet, mix] of mixByWallet) {
			const tags = tagMarketsByWallet.get(wallet);
			if (!tags || tags.size === 0) continue;
			mix.sportsCount = tags.size;
			let top: string | null = null;
			let topN = 0;
			for (const [tag, n] of tags) {
				if (n > topN) {
					top = tag;
					topN = n;
				}
			}
			mix.topSport = top;
			mix.topSportShare = mix.markets > 0 ? topN / mix.markets : null;
		}

		const specialistRows: WalletSpecialistRow[] = [];
		for (const [wallet, mix] of mixByWallet) {
			if (
				mix.markets < SPECIALIST_MIN_MARKETS ||
				mix.topSport === null ||
				mix.topSportShare === null ||
				mix.topSportShare < SPECIALIST_SHARE
			)
				continue;
			specialistRows.push({
				walletAddress: wallet,
				sport: mix.topSport,
				sportShare: mix.topSportShare,
				markets: mix.markets,
				entries: mix.entries,
				closed: mix.closed,
				avgClv: mix.closed > 0 ? mix.clvSum / mix.closed : null,
				avgRelClv: mix.relClvN > 0 ? mix.relClvSum / mix.relClvN : null,
				beatCloseCount: mix.beatClose,
				totalDeltaUsd: mix.totalDelta,
				lastSeenAt: mix.lastSeen,
			});
		}
		const specialistWallets = specialistRows.length;
		const specialists = specialistRows
			.filter((row) => row.closed >= 3)
			.sort((a, b) => (b.avgRelClv ?? -Infinity) - (a.avgRelClv ?? -Infinity))
			.slice(0, 25);

		const totals: WalletClvTotals = {
			entries: totalsRow?.entries ?? 0,
			distinctWallets: totalsRow?.distinct_wallets ?? 0,
			open: totalsRow?.open ?? 0,
			closed: totalsRow?.closed ?? 0,
			voided: totalsRow?.voided ?? 0,
			avgClv: totalsRow?.avg_clv ?? null,
			entriesLast24h: totalsRow?.last_24h ?? 0,
			specialistWallets,
		};

		const recent: WalletEntryRow[] = recentRows.map((row) => ({
			walletAddress: row.wallet_address,
			marketTitle: row.market_title,
			side: row.side,
			kind: row.kind,
			sport: resolveSportTagFromSeriesId(row.sport_series_id),
			deltaUsd: row.delta_usd,
			totalUsd: row.total_usd,
			entryPrice: row.entry_price,
			closePrice: row.close_price,
			clv: row.clv,
			status: row.status,
			observedAt: row.observed_at,
			eventTime: row.event_time,
		}));

		const leaderboard: WalletLeaderboardRow[] = leaderboardRows.map((row) => {
			const mix = mixByWallet.get(row.wallet_address);
			return {
				walletAddress: row.wallet_address,
				entries: row.entries,
				closed: row.closed,
				avgClv: row.avg_clv,
				avgRelClv: row.avg_rel_clv,
				beatCloseCount: row.beat_close,
				totalDeltaUsd: row.total_delta,
				lastSeenAt: row.last_seen,
				topSport: mix?.topSport ?? null,
				topSportShare: mix?.topSportShare ?? null,
				sportsCount: mix?.sportsCount ?? 0,
				markets: mix?.markets ?? 0,
			};
		});

		return { totals, recent, leaderboard, specialists };
	},
);
