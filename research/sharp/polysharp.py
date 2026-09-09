"""polysharp — the sharp-money pipeline on the exchange tape. Stdlib only; runs on the VPS.

  daily : universe (new pregame markets from polybook) → crawl settled tapes → weekly as-of wallet scores
          → one signal row per market (first qualifying sharp fill, features at that moment) → settle → report
  live  : poll Data API for markets starting within LIVE_HOURS; record fills by currently-sharp wallets as alerts

Skill is measured ONLY on settled pregame sports fills (>15 min before start): per-wallet ROI, CLV, t-stats,
trailing-20 form, 7d/30d P&L, per-sport record, median size. Scores are snapshotted weekly (as-of Mondays 00:00 UTC)
from fills whose market started >= 4h before the snapshot; a fill is scored with the latest snapshot at or before
its own timestamp — nothing looks ahead. Sharp = top decile of roi_t among wallets with >= MIN_N settled fills;
square = bottom decile. Follow entry = fill price + ENTRY_COST (fee observed 0 on the wire).
"""
import json, math, os, sqlite3, sys, time, urllib.request, urllib.error
from collections import defaultdict

DB = os.environ.get("SHARP_DB", "/root/polysharp/data/sharp.db")
BOOK_DB = os.environ.get("BOOK_DB", "/root/polybook/data/polybook.db")
REPORT_DIR = os.environ.get("REPORT_DIR", "/root/polysharp/data/reports")
UA = {"User-Agent": "polysharp/0.1"}
MIN_N = 20; MIN_FILL_USD = 100.0; ENTRY_COST = 0.005; PRE_SEC = 900; SETTLE_LAG = 4 * 3600
LIVE_HOURS = 3; PAUSE = 0.12
SPORTS = None  # None = all sports with a game start; esports are kept but reported separately

SCHEMA = """
CREATE TABLE IF NOT EXISTS markets (condition_id TEXT PRIMARY KEY, sport TEXT, market_type TEXT, start INTEGER, question TEXT,
  token0 TEXT, token1 TEXT, winner0 INTEGER, status TEXT, trades_n INTEGER, prices_n INTEGER, fetched_at INTEGER, source TEXT);
CREATE TABLE IF NOT EXISTS trades (condition_id TEXT, tx TEXT, wallet TEXT, asset TEXT, side TEXT, price REAL, size REAL, ts INTEGER,
  PRIMARY KEY (condition_id, tx, wallet, asset, side, price, size, ts));
CREATE INDEX IF NOT EXISTS trades_wallet ON trades(wallet); CREATE INDEX IF NOT EXISTS trades_cond ON trades(condition_id, ts);
CREATE TABLE IF NOT EXISTS prices (condition_id TEXT, ts INTEGER, p REAL, PRIMARY KEY (condition_id, ts));
CREATE TABLE IF NOT EXISTS wallet_scores (asof INTEGER, wallet TEXT, n INTEGER, roi_mean REAL, roi_t REAL, clv_mean REAL, clv_t REAL,
  usd REAL, last20_roi REAL, pnl_7d REAL, pnl_30d REAL, median_usd REAL, sports_json TEXT, tier TEXT, PRIMARY KEY (asof, wallet));
CREATE INDEX IF NOT EXISTS ws_asof_tier ON wallet_scores(asof, tier);
CREATE TABLE IF NOT EXISTS signals (condition_id TEXT PRIMARY KEY, asof INTEGER, sport TEXT, market_type TEXT, start INTEGER, fired_ts INTEGER,
  wallet TEXT, side INTEGER, fill_price REAL, entry_price REAL, usd REAL, wallet_roi_t REAL, streak REAL, size_ratio REAL,
  sq_opp_usd REAL, crowd_same_usd REAL, mins_to_start REAL, settled INTEGER DEFAULT 0, win INTEGER, roi_follow REAL, clv REAL);
CREATE TABLE IF NOT EXISTS live_alerts (condition_id TEXT, ts INTEGER, wallet TEXT, tx TEXT, side INTEGER, price REAL, usd REAL,
  wallet_roi_t REAL, streak REAL, sq_opp_usd REAL, question TEXT, start INTEGER, PRIMARY KEY (condition_id, tx, wallet, side, price));
"""


def get(url, retries=4):
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            time.sleep(2 * (i + 1))
        except Exception:
            time.sleep(2 * (i + 1))
    return None


