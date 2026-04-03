#!/usr/bin/env python3

import argparse
import json
from pathlib import Path


def as_float(value):
	if value is None:
		return None
	try:
		return float(value)
	except (TypeError, ValueError):
		return None


def summarize(rows):
	wins = sum(row["status"] == "win" for row in rows)
	losses = sum(row["status"] == "loss" for row in rows)
	count = len(rows)
	return {
		"count": count,
		"wins": wins,
		"losses": losses,
		"win_rate": (wins / (wins + losses)) if (wins + losses) else None,
		"avg_roi": (
			sum(float(row["roi"]) for row in rows) / count if count else None
		),
		"avg_clv_bps": (
			sum(float(row["clv"]) for row in rows) / count * 10000 if count else None
		),
	}


def print_summary(label, rows):
	stats = summarize(rows)
	win_rate = (
		f"{stats['win_rate'] * 100:.1f}%"
		if stats["win_rate"] is not None
		else "n/a"
	)
	avg_roi = f"{stats['avg_roi'] * 100:.1f}%" if stats["avg_roi"] is not None else "n/a"
	avg_clv = (
		f"{stats['avg_clv_bps']:.1f}" if stats["avg_clv_bps"] is not None else "n/a"
	)
	print(
		f"{label:<40} count={stats['count']:>3} wins={stats['wins']:>3} "
		f"losses={stats['losses']:>3} win_rate={win_rate:>6} "
		f"avg_roi={avg_roi:>7} avg_clv_bps={avg_clv:>8}"
	)


def bucket_rows(rows, field, buckets):
	grouped = {label: [] for label, _ in buckets}
	for row in rows:
		value = as_float(row.get(field))
		if value is None:
			continue
		for label, predicate in buckets:
			if predicate(value):
				grouped[label].append(row)
				break
	return grouped


def top_quartile(rows, field):
	values = sorted(
		value for row in rows if (value := as_float(row.get(field))) is not None
	)
	if not values:
		return None, []
	cut_index = int(0.75 * len(values))
	cut = values[cut_index]
	selected = [row for row in rows if (as_float(row.get(field)) or -1e9) >= cut]
	return cut, selected


def market_type(row):
	return row.get("snapshot_market_type") or row.get("bet_type") or "unknown"


def main():
	parser = argparse.ArgumentParser(
		description="Audit a polywhaler sharp-model export produced by wrangler d1 execute --json."
	)
	parser.add_argument("input", help="Path to the JSON export file")
	args = parser.parse_args()

	payload = json.loads(Path(args.input).read_text())
	rows = payload[0]["results"]

	print("Base sample")
	print_summary("all settled w/ snapshots", rows)
	print()

	print("Buckets")
	bucket_specs = [
		(
			"snapshot_score_diff",
			[
				("<20", lambda value: value < 20),
				("20-30", lambda value: value < 30),
				("30-45", lambda value: value < 45),
				("45+", lambda value: True),
			],
		),
		(
			"snapshot_edge_rating",
			[
				("<66", lambda value: value < 66),
				("66-72", lambda value: value < 72),
				("72-80", lambda value: value < 80),
				("80-90", lambda value: value < 90),
				("90+", lambda value: True),
			],
		),
		(
			"snapshot_signal_score",
			[
				("<80", lambda value: value < 80),
				("80-90", lambda value: value < 90),
				("90+", lambda value: True),
			],
		),
		(
			"minutes_to_start",
			[
				("0-15m", lambda value: value < 15),
				("15-60m", lambda value: value < 60),
				("1-3h", lambda value: value < 180),
				("3h+", lambda value: True),
			],
		),
		(
			"snapshot_market_quality",
			[
				("<0.72", lambda value: value < 0.72),
				("0.72-0.90", lambda value: value < 0.90),
				("0.90+", lambda value: True),
			],
		),
	]
	for field, buckets in bucket_specs:
		print(field)
		for label, bucket in bucket_rows(rows, field, buckets).items():
			if bucket:
				print_summary(f"  {label}", bucket)
		print()

	print("Top quartile comparisons")
	for field in [
		"snapshot_score_diff",
		"snapshot_edge_rating",
		"snapshot_signal_score",
		"snapshot_market_quality",
	]:
		cut, selected = top_quartile(rows, field)
		if cut is not None:
			print_summary(f"{field} >= {cut:.4f}", selected)
	print()

	print("Core combinations")
	quality_090 = [
		row
		for row in rows
		if (value := as_float(row.get("snapshot_market_quality"))) is not None and value >= 0.90
	]
	diff_45 = [
		row
		for row in rows
		if (value := as_float(row.get("snapshot_score_diff"))) is not None and value >= 45
	]
	edge_80 = [
		row
		for row in rows
		if (value := as_float(row.get("snapshot_edge_rating"))) is not None and value >= 80
	]
	signal_100 = [
		row
		for row in rows
		if (value := as_float(row.get("snapshot_signal_score"))) is not None and value >= 100
	]
	print_summary("quality >= 0.90", quality_090)
	print_summary("score diff >= 45", diff_45)
	print_summary("edge rating >= 80", edge_80)
	print_summary("signal score >= 100", signal_100)
	print_summary(
		"quality >= 0.90 & diff >= 45",
		[
			row
			for row in quality_090
			if (value := as_float(row.get("snapshot_score_diff"))) is not None and value >= 45
		],
	)
	print_summary(
		"quality >= 0.90 & edge >= 80",
		[
			row
			for row in quality_090
			if (value := as_float(row.get("snapshot_edge_rating"))) is not None and value >= 80
		],
	)
	print_summary(
		"quality >= 0.90 & signal >= 100",
		[
			row
			for row in quality_090
			if (value := as_float(row.get("snapshot_signal_score"))) is not None and value >= 100
		],
	)
	print()

	print("By market type: quality >= 0.90 & diff >= 45")
	for label in ["moneyline", "spread", "total"]:
		print_summary(
			label,
			[
				row
				for row in rows
				if market_type(row) == label
				and (quality := as_float(row.get("snapshot_market_quality"))) is not None
				and quality >= 0.90
				and (diff := as_float(row.get("snapshot_score_diff"))) is not None
				and diff >= 45
			],
		)


if __name__ == "__main__":
	main()
