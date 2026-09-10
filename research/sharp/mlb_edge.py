"""MLB micro-edge study: every feature we have, scored on BOTH readouts (ROI to resolution and CLV to the close),
train (created < 8/24) vs test (>= 8/24). A cut 'holds' if ROI > 0 and CLV > 0 in BOTH halves with n >= 40 each."""
import sqlite3, json, math, collections, datetime
db = sqlite3.connect("/root/polysharp/data/sharp.db", timeout=120)
rows = [json.loads(l) for l in open("/root/polysharp/mlb_feat.jsonl")]
cids = list({r["condition_id"] for r in rows}); mk = {}
for i in range(0, len(cids), 500):
    part = cids[i:i+500]
    for cid, q, t0, t1, st in db.execute(f"SELECT condition_id, question, token0, token1, start FROM markets WHERE condition_id IN ({','.join('?'*len(part))})", part): mk[cid] = (q, t0, t1, st)
snaps = sorted(r[0] for r in db.execute("SELECT DISTINCT asof FROM wallet_scores")); tiers = {}
def tier_at(ts):
    asof = max([a for a in snaps if a <= ts] or [None])
    if asof is None: return {}
    if asof not in tiers: tiers[asof] = {w: t for w, t in db.execute("SELECT wallet, tier FROM wallet_scores WHERE asof=? AND tier IN ('sharp','square')", (asof,))}
    return tiers[asof]
def side_token(lab, q):
    lab = (lab or "").strip().lower()
    if lab == "over": return 0
    if lab == "under": return 1
    seg = next((p for p in (q or "").split(":") if " vs" in p), q or "")
    teams = [x.strip().lower() for x in seg.replace(" vs. ", " vs ").split(" vs ")]
    if len(teams) == 2:
        if lab and (lab in teams[0] or teams[0] in lab): return 0
        if lab and (lab in teams[1] or teams[1] in lab): return 1
    return None
SPLIT = datetime.datetime(2026, 8, 24, tzinfo=datetime.timezone.utc).timestamp()
feat = []
for r in rows:
    m = mk.get(r["condition_id"])
    if not m: continue
    q, t0, t1, st = m; side = side_token(r["side_label"], q)
    if side is None or r["price"] is None: continue
    ts = int(r["created_at"]); tmap = tier_at(ts)
    sharp = sq = crowd = 0.0
    for w, asset, sd, px, sz, fts in db.execute("SELECT wallet, asset, side, price, size, ts FROM trades WHERE condition_id=? AND ts < ? ORDER BY ts", (r["condition_id"], min(ts, st - 900))):
        is0 = asset == t0; sign = 1 if ((sd == "BUY") == is0) else -1; agree = 1 if ((sign > 0) == (side == 0)) else -1; usd = px * sz
        crowd += agree * usd; t = tmap.get(w)
        if t == "sharp": sharp += agree * usd
        if t == "square": sq += agree * usd
    comp = json.loads(r["comp"]) if r.get("comp") else {}
    th = json.loads(r["th"]) if r.get("th") else []
    top_share = (th[0].get("amountUsd", 0) / max(1e-9, sum(h.get("amountUsd", 0) for h in th))) if th else None
    top_pnl = th[0].get("pnlAll") if th else None
    gates = json.loads(r["gates_json"]) if r.get("gates_json") else None
    allpass = all(v.get("pass") for v in gates.values()) if gates else None
    et = r.get("event_time"); hour_et = None
    if et:
        try:
            hour_et = (datetime.datetime.fromtimestamp(int(et), datetime.timezone.utc) - datetime.timedelta(hours=4)).hour
        except Exception: pass
    line = None
    if r["market_type"] == "total":
        import re; mm = re.search(r"O/U\s*([\d.]+)", r["market_title"] or ""); line = float(mm.group(1)) if mm else None
    is_ml = r["market_type"] == "moneyline"
    feat.append(dict(cid=r["condition_id"], src=r["src"], roi=r["roi"], clv=r["clv"], test=ts >= SPLIT, mtype=r["market_type"], price=r["price"],
                     home=(side == 1) if is_ml else None, fav=r["price"] >= 0.5, over=(side == 0) if r["market_type"] == "total" else None, line=line, hour=hour_et,
                     ss=r.get("signal_score"), er=r.get("edge_rating"), pe=r.get("price_edge"), sd=r.get("score_differential"), mq=r.get("market_quality_score"),
                     grade=r.get("grade"), mts=r.get("minutes_to_start"), trend=comp.get("trendScore"), nov=comp.get("noveltyScore"), snaps=comp.get("snapshotCount"),
                     degenerate=comp.get("degenerate"), top_share=top_share, top_pnl=top_pnl, nholders=len(th) if th else None, allpass=allpass,
                     sharp=sharp, sq=sq, crowd=crowd))
