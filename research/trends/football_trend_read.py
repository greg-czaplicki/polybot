#!/usr/bin/env python3
"""Pre-registered read: football (NFL / NCAAF) situational trend splits.

Charter: docs/charters/football-trend-splits.md (2026-09-17). The lanes,
thresholds and the forward start below are the contract; change any of them
and it is a new charter version (the prior result becomes exploratory).

Usage (from the repo root, needs wrangler auth):
    python3 research/trends/football_trend_read.py            # queries D1
    python3 research/trends/football_trend_read.py rows.json  # re-read a dump

Rows = shadow_candidates with a trend_context_json blob captured at FIRST
sighting (INSERT OR IGNORE — later sightings never overwrite it), so every
feature is point-in-time by construction. Rows are deduped to one per
(condition_id, sharp_side); z is clustered by event (all markets of one
game settle together). Clustered z = mean of per-event means / SE, the
same estimator as src/lib/grade-floor-test.ts.
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone

# ---------------------------------------------------------------- contract
FORWARD_START = "2026-09-18T00:00:00Z"  # first row with ouSplitPct/splitGames
SPORTS = ("nfl", "ncaaf")
MIN_SPLIT_GAMES = 4        # a split with <4 graded games is not a trend
HOT = 0.60                 # ATS / OU rate at or above → "hot" / "over lean"
COLD = 0.40                # at or below → "cold" / "under lean"
PASS_MIN_N = 50
PASS_MIN_Z = 2.0
SIDE_TYPES = {"moneyline", "spread"}

SQL = f"""
SELECT condition_id, sharp_side, sport_tag, market_type, market_title, event_time,
       created_at, status, roi, price, trend_context_json
FROM shadow_candidates
WHERE sport_tag IN ('nfl','ncaaf')
  AND trend_context_json IS NOT NULL
  AND status IN ('win','loss')
  AND created_at >= strftime('%s','{FORWARD_START}')
ORDER BY created_at
""".strip()


def load_rows(path: str | None) -> list[dict]:
    if path:
        with open(path) as f:
            data = json.load(f)
    else:
        out = subprocess.run(
            ["npx", "wrangler", "d1", "execute", "polywhaler-db", "--remote",
             "--json", "--command", SQL],
            check=True, capture_output=True, text=True,
        ).stdout
        data = json.loads(out)
    if isinstance(data, list) and data and "results" in data[0]:
        data = data[0]["results"]
    return data


def dedupe(rows: list[dict]) -> list[dict]:
    seen: dict[tuple[str, str], dict] = {}
    for r in rows:  # ordered by created_at → first sighting wins
        key = (r["condition_id"], r["sharp_side"])
        if key not in seen:
            seen[key] = r
    return list(seen.values())


def event_key(r: dict) -> str:
    title = (r["market_title"] or "").split(":", 1)[0].strip().lower()
    day = datetime.fromtimestamp(int(r["event_time"] or 0), tz=timezone.utc).date()
    return f"{title}|{day}"


def clustered(rows: list[dict]) -> tuple[int, int, float, float | None, int]:
    """(n, wins, roi, clustered_z, clusters)."""
    if not rows:
        return 0, 0, 0.0, None, 0
    by_ev: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        by_ev[event_key(r)].append(float(r["roi"]))
    means = [sum(v) / len(v) for v in by_ev.values()]
    k = len(means)
    mean = sum(means) / k
    z = None
    if k >= 5:
        var = sum((m - mean) ** 2 for m in means) / (k - 1)
        se = math.sqrt(var / k) if var > 0 else 0.0
        z = mean / se if se > 0 else None
    n = len(rows)
    wins = sum(1 for r in rows if r["status"] == "win")
    roi = sum(float(r["roi"]) for r in rows) / n
    return n, wins, roi, z, k


def lean(pct: float | None, games: int | None) -> str | None:
    if pct is None or games is None or games < MIN_SPLIT_GAMES:
        return None
    if pct >= HOT:
        return "over"
    if pct <= COLD:
        return "under"
    return None


def ou_alignment(ctx: dict, key_pct: str, key_games: str) -> str | None:
    """'aligned' / 'opposed' / None from both teams' leans vs pick direction."""
    pick = ctx.get("pickedDirection")
    if pick not in ("over", "under"):
        return None
    leans = [
        lean(side.get(key_pct), side.get(key_games))
        for side in (ctx.get("team") or {}, ctx.get("opponent") or {})
    ]
    leans = [x for x in leans if x]
    if not leans:
        return None
    if all(x == pick for x in leans):
        return "aligned"
    if all(x != pick for x in leans):
        return "opposed"
    return None  # mixed → outside both lanes