def tstat(xs):
    n = len(xs)
    if n < 2: return 0.0
    m = sum(xs) / n; v = sum((x - m) ** 2 for x in xs) / (n - 1)
    return m / math.sqrt(v / n) if v > 1e-6 else 0.0


# ---------------------------------------------------------------- universe + crawl
def update_universe(db):
    if not os.path.exists(BOOK_DB): return 0
    db.execute("ATTACH DATABASE ? AS book", (BOOK_DB,))
    n = db.execute("""INSERT OR IGNORE INTO markets (condition_id, sport, market_type, start, question, token0, token1, status, source)
        SELECT condition_id, sport_hint, CASE WHEN question LIKE '%O/U%' OR question LIKE '%Over/Under%' THEN 'total'
               WHEN question LIKE 'Spread:%' THEN 'spread' WHEN question LIKE '%:%' THEN 'prop' ELSE 'moneyline' END,
               game_start, question, token0, token1, 'pending', 'polybook' FROM book.markets""").rowcount
    db.commit(); db.execute("DETACH DATABASE book")
    return n


def crawl(db, limit=400):
    now = int(time.time())
    rows = db.execute("SELECT condition_id, start FROM markets WHERE status IN ('pending','unresolved') AND start + ? < ? ORDER BY start LIMIT ?",
                      (SETTLE_LAG, now, limit)).fetchall()
    done = 0
    for cid, st in rows:
        meta = get(f"https://clob.polymarket.com/markets/{cid}"); time.sleep(PAUSE)
        if not meta or not meta.get("tokens"):
            db.execute("UPDATE markets SET status='error', fetched_at=? WHERE condition_id=?", (now, cid)); continue
        toks = meta["tokens"]
        winner0 = 1 if toks[0].get("winner") else (0 if toks[1].get("winner") else None)
        gs = meta.get("game_start_time")
        if gs:
            try:
                from datetime import datetime
                st = int(datetime.fromisoformat(gs.replace("Z", "+00:00")).timestamp())
            except ValueError:
                pass
        off = 0; n = 0
        while True:
            page = get(f"https://data-api.polymarket.com/trades?market={cid}&limit=1000&offset={off}") or []; time.sleep(PAUSE)
            db.executemany("INSERT OR IGNORE INTO trades VALUES (?,?,?,?,?,?,?,?)",
                [(cid, x.get("transactionHash"), x.get("proxyWallet"), x.get("asset"), x.get("side"), float(x["price"]), float(x["size"]), int(x["timestamp"])) for x in page])
            n += len(page)
            if len(page) < 1000 or off >= 20000: break
            off += 1000
        hist = get(f"https://clob.polymarket.com/prices-history?market={toks[0]['token_id']}&startTs={st-6*3600}&endTs={st+3600}&fidelity=1") or {}
        time.sleep(PAUSE)
        pts = hist.get("history", [])
        db.executemany("INSERT OR IGNORE INTO prices VALUES (?,?,?)", [(cid, int(p["t"]), float(p["p"])) for p in pts])
        status = "done" if winner0 is not None else "unresolved"
        db.execute("UPDATE markets SET start=?, token0=?, token1=?, winner0=?, status=?, trades_n=?, prices_n=?, fetched_at=? WHERE condition_id=?",
                   (st, toks[0]["token_id"], toks[1]["token_id"], winner0, status, n, len(pts), now, cid))
        db.commit(); done += 1
    return done


# ---------------------------------------------------------------- fills with labels
def load_fills(db, max_start=None):
    """Pregame fills on resolved markets, token0 terms, with own ROI and CLV. Returns list of dicts sorted by ts."""
    q = """SELECT t.condition_id, t.wallet, t.asset, t.side, t.price, t.size, t.ts, m.sport, m.market_type, m.start, m.token0, m.winner0
           FROM trades t JOIN markets m ON m.condition_id=t.condition_id
           WHERE m.status='done' AND m.winner0 IS NOT NULL AND t.ts < m.start - ?"""
    args = [PRE_SEC]
    if max_start: q += " AND m.start < ?"; args.append(max_start)
    close = {}
    for cid, ts, p in db.execute("SELECT p.condition_id, p.ts, p.p FROM prices p JOIN markets m ON m.condition_id=p.condition_id WHERE p.ts BETWEEN m.start-120 AND m.start ORDER BY p.ts"):
        close[cid] = p  # last price at/just before start
    out = []
    for cid, w, asset, side, price, size, ts, sport, mtype, st, tok0, win0 in db.execute(q, args):
        is0 = asset == tok0
        sign = 1 if ((side == "BUY") == is0) else -1        # +1 = bought token0-equivalent
        p0 = price if is0 else 1 - price
        side_price = p0 if sign > 0 else 1 - p0
        if not (0.05 < side_price < 0.95): continue
        side_win = (win0 == 1) if sign > 0 else (win0 == 0)
        c = close.get(cid)
        out.append(dict(cid=cid, wallet=w, sign=sign, p0=p0, side_price=side_price, usd=price * size, ts=ts, sport=sport, mtype=mtype, start=st,
                        win=side_win, roi=(1 / side_price - 1) if side_win else -1.0,
                        roi_follow=(1 / (side_price + ENTRY_COST) - 1) if side_win else -1.0,
                        clv=(sign * (c - p0)) if c is not None else None))
    out.sort(key=lambda f: f["ts"])
    return out