def st(rs, key):
    xs = [(x[key], x["cid"]) for x in rs if x.get(key) is not None]; n = len(xs)
    if n < 2: return (0, 0, n)
    m = sum(v for v, _ in xs) / n; g = collections.defaultdict(lambda: [0.0, 0])
    for v, c in xs: g[c][0] += v; g[c][1] += 1
    se = math.sqrt(sum((s - m * k) ** 2 for s, k in g.values())) / n
    return (m, se, n)
def f(m, se, n, sc, u): return f"{m*sc:+.1f}{u}" if n >= 2 else "  n/a "
cuts = [
    ("ML home", lambda x: x["home"] is True), ("ML away", lambda x: x["home"] is False),
    ("ML home dog", lambda x: x["home"] is True and not x["fav"]), ("ML home fav", lambda x: x["home"] is True and x["fav"]),
    ("ML away dog", lambda x: x["home"] is False and not x["fav"]), ("ML away fav", lambda x: x["home"] is False and x["fav"]),
    ("Total Over", lambda x: x["over"] is True), ("Total Under", lambda x: x["over"] is False),
    ("Total line <= 7.5", lambda x: x["line"] is not None and x["line"] <= 7.5), ("Total line 8-8.5", lambda x: x["line"] is not None and 8 <= x["line"] <= 8.5), ("Total line >= 9", lambda x: x["line"] is not None and x["line"] >= 9),
    ("Under, line >= 9", lambda x: x["over"] is False and x["line"] and x["line"] >= 9), ("Over, line <= 7.5", lambda x: x["over"] is True and x["line"] and x["line"] <= 7.5),
    ("Day game (ET < 17)", lambda x: x["hour"] is not None and x["hour"] < 17), ("Night game", lambda x: x["hour"] is not None and x["hour"] >= 17),
    ("Total Under night", lambda x: x["over"] is False and x["hour"] is not None and x["hour"] >= 17), ("Total Over day", lambda x: x["over"] is True and x["hour"] is not None and x["hour"] < 17),
    ("signal_score < 60", lambda x: x["ss"] is not None and x["ss"] < 60), ("signal_score 60-75", lambda x: x["ss"] is not None and 60 <= x["ss"] < 75), ("signal_score 75-90", lambda x: x["ss"] is not None and 75 <= x["ss"] < 90), ("signal_score >= 90 (saturation)", lambda x: x["ss"] is not None and x["ss"] >= 90),
    ("edge_rating < 66", lambda x: x["er"] is not None and x["er"] < 66), ("edge_rating 66-72", lambda x: x["er"] is not None and 66 <= x["er"] < 72), ("edge_rating 72-80 (dead zone)", lambda x: x["er"] is not None and 72 <= x["er"] < 80), ("edge_rating 80-90", lambda x: x["er"] is not None and 80 <= x["er"] < 90), ("edge_rating >= 90", lambda x: x["er"] is not None and x["er"] >= 90),
    ("price_edge < .1", lambda x: x["pe"] is not None and x["pe"] < .1), ("price_edge .1-.25", lambda x: x["pe"] is not None and .1 <= x["pe"] < .25), ("price_edge >= .25", lambda x: x["pe"] is not None and x["pe"] >= .25),
    ("score_diff < 20", lambda x: x["sd"] is not None and x["sd"] < 20), ("score_diff 20-40", lambda x: x["sd"] is not None and 20 <= x["sd"] < 40), ("score_diff >= 40", lambda x: x["sd"] is not None and x["sd"] >= 40),
    ("market_quality >= .85", lambda x: x["mq"] is not None and x["mq"] >= .85), ("market_quality < .85", lambda x: x["mq"] is not None and x["mq"] < .85),
    ("grade A/A+", lambda x: (x["grade"] or "").startswith("A")), ("grade B", lambda x: (x["grade"] or "").startswith("B")), ("grade C or worse", lambda x: (x["grade"] or "") and x["grade"][0] in "CDF"),
    ("trendScore > 0", lambda x: (x["trend"] or 0) > 0), ("trendScore <= 0", lambda x: x["trend"] is not None and x["trend"] <= 0),
    ("novelty >= 4", lambda x: (x["nov"] or 0) >= 4), ("snapshots >= 10", lambda x: (x["snaps"] or 0) >= 10), ("degenerate signal", lambda x: x["degenerate"] is True),
    ("top holder > 50% of side", lambda x: x["top_share"] is not None and x["top_share"] > .5), ("top holder < 25% of side", lambda x: x["top_share"] is not None and x["top_share"] < .25),
    ("top holder pnlAll > $250k", lambda x: (x["top_pnl"] or 0) > 250000), ("top holder pnlAll < $50k", lambda x: x["top_pnl"] is not None and x["top_pnl"] < 50000),
    ("minutes_to_start < 60", lambda x: x["mts"] is not None and x["mts"] < 60), ("minutes_to_start 60-180", lambda x: x["mts"] is not None and 60 <= x["mts"] < 180), ("minutes_to_start >= 180", lambda x: x["mts"] is not None and x["mts"] >= 180),
    ("all gates pass", lambda x: x["allpass"] is True),
    ("tape sharps agree >= $500", lambda x: x["sharp"] >= 500), ("tape sharps against >= $500", lambda x: x["sharp"] <= -500),
    ("squares against >= $500", lambda x: x["sq"] <= -500), ("crowd against >= $5k", lambda x: x["crowd"] <= -5000), ("crowd with >= $5k", lambda x: x["crowd"] >= 5000),
    ("home dog AND sharps not against", lambda x: x["home"] is True and not x["fav"] and x["sharp"] > -500),
    ("Under AND squares against", lambda x: x["over"] is False and x["sq"] <= -500), ("Over AND crowd against", lambda x: x["over"] is True and x["crowd"] <= -5000),
]
shadow = [x for x in feat if x["src"] == "shadow"]; live = [x for x in feat if x["src"] == "live"]
print(f"shadow rows {len(shadow)} (train {sum(1 for x in shadow if not x['test'])} / test {sum(1 for x in shadow if x['test'])}), live {len(live)}")
print(f"{'cut':36s} | {'TRAIN roi':>9s} {'clv':>6s} {'n':>4s} | {'TEST roi':>9s} {'clv':>6s} {'n':>4s} | live roi n | verdict")
holds = []
for name, fn in cuts:
    tr = [x for x in shadow if not x["test"] and fn(x)]; te = [x for x in shadow if x["test"] and fn(x)]; lv = [x for x in live if fn(x)]
    a = st(tr, "roi"); b = st(tr, "clv"); c = st(te, "roi"); d = st(te, "clv"); e = st(lv, "roi")
    ok = a[2] >= 40 and c[2] >= 40 and a[0] > 0 and c[0] > 0 and b[0] > 0 and d[0] > 0
    v = "HOLDS" if ok else ("roi both +" if a[2] >= 40 and c[2] >= 40 and a[0] > 0 and c[0] > 0 else "")
    if ok: holds.append(name)
    print(f"{name:36s} | {f(a[0],a[1],a[2],100,'%'):>9s} {f(b[0],b[1],b[2],100,'c'):>6s} {a[2]:4d} | {f(c[0],c[1],c[2],100,'%'):>9s} {f(d[0],d[1],d[2],100,'c'):>6s} {c[2]:4d} | {f(e[0],e[1],e[2],100,'%'):>7s} {e[2]:3d} | {v}")
print("\nCUTS THAT HOLD (ROI>0 and CLV>0 in both halves, n>=40 each):", holds or "none")
print(f"baseline shadow: train ROI {st([x for x in shadow if not x['test']],'roi')[0]*100:+.1f}% test ROI {st([x for x in shadow if x['test']],'roi')[0]*100:+.1f}%")
