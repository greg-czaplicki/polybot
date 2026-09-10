"""Weekly per-sport edge read on the shadow book, both readouts (ROI, CLV), ONE ROW PER GAME PER CUT (first-created row),
train/test split by date. Usage: python3 sport_edge.py <sport_tag> <split YYYY-MM-DD> [season_start YYYY-MM-DD]
Exports from D1 via the project's wrangler helper; run from the repo root."""
import json, math, re, subprocess, sys, datetime, collections
sport, split = sys.argv[1], sys.argv[2]
season_start = sys.argv[3] if len(sys.argv) > 3 else "2026-07-30"
SPLIT = datetime.datetime.fromisoformat(split).replace(tzinfo=datetime.timezone.utc).timestamp()
sql = f"""SELECT condition_id, market_type, market_title, sharp_side_label, price, roi, clv, reject_reason, created_at, event_time, gates_json, signal_score, edge_rating, price_edge, score_differential, market_quality_score
          FROM shadow_candidates WHERE sport_tag='{sport}' AND roi IS NOT NULL AND event_time >= strftime('%s','{season_start}') ORDER BY created_at"""
out = subprocess.run(["bash", "scripts/wrangler-local.sh", "pnpm", "exec", "wrangler", "d1", "execute", "polywhaler-db", "--remote", "--json", "--command", sql], capture_output=True, text=True).stdout
rows = json.loads(out[out.index("["):])[0]["results"]
def teams(title):
    seg = next((p for p in title.split(":") if " vs" in p), title)
    return [x.strip().lower() for x in seg.replace(" vs. ", " vs ").split(" vs ")]
def side_pos(title, lab):
    lab = (lab or "").lower()
    if lab == "over": return "over"
    if lab == "under": return "under"
    t = teams(title)
    if len(t) == 2:
        if lab in t[0] or t[0] in lab: return "away"
        if lab in t[1] or t[1] in lab: return "home"
    return None
for r in rows:
    r["pos"] = side_pos(r["market_title"], r["sharp_side_label"])
    t = teams(r["market_title"]); day = datetime.datetime.fromtimestamp(r["event_time"], datetime.timezone.utc).strftime("%Y-%m-%d")
    r["game"] = f"{day}:{'|'.join(sorted(t))}" if len(t) == 2 else f"{day}:{r['condition_id'][:8]}"
    r["test"] = r["created_at"] >= SPLIT
    m = re.search(r"O/U\s*([\d.]+)", r["market_title"] or ""); r["line"] = float(m.group(1)) if m else None
    m2 = re.search(r"\(([-+][\d.]+)\)", r["market_title"] or ""); r["spread"] = abs(float(m2.group(1))) if m2 else None
    g = json.loads(r["gates_json"]) if r.get("gates_json") else None; r["allpass"] = all(v.get("pass") for v in g.values()) if g else None
    r["hour"] = (datetime.datetime.fromtimestamp(r["event_time"], datetime.timezone.utc) - datetime.timedelta(hours=4)).hour
def one_per_game(rs):
    seen = set(); out = []
    for r in sorted(rs, key=lambda x: x["created_at"]):
        if r["game"] in seen: continue
        seen.add(r["game"]); out.append(r)
    return out
def st(rs):
    rs = one_per_game(rs); xs = [r["roi"] for r in rs]; n = len(xs)
    if n < 2: return (0, 0, n, 0)
    m = sum(xs) / n; sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1)); c = [r["clv"] for r in rs if r["clv"] is not None]
    return (m, m / (sd / math.sqrt(n)) if sd else 0, n, sum(c) / len(c) if c else 0)
cuts = [("ALL", lambda r: True), ("moneyline", lambda r: r["market_type"] == "moneyline"), ("spread", lambda r: r["market_type"] == "spread"), ("total", lambda r: r["market_type"] == "total"),
        ("all 5 gates pass", lambda r: r["allpass"] is True), ("probation-reason", lambda r: "probation" in (r["reject_reason"] or "")),
        ("ML home dog", lambda r: r["market_type"] == "moneyline" and r["pos"] == "home" and r["price"] < .5), ("ML home fav", lambda r: r["market_type"] == "moneyline" and r["pos"] == "home" and r["price"] >= .5),
        ("ML away dog", lambda r: r["market_type"] == "moneyline" and r["pos"] == "away" and r["price"] < .5), ("ML away fav", lambda r: r["market_type"] == "moneyline" and r["pos"] == "away" and r["price"] >= .5),
        ("spread home", lambda r: r["market_type"] == "spread" and r["pos"] == "home"), ("spread away", lambda r: r["market_type"] == "spread" and r["pos"] == "away"),
        ("spread key 3/7 (2.5-3.5, 6.5-7.5)", lambda r: r["spread"] is not None and (2.5 <= r["spread"] <= 3.5 or 6.5 <= r["spread"] <= 7.5)), ("spread big (>= 10)", lambda r: r["spread"] is not None and r["spread"] >= 10),
        ("Total Under", lambda r: r["pos"] == "under"), ("Total Over", lambda r: r["pos"] == "over"),
        ("Under, high line (top third)", lambda r: r["pos"] == "under" and r["line"] is not None and r["line"] >= 50), ("Over, low line (< 44)", lambda r: r["pos"] == "over" and r["line"] is not None and r["line"] < 44),
        ("day (ET < 17)", lambda r: r["hour"] < 17), ("primetime (ET >= 19)", lambda r: r["hour"] >= 19),
        ("signal_score >= 90", lambda r: (r["signal_score"] or 0) >= 90), ("edge_rating 80-90", lambda r: r["edge_rating"] is not None and 80 <= r["edge_rating"] < 90),
        ("price_edge >= .25", lambda r: (r["price_edge"] or 0) >= .25), ("price >= .6 (big fav)", lambda r: r["price"] >= .6), ("price <= .35 (big dog)", lambda r: r["price"] <= .35)]
games = len({r["game"] for r in rows})
print(f"{sport.upper()} shadow since {season_start}: {len(rows)} rows across {games} games; train {sum(1 for r in rows if not r['test'])} / test {sum(1 for r in rows if r['test'])} rows; split {split}")
print(f"{'cut (one row per game)':36s} | {'TRAIN roi':>9s} {'z':>5s} {'clv':>6s} {'games':>5s} | {'TEST roi':>9s} {'z':>5s} {'clv':>6s} {'games':>5s} | verdict")
for name, fn in cuts:
    a = st([r for r in rows if not r["test"] and fn(r)]); b = st([r for r in rows if r["test"] and fn(r)])
    v = "HOLDS" if a[2] >= 40 and b[2] >= 40 and a[0] > 0 and b[0] > 0 and a[3] > 0 and b[3] > 0 else ("roi both +" if a[2] >= 20 and b[2] >= 20 and a[0] > 0 and b[0] > 0 else "")
    print(f"{name:36s} | {a[0]*100:+8.1f}% {a[1]:+5.1f} {a[3]*100:+5.2f}c {a[2]:5d} | {b[0]*100:+8.1f}% {b[1]:+5.1f} {b[3]*100:+5.2f}c {b[2]:5d} | {v}")