# ---------------------------------------------------------------- wallet scores (as-of)
def monday(ts):
    from datetime import datetime, timezone, timedelta
    d = datetime.fromtimestamp(ts, timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return int((d - timedelta(days=d.weekday())).timestamp())


def per_market(fills):
    """Collapse a wallet's fills to ONE observation per market (usd-weighted), so repeat fills cannot inflate t-stats."""
    acc = {}
    for f in fills:
        k = (f["wallet"], f["cid"])
        a = acc.get(k)
        if a is None:
            acc[k] = dict(f, usd=f["usd"], _roi=f["roi"] * f["usd"], _clv=(f["clv"] * f["usd"]) if f["clv"] is not None else None, _clvw=f["usd"] if f["clv"] is not None else 0.0)
        else:
            a["usd"] += f["usd"]; a["_roi"] += f["roi"] * f["usd"]
            if f["clv"] is not None:
                a["_clv"] = (a["_clv"] or 0.0) + f["clv"] * f["usd"]; a["_clvw"] += f["usd"]
    out = []
    for a in acc.values():
        a["roi"] = a["_roi"] / a["usd"]; a["clv"] = (a["_clv"] / a["_clvw"]) if a["_clvw"] > 0 else None
        out.append(a)
    out.sort(key=lambda f: f["ts"])
    return out


def score_wallets(db, asof, fills):
    """Snapshot per-wallet skill on settled markets (one observation per market) whose start >= SETTLE_LAG before asof."""
    per = defaultdict(list)
    for f in per_market(fills):
        if f["start"] + SETTLE_LAG <= asof:
            per[f["wallet"]].append(f)
    rows = []
    for w, fs in per.items():
        if len(fs) < MIN_N: continue
        rois = [f["roi"] for f in fs]; clvs = [f["clv"] for f in fs if f["clv"] is not None]
        usd = sorted(f["usd"] for f in fs)
        sports = defaultdict(lambda: [0, 0.0])
        for f in fs: sports[f["sport"]][0] += 1; sports[f["sport"]][1] += f["roi"]
        sj = {s: {"n": v[0], "roi": round(v[1] / v[0], 3)} for s, v in sports.items()}
        rows.append((asof, w, len(fs), sum(rois) / len(rois), tstat(rois), (sum(clvs) / len(clvs)) if clvs else None, tstat(clvs) if len(clvs) > 1 else 0.0,
                     sum(usd), sum(f["roi"] for f in fs[-20:]) / min(20, len(fs)),
                     sum(f["roi"] * f["usd"] for f in fs if f["ts"] >= asof - 7 * 86400), sum(f["roi"] * f["usd"] for f in fs if f["ts"] >= asof - 30 * 86400),
                     usd[len(usd) // 2], json.dumps(sj)))
    if not rows: return 0
    rows.sort(key=lambda r: r[4])
    k = max(1, len(rows) // 10)
    tiers = ["square"] * k + ["mid"] * (len(rows) - 2 * k) + ["sharp"] * k
    db.executemany("INSERT OR REPLACE INTO wallet_scores VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [r + (t,) for r, t in zip(rows, tiers)])
    db.commit()
    return len(rows)


def ensure_snapshots(db, fills):
    have = {r[0] for r in db.execute("SELECT DISTINCT asof FROM wallet_scores")}
    first = min(f["start"] for f in fills) if fills else int(time.time())
    asof = monday(first) + 14 * 86400          # first snapshot two weeks after data begins
    now = int(time.time()); made = []
    while asof <= now:
        if asof not in have:
            n = score_wallets(db, asof, fills); made.append((asof, n))
        asof += 7 * 86400
    return made


def tiers_asof(db, ts):
    row = db.execute("SELECT MAX(asof) FROM wallet_scores WHERE asof <= ?", (ts,)).fetchone()
    if not row or row[0] is None: return None, {}, {}
    asof = row[0]
    sharp = {}; square = set()
    for w, t, tier, l20, med in db.execute("SELECT wallet, roi_t, tier, last20_roi, median_usd FROM wallet_scores WHERE asof=? AND tier IN ('sharp','square')", (asof,)):
        if tier == "sharp": sharp[w] = (t, l20, med)
        else: square.add(w)
    return asof, sharp, square


# ---------------------------------------------------------------- signals
def build_signals(db, fills):
    """One row per market: first sharp fill >= MIN_FILL_USD, features from the tape up to that fill."""
    by_mkt = defaultdict(list)
    for f in fills: by_mkt[f["cid"]].append(f)
    have = {r[0] for r in db.execute("SELECT condition_id FROM signals")}
    made = 0
    cache = {}
    for cid, fs in by_mkt.items():
        if cid in have: continue
        sq_net = 0.0; all_net = 0.0; sig = None
        for f in fs:
            asof, sharp, square = cache.get(monday(f["ts"])) or cache.setdefault(monday(f["ts"]), tiers_asof(db, f["ts"]))
            if asof is None: break
            if f["wallet"] in sharp and f["usd"] >= MIN_FILL_USD and sig is None:
                t, l20, med = sharp[f["wallet"]]
                sig = (cid, asof, f["sport"], f["mtype"], f["start"], f["ts"], f["wallet"], 0 if f["sign"] > 0 else 1, f["side_price"], f["side_price"] + ENTRY_COST,
                       f["usd"], t, l20, (f["usd"] / med) if med else None, -f["sign"] * sq_net, f["sign"] * all_net, (f["start"] - f["ts"]) / 60,
                       1, int(f["win"]), f["roi_follow"], f["clv"])
                break
            if f["wallet"] in square: sq_net += f["sign"] * f["usd"]
            all_net += f["sign"] * f["usd"]
        if sig:
            db.execute("INSERT OR IGNORE INTO signals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", sig); made += 1
    db.commit()
    return made


# ---------------------------------------------------------------- push to the app (D1) — best effort, like the bot's status report
def app_config():
    env = {}
    try:
        for line in open(os.environ.get("BOT_ENV_PATH", "/root/polybot/.env")):
            if "=" in line and not line.startswith("#"):
                k, v = line.rstrip("\n").split("=", 1); env[k.strip()] = v.strip().strip('"')
    except OSError:
        pass
    return env.get("BOT_BASE_URL", ""), env.get("BOT_API_KEY", "")


def push(payload):
    base, key = app_config()
    if not base or not key:
        print("push skipped: no BOT_BASE_URL/BOT_API_KEY"); return None
    req = urllib.request.Request(f"{base}/api/bot/sharp-alerts", method="POST", data=json.dumps(payload).encode(),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "polysharp/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            out = json.load(r); print("push:", out); return out
    except Exception as e:  # noqa
        print("push failed:", str(e)[:200]); return None


def push_alerts(db, since_ts):
    rows = db.execute("""SELECT a.condition_id, a.tx, a.question, a.side, a.price, a.usd, a.wallet_roi_t, a.streak, a.sq_opp_usd, a.start, a.ts, a.wallet,
                                b.sport_hint, CASE a.side WHEN 0 THEN b.label0 ELSE b.label1 END, s.n, s.roi_mean
                         FROM live_alerts a LEFT JOIN book.markets b ON b.condition_id=a.condition_id
                         LEFT JOIN wallet_scores s ON s.wallet=a.wallet AND s.asof=(SELECT MAX(asof) FROM wallet_scores)
                         WHERE a.ts >= ? ORDER BY a.ts""", (since_ts,)).fetchall()
    if not rows: return
    alerts = [dict(condition_id=r[0], tx=r[1], question=r[2], side=r[3], price=r[4], usd=r[5], wallet_roi_t=r[6], streak=r[7], sq_opp_usd=r[8],
                   start=r[9], ts=r[10], wallet=r[11], sport=r[12], side_label=r[13], wallet_markets=r[14], wallet_roi=r[15]) for r in rows]
    push({"alerts": alerts})


def summary(db):
    now = int(time.time())
    rows = db.execute("SELECT sport, win, roi_follow, clv, start FROM signals WHERE settled=1").fetchall()
    def agg(rs):
        n = len(rs)
        if not n: return {"n": 0}
        roi = sum(r[2] for r in rs) / n; clvs = [r[3] for r in rs if r[3] is not None]
        return {"n": n, "roi": round(roi, 4), "clv": round(sum(clvs) / len(clvs), 5) if clvs else None, "wins": sum(r[1] for r in rs)}
    by = defaultdict(list)
    for r in rows: by[r[0]].append(r)
    return {"updatedAt": now, "all": agg(rows), "last14d": agg([r for r in rows if r[4] >= now - 14 * 86400]),
            "sports": {s: agg(rs) for s, rs in by.items() if len(rs) >= 8},
            "sharpWallets": db.execute("SELECT COUNT(*) FROM wallet_scores WHERE asof=(SELECT MAX(asof) FROM wallet_scores) AND tier='sharp'").fetchone()[0],
            "snapshotAsof": db.execute("SELECT MAX(asof) FROM wallet_scores").fetchone()[0]}


# ---------------------------------------------------------------- live
def live(db):
    now = int(time.time())
    asof, sharp, square = tiers_asof(db, now)
    if not sharp: print("no wallet snapshot yet"); return
    if not os.path.exists(BOOK_DB): print("no polybook db"); return
    bdb = sqlite3.connect(BOOK_DB)
    up = bdb.execute("SELECT condition_id, question, token0, game_start FROM markets WHERE game_start BETWEEN ? AND ?", (now + PRE_SEC, now + LIVE_HOURS * 3600)).fetchall()
    new = 0
    for cid, q, tok0, gs in up:
        page = get(f"https://data-api.polymarket.com/trades?market={cid}&limit=200") or []; time.sleep(PAUSE)
        sq_net = 0.0
        for x in sorted(page, key=lambda x: x["timestamp"]):
            w = x.get("proxyWallet"); is0 = x.get("asset") == tok0; sign = 1 if ((x.get("side") == "BUY") == is0) else -1
            usd = float(x["price"]) * float(x["size"])
            if w in square: sq_net += sign * usd
            if w in sharp and usd >= MIN_FILL_USD and int(x["timestamp"]) < gs - PRE_SEC:
                t, l20, med = sharp[w]
                side_price = float(x["price"])
                r = db.execute("INSERT OR IGNORE INTO live_alerts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (cid, int(x["timestamp"]), w, x.get("transactionHash"), 0 if sign > 0 else 1, side_price, usd, t, l20, -sign * sq_net, q, gs))
                new += r.rowcount
    db.commit()
    print(f"live: {len(up)} upcoming markets polled, {new} new sharp alerts")
    if new:
        db.execute("ATTACH DATABASE ? AS book", (BOOK_DB,))
        push_alerts(db, now - 6 * 3600)
        db.execute("DETACH DATABASE book")
    for r in db.execute("SELECT datetime(ts,'unixepoch'), question, side, price, usd, round(wallet_roi_t,1), round(streak,2), round(sq_opp_usd), datetime(start,'unixepoch') FROM live_alerts WHERE start > ? ORDER BY ts DESC LIMIT 15", (now,)):
        print("  ", r)


# ---------------------------------------------------------------- report
def cl(rows, key):
    xs = [(r[key], r["cid"]) for r in rows if r.get(key) is not None]
    n = len(xs)
    if n < 2: return (0.0, 0.0, n)
    m = sum(x for x, _ in xs) / n
    g = defaultdict(lambda: [0.0, 0])
    for x, c in xs: g[c][0] += x; g[c][1] += 1
    se = math.sqrt(sum((s - m * k) ** 2 for s, k in g.values())) / n
    return (m, se, n)


def fmt(m, se, n, scale=100, unit="%"):
    return f"{m*scale:+.1f}{unit} (z={m/se:+.1f}, n={n})" if n >= 2 and se > 0 else f"n={n}"


def report(db):
    now = int(time.time())
    cols = ["cid", "sport", "mtype", "start", "side", "usd", "streak", "size_ratio", "sq_opp", "crowd", "mins", "win", "roi", "clv"]
    rows = [dict(zip(cols, r)) for r in db.execute("SELECT condition_id, sport, market_type, start, side, usd, streak, size_ratio, sq_opp_usd, crowd_same_usd, mins_to_start, win, roi_follow, clv FROM signals WHERE settled=1")]
    n_done = db.execute("SELECT COUNT(*) FROM markets WHERE status='done'").fetchone()[0]
    n_pend = db.execute("SELECT COUNT(*) FROM markets WHERE status='pending'").fetchone()[0]
    n_tr = db.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
    n_snap = db.execute("SELECT COUNT(DISTINCT asof) FROM wallet_scores").fetchone()[0]
    stamp = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(now))
    lines = [f"polysharp report {stamp}",
             f"markets: {n_done} settled, {n_pend} pending; trades {n_tr}; snapshots {n_snap}; signals settled {len(rows)}",
             "", "ONE BET PER MARKET (first sharp fill >= $100, entry = fill + 0.5c, held to resolution)"]
    def line(name, rs):
        m, se, n = cl(rs, "roi"); c = cl(rs, "clv")
        wins = sum(r["win"] for r in rs)
        recent = [r for r in rs if r["start"] >= now - 14 * 86400]; older = [r for r in rs if r["start"] < now - 14 * 86400]
        lines.append(f"  {name:34s} ROI {fmt(m,se,n):26s} CLV {fmt(c[0],c[1],c[2],100,'c'):24s} wins {wins}/{n}  | last14d {cl(recent,'roi')[0]*100:+.0f}% (n={len(recent)})  before {cl(older,'roi')[0]*100:+.0f}% (n={len(older)})")
    line("ALL", rows)
    for s in sorted({r["sport"] for r in rows}, key=lambda s: -sum(1 for r in rows if r["sport"] == s)):
        rs = [r for r in rows if r["sport"] == s]
        if len(rs) >= 8: line(s, rs)
    lines.append(""); lines.append("FEATURES (all sports):")
    line("squares on opposite side >= $500", [r for r in rows if (r["sq_opp"] or 0) >= 500])
    line("squares on same side >= $500", [r for r in rows if (r["sq_opp"] or 0) <= -500])
    line("hot streak > +10%", [r for r in rows if (r["streak"] or 0) > 0.10])
    line("cold streak < -10%", [r for r in rows if (r["streak"] or 0) < -0.10])
    line("hot AND squares opposite", [r for r in rows if (r["streak"] or 0) > 0.10 and (r["sq_opp"] or 0) >= 500])
    line("size >= 2x wallet median", [r for r in rows if (r["size_ratio"] or 0) >= 2])
    line("fired > 4h before start", [r for r in rows if (r["mins"] or 0) > 240])
    line("fired < 1h before start", [r for r in rows if (r["mins"] or 0) <= 60])
    line("moneyline only", [r for r in rows if r["mtype"] == "moneyline"])
    line("totals only", [r for r in rows if r["mtype"] == "total"])
    lines.append(""); lines.append("LIVE ALERTS (upcoming markets, sharp fills seen):")
    for r in db.execute("SELECT datetime(ts,'unixepoch'), question, side, price, round(usd), round(wallet_roi_t,1), round(streak,2), round(sq_opp_usd), datetime(start,'unixepoch') FROM live_alerts WHERE start > ? ORDER BY ts DESC LIMIT 20", (now,)):
        lines.append(f"  {r}")
    txt = "\n".join(lines)
    os.makedirs(REPORT_DIR, exist_ok=True)
    open(os.path.join(REPORT_DIR, time.strftime("%Y-%m-%d", time.gmtime(now)) + ".txt"), "w").write(txt)
    print(txt)


def daily(db):
    t0 = time.time()
    n_new = update_universe(db); n_crawled = crawl(db)
    fills = load_fills(db)
    snaps = ensure_snapshots(db, fills)
    n_sig = build_signals(db, fills)
    print(f"daily: +{n_new} universe, {n_crawled} crawled, {len(fills)} labelled fills, snapshots made {snaps}, +{n_sig} signals, {time.time()-t0:.0f}s")
    report(db)
    push({"summary": summary(db)})


if __name__ == "__main__":
    db = sqlite3.connect(DB, timeout=60); db.execute("PRAGMA journal_mode=WAL"); db.execute("PRAGMA busy_timeout=60000"); db.executescript(SCHEMA)
    {"daily": daily, "live": live, "report": report}[sys.argv[1]](db)
