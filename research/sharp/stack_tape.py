import sqlite3, json, math, collections, time
db = sqlite3.connect("/root/polysharp/data/sharp.db", timeout=120)
rows = [json.loads(l) for l in open("/root/polysharp/mlb_rows.jsonl")]
cids = list({r["condition_id"] for r in rows})
mk = {}
for chunk in range(0, len(cids), 500):
    part = cids[chunk:chunk+500]
    for cid, q, t0, t1, st in db.execute(f"SELECT condition_id, question, token0, token1, start FROM markets WHERE condition_id IN ({','.join('?'*len(part))})", part):
        mk[cid] = (q, t0, t1, st)
snaps = sorted(r[0] for r in db.execute("SELECT DISTINCT asof FROM wallet_scores"))
tiers = {}
def tier_at(ts):
    asof = max([a for a in snaps if a <= ts] or [None])
    if asof is None: return None, {}
    if asof not in tiers:
        tiers[asof] = {w: t for w, t in db.execute("SELECT wallet, tier FROM wallet_scores WHERE asof=? AND tier IN ('sharp','square')", (asof,))}
    return asof, tiers[asof]
def side_token(r, q, t0, t1):
    lab = (r["side_label"] or "").strip().lower()
    if lab == "over": return 0
    if lab == "under": return 1
    seg = next((p for p in (q or "").split(":") if " vs" in p), q or "")
    teams = [x.strip().lower() for x in seg.replace(" vs. ", " vs ").split(" vs ")]
    if len(teams) == 2:
        if lab and (lab in teams[0] or teams[0] in lab): return 0
        if lab and (lab in teams[1] or teams[1] in lab): return 1
    return None
out = []
miss = collections.Counter()
for r in rows:
    m = mk.get(r["condition_id"])
    if not m: miss["no_market"] += 1; continue
    q, t0, t1, st = m
    side = side_token(r, q, t0, t1)
    if side is None: miss["no_side"] += 1; continue
    ts = int(r["created_at"]); asof, tmap = tier_at(ts)
    if asof is None: miss["no_snapshot"] += 1; continue
    fills = db.execute("SELECT wallet, asset, side, price, size, ts FROM trades WHERE condition_id=? AND ts < ? ORDER BY ts", (r["condition_id"], st - 900)).fetchall()
    sharp_pick = sq_pick = all_pick = sharp_fin = sq_fin = 0.0
    for w, asset, sd, px, sz, fts in fills:
        is0 = asset == t0; sign = 1 if ((sd == "BUY") == is0) else -1
        agree = 1 if ((sign > 0) == (side == 0)) else -1
        usd = px * sz; tier = tmap.get(w)
        if fts < ts:
            all_pick += agree * usd
            if tier == "sharp": sharp_pick += agree * usd
            if tier == "square": sq_pick += agree * usd
        if tier == "sharp": sharp_fin += agree * usd
        if tier == "square": sq_fin += agree * usd
    allpass = None
    if r.get("gates_json"):
        g = json.loads(r["gates_json"]); allpass = all(v.get("pass") for v in g.values())
    out.append(dict(src=r["src"], mtype=r["market_type"], price=r["price"], roi=r["roi"], clv=r["clv"], allpass=allpass, cid=r["condition_id"],
                    sharp_pick=sharp_pick, sq_pick=sq_pick, all_pick=all_pick, sharp_fin=sharp_fin, sq_fin=sq_fin))
print("rows", len(rows), "usable", len(out), "dropped", dict(miss))
def stat(rs, key="roi"):
    xs = [(x[key], x["cid"]) for x in rs if x.get(key) is not None]; n = len(xs)
    if n < 2: return f"n={n}"
    m = sum(v for v, _ in xs) / n
    g = collections.defaultdict(lambda: [0.0, 0])
    for v, c in xs: g[c][0] += v; g[c][1] += 1
    se = math.sqrt(sum((s - m * k) ** 2 for s, k in g.values())) / n
    return f"{m*100:+.1f}% (z={m/se:+.1f}, n={n})" if key == "roi" else f"{m*100:+.2f}c (z={m/se:+.1f})"
def block(title, rs):
    print(f"\n{title}: {len(rs)} rows  ROI {stat(rs)}  CLV {stat(rs,'clv')}")
    cuts = [("tape sharps AGREE at pick time (>= $500)", lambda x: x["sharp_pick"] >= 500),
            ("tape sharps DISAGREE at pick time (<= -$500)", lambda x: x["sharp_pick"] <= -500),
            ("no sharp money either way at pick", lambda x: abs(x["sharp_pick"]) < 500),
            ("sharps agree by T-15 (>= $500)", lambda x: x["sharp_fin"] >= 500),
            ("sharps disagree by T-15", lambda x: x["sharp_fin"] <= -500),
            ("squares on OUR side at pick (>= $500)", lambda x: x["sq_pick"] >= 500),
            ("squares AGAINST us at pick", lambda x: x["sq_pick"] <= -500),
            ("crowd with us at pick (>= $5k)", lambda x: x["all_pick"] >= 5000),
            ("crowd against us at pick", lambda x: x["all_pick"] <= -5000),
            ("favorite (price >= .5)", lambda x: (x["price"] or 0) >= .5), ("underdog", lambda x: (x["price"] or 0) < .5),
            ("moneyline", lambda x: x["mtype"] == "moneyline"), ("total", lambda x: x["mtype"] == "total"),
            ("sharps agree AND squares against", lambda x: x["sharp_pick"] >= 500 and x["sq_pick"] <= -500),
            ("sharps agree AND underdog", lambda x: x["sharp_pick"] >= 500 and (x["price"] or 0) < .5)]
    for name, f in cuts:
        sub = [x for x in rs if f(x)]
        if len(sub) >= 8: print(f"  {name:44s} ROI {stat(sub):26s} CLV {stat(sub,'clv')}")
block("LIVE MLB BOOK (real bets since 7/20)", [x for x in out if x["src"] == "live"])
block("SHADOW MLB, would-have-bet (all gates pass)", [x for x in out if x["src"] == "shadow" and x["allpass"]])
block("SHADOW MLB, all rows (any gate)", [x for x in out if x["src"] == "shadow"])