LANES = [
    # (name, market family, predicate(ctx, row) -> bool)
    ("ats_split_hot", "side",
     lambda c: (c["team"].get("splitGames") or 0) >= MIN_SPLIT_GAMES
     and c["team"].get("atsSplitPct") is not None
     and c["team"]["atsSplitPct"] >= HOT),
    ("ats_split_cold", "side",
     lambda c: (c["team"].get("splitGames") or 0) >= MIN_SPLIT_GAMES
     and c["team"].get("atsSplitPct") is not None
     and c["team"]["atsSplitPct"] <= COLD),
    ("ou_split_aligned", "total",
     lambda c: ou_alignment(c, "ouSplitPct", "splitGames") == "aligned"),
    ("ou_split_opposed", "total",
     lambda c: ou_alignment(c, "ouSplitPct", "splitGames") == "opposed"),
    # reference: the overall-window OU lean the scorer already uses
    ("ref_ou_overall_aligned", "total",
     lambda c: ou_alignment(c, "ouOverPct", "overallGames") == "aligned"),
    ("ref_ou_overall_opposed", "total",
     lambda c: ou_alignment(c, "ouOverPct", "overallGames") == "opposed"),
]


def family(r: dict) -> str:
    return "total" if r["market_type"] == "total" else (
        "side" if r["market_type"] in SIDE_TYPES else "other")


def fmt(n, wins, roi, z, k) -> str:
    zs = f"{z:+.1f}" if z is not None else " n/a"
    return f"n={n:4d} wins {wins:3d}  ROI {roi*100:+6.1f}%  z={zs} (events {k})"


def main() -> None:
    rows = dedupe(load_rows(sys.argv[1] if len(sys.argv) > 1 else None))
    for r in rows:
        r["ctx"] = json.loads(r["trend_context_json"])
        r["ctx"].setdefault("team", {})
        r["ctx"].setdefault("opponent", {})
    print(f"FOOTBALL TREND SPLITS (pre-registered, rows created >= {FORWARD_START}, "
          f"one row per market-side, z clustered by event; "
          f"pass = n >= {PASS_MIN_N}, ROI > 0, z >= {PASS_MIN_Z}, and lane − complement > 0)")
    for sport in SPORTS:
        srows = [r for r in rows if r.get("sport_tag") == sport]
        print(f"\n== {sport.upper()} ==")
        for fam in ("side", "total"):
            frows = [r for r in srows if family(r) == fam]
            print(f"  {fam:5s} baseline (all rows with context) "
                  f"{fmt(*clustered(frows))}")
        for name, fam, pred in LANES:
            frows = [r for r in srows if family(r) == fam]
            inlane = [r for r in frows if pred(r["ctx"])]
            rest = [r for r in frows if not pred(r["ctx"])]
            n, wins, roi, z, k = clustered(inlane)
            rn, _, rroi, _, _ = clustered(rest)
            diff = (roi - rroi) * 100 if n and rn else float("nan")
            verdict = ""
            if not name.startswith("ref_"):
                ok = n >= PASS_MIN_N and roi > 0 and z is not None and z >= PASS_MIN_Z and diff > 0
                verdict = "  PASS" if ok else ("  (n short)" if n < PASS_MIN_N else "  fail")
            print(f"  {name:24s} {fmt(n, wins, roi, z, k)}  vs complement "
                  f"{diff:+6.1f} pts (n={rn}){verdict}")


if __name__ == "__main__":
    main()
