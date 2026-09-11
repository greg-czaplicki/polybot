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
CREATE TABLE IF NOT EXISTS event_signals (rule TEXT NOT NULL, event_key TEXT NOT NULL, condition_id TEXT, sport TEXT, market_type TEXT,
  start INTEGER, fired_ts INTEGER, wallet TEXT, side INTEGER, entry_price REAL, usd REAL, win INTEGER, roi_follow REAL, clv REAL,
  PRIMARY KEY (rule, event_key));
CREATE TABLE IF NOT EXISTS watchlist (wallet TEXT PRIMARY KEY, note TEXT, added_at INTEGER);
CREATE TABLE IF NOT EXISTS live_alerts (condition_id TEXT, ts INTEGER, wallet TEXT, tx TEXT, side INTEGER, price REAL, usd REAL,
  wallet_roi_t REAL, streak REAL, sq_opp_usd REAL, question TEXT, start INTEGER, PRIMARY KEY (condition_id, tx, wallet, side, price));
"""


def ensure_columns(db):
    """Additive columns for event grouping; safe to run every start."""
    for table, col, typ in [("markets", "event_key", "TEXT"), ("signals", "event_key", "TEXT"), ("live_alerts", "event_key", "TEXT"),
                            ("live_alerts", "market_type", "TEXT"), ("live_alerts", "fills", "INTEGER"), ("live_alerts", "hedge", "INTEGER")]:
        cols = {r[1] for r in db.execute(f"PRAGMA table_info({table})")}
        if col not in cols:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
    db.execute("CREATE INDEX IF NOT EXISTS markets_event ON markets(event_key)")
    db.execute("CREATE INDEX IF NOT EXISTS signals_event ON signals(event_key)")
    db.commit()


NON_TEAM = {"over", "under", "yes", "no"}


def classify(question):
    q = question or ""
    if q.startswith("Spread:") or q.startswith("Set Handicap:") or "Handicap" in q: return "spread"
    if "Team Total" in q: return "team_total"
    if any(k in q for k in ("1H ", "1st Half", "1st Quarter", "1Q ", "First Half", "first inning", "1st Inning", "1st Set", "First Set", "2H ")): return "period"
    if "O/U" in q or "Over/Under" in q: return "total"
    if " vs" in q and ":" not in q.split(" vs")[0] + q.split(" vs")[-1].split(":")[0] and not q.endswith("?"): return "moneyline"
    if " vs" in q and not q.endswith("?") and q.count(":") <= 1 and q.split(":")[0].strip().split(" ")[0].istitle() and " vs" in q.split(":")[-1]: return "moneyline"  # "Seville: A vs B"
    return "prop"


def team_tokens(question):
    """Surnames / team words that identify the game inside a question."""
    q = question or ""
    if q.startswith("Spread:"):
        name = q[len("Spread:"):].split("(")[0].strip()
        return {name.split()[-1].lower()} if name else set()
    if "Team Total" in q:
        name = q.split("Team Total")[0].strip().rstrip(":").strip()
        return {name.split()[-1].lower()} if name else set()
    seg = None
    for part in q.split(":"):
        if " vs" in part:
            seg = part; break
    if seg is None: return set()
    import re
    names = re.split(r"\s+vs\.?\s+", seg.strip())
    out = set()
    for n in names:
        n = re.sub(r"\(.*?\)", "", n).strip()
        if n and n.lower() not in NON_TEAM:
            out.add(n.split()[-1].lower())
    return out


def assign_event_keys(db, since=0):
    """Union markets of the same (sport, start) that share a team token; key = smallest condition_id in the group."""
    rows = db.execute("SELECT condition_id, sport, start, question FROM markets WHERE start >= ?", (since,)).fetchall()
    groups = defaultdict(list)
    for cid, sport, st, q in rows:
        groups[(sport, st)].append((cid, team_tokens(q)))
    updates = []
    for (sport, st), ms in groups.items():
        parent = {cid: cid for cid, _ in ms}
        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]; x = parent[x]
            return x
        for i in range(len(ms)):
            for j in range(i + 1, len(ms)):
                if ms[i][1] and ms[j][1] and (ms[i][1] & ms[j][1]):
                    parent[find(ms[i][0])] = find(ms[j][0])
        roots = defaultdict(list)
        for cid, _ in ms: roots[find(cid)].append(cid)
        for members in roots.values():
            key = f"{sport}:{st}:{min(members)[:12]}"
            for cid in members: updates.append((key, cid))
    db.executemany("UPDATE markets SET event_key=? WHERE condition_id=? AND (event_key IS NULL OR event_key<>?)", [(k, c, k) for k, c in updates])
    db.commit()
    return len(updates)


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
    rows = db.execute("SELECT condition_id, sport_hint, game_start, question, token0, token1 FROM book.markets").fetchall()
    db.execute("DETACH DATABASE book")
    n = 0
    for cid, sport, gs, q, t0, t1 in rows:
        r = db.execute("INSERT OR IGNORE INTO markets (condition_id, sport, market_type, start, question, token0, token1, status, source) VALUES (?,?,?,?,?,?,?,'pending','polybook')",
                       (cid, sport, classify(q), gs, q, t0, t1))
        n += r.rowcount
    # re-classify seed rows that only had moneyline/total from the old crawl
    db.execute("UPDATE markets SET market_type=NULL WHERE market_type IN ('moneyline','total') AND question IS NOT NULL AND source='seed' AND event_key IS NULL")
    for cid, q in db.execute("SELECT condition_id, question FROM markets WHERE market_type IS NULL AND question IS NOT NULL").fetchall():
        db.execute("UPDATE markets SET market_type=? WHERE condition_id=?", (classify(q), cid))
    db.commit()
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
        out.append(dict(cid=cid, wallet=w, sign=sign, buy=(side == "BUY"), is0=is0, p0=p0, side_price=side_price, usd=price * size, ts=ts, sport=sport, mtype=mtype, start=st,
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


def tiers_asof(db, ts, include_watchlist=False):
    row = db.execute("SELECT MAX(asof) FROM wallet_scores WHERE asof <= ?", (ts,)).fetchone()
    if not row or row[0] is None: return None, {}, {}
    asof = row[0]
    sharp = {}; square = set()
    for w, t, tier, l20, med in db.execute("SELECT wallet, roi_t, tier, last20_roi, median_usd FROM wallet_scores WHERE asof=? AND tier IN ('sharp','square')", (asof,)):
        if tier == "sharp": sharp[w] = (t, l20, med)
        else: square.add(w)
    if include_watchlist:   # hand-picked wallets always alert on the live tape; never part of the scored signals
        for (w,) in db.execute("SELECT wallet FROM watchlist"):
            if w not in sharp: sharp[w] = (0.0, 0.0, None)
    return asof, sharp, square


# ---------------------------------------------------------------- signals
def asset_dir(is0, qinfo):
    """Direction of the ASSET traded (token0 or token1): ('team', token) / ('ou', over|under) / None."""
    mtype, q, labels = qinfo
    if not labels: return None
    lab = labels[0] if is0 else labels[1]
    if not lab: return None
    if mtype in ("total", "team_total", "period") and lab.lower() in ("over", "under"): return ("ou", lab.lower())
    if mtype in ("moneyline", "spread") and lab.lower() not in NON_TEAM: return ("team", lab.split()[-1].lower())
    return None


def net_hedgers(entries, qinfo_of):
    """entries: iterable of (wallet, cid, is0, buy, usd). Returns set of wallets NET LONG opposing directions."""
    net = defaultdict(lambda: defaultdict(float))
    for w, cid, is0, buy, usd in entries:
        d = asset_dir(is0, qinfo_of(cid))
        if d is None: continue
        net[w][d] += usd if buy else -usd
    out = set()
    for w, dd in net.items():
        longs = {d for d, v in dd.items() if v > 0}
        if len({t for k, t in longs if k == "team"}) > 1 or len({t for k, t in longs if k == "ou"}) > 1: out.add(w)
    return out


def direction(f, qinfo):
    """Event-level direction of a fill: ('team', token) for ML/spread, ('ou', over|under) for totals, else None."""
    mtype, q, labels = qinfo
    lab = (labels[0] if f["sign"] > 0 else labels[1]) if labels else None
    if mtype in ("total", "team_total", "period") and lab and lab.lower() in ("over", "under"):
        return ("ou", lab.lower())
    if mtype in ("moneyline", "spread") and lab and lab.lower() not in NON_TEAM:
        return ("team", lab.split()[-1].lower())
    return None


def build_signals(db, fills):
    _w0 = {r[0]: r[1] for r in db.execute("SELECT condition_id, winner0 FROM markets WHERE winner0 IS NOT NULL")}
    _close = {}
    for cid, ts, p in db.execute("SELECT p.condition_id, p.ts, p.p FROM prices p JOIN markets m ON m.condition_id=p.condition_id WHERE p.ts BETWEEN m.start-120 AND m.start ORDER BY p.ts"):
        _close[cid] = p
    def w0_of(cid): return _w0.get(cid)
    def close_of(cid): return _close.get(cid)
    """One row per EVENT: first sharp fill >= MIN_FILL_USD on a main line (moneyline or the event's biggest total),
    from a wallet that is not hedging inside the event (both teams, or over AND under). Features from the tape up to that fill."""
    ev_of = {}; qinfo = {}
    labels = {}
    if os.path.exists(BOOK_DB):
        db.execute("ATTACH DATABASE ? AS book", (BOOK_DB,))
        for cid, l0, l1 in db.execute("SELECT condition_id, label0, label1 FROM book.markets"): labels[cid] = (l0, l1)
        db.execute("DETACH DATABASE book")
    for cid, ek, mt, q in db.execute("SELECT condition_id, event_key, market_type, question FROM markets"):
        ev_of[cid] = ek or cid; qinfo[cid] = (mt, q, labels.get(cid))
    by_ev = defaultdict(list)
    for f in fills: by_ev[ev_of.get(f["cid"], f["cid"])].append(f)
    have = {r[0] for r in db.execute("SELECT event_key FROM signals WHERE event_key IS NOT NULL")} | {r[0] for r in db.execute("SELECT condition_id FROM signals")}
    made = 0; cache = {}
    for ek, fs in by_ev.items():
        if ek in have: continue
        # primary lines: the moneyline, the spread priced nearest 50/50, the total priced nearest 50/50 (others are alternates)
        mean_p0 = defaultdict(lambda: [0.0, 0.0])
        for f in fs:
            mean_p0[f["cid"]][0] += f["p0"] * f["usd"]; mean_p0[f["cid"]][1] += f["usd"]
        def primary(kind):
            cands = [c for c in mean_p0 if qinfo.get(c, (None,))[0] == kind and mean_p0[c][1] > 0]
            return min(cands, key=lambda c: abs(mean_p0[c][0] / mean_p0[c][1] - 0.5)) if cands else None
        main_total = primary("total"); main_spread = primary("spread")
        main = {f["cid"] for f in fs if qinfo.get(f["cid"], (None,))[0] == "moneyline"} | {c for c in (main_total,) if c}
        main_all = main | {c for c in (main_spread,) if c}
        if not main_all: continue
        hedgers = net_hedgers(((f["wallet"], f["cid"], f["is0"], f["buy"], f["usd"]) for f in fs), lambda c: qinfo.get(c, (None, None, None)))
        def hedger(w): return w in hedgers
        sq_net = defaultdict(float); all_net = defaultdict(float); sig = None
        for f in fs:
            asof, sharp, square = cache.get(monday(f["ts"])) or cache.setdefault(monday(f["ts"]), tiers_asof(db, f["ts"]))
            if asof is None: break
            if f["cid"] in main and f["wallet"] in sharp and f["usd"] >= MIN_FILL_USD and not hedger(f["wallet"]):
                t, l20, med = sharp[f["wallet"]]; cid = f["cid"]
                sig = (cid, asof, f["sport"], qinfo[cid][0], f["start"], f["ts"], f["wallet"], 0 if f["sign"] > 0 else 1, f["side_price"], f["side_price"] + ENTRY_COST,
                       f["usd"], t, l20, (f["usd"] / med) if med else None, -f["sign"] * sq_net[cid], f["sign"] * all_net[cid], (f["start"] - f["ts"]) / 60,
                       1, int(f["win"]), f["roi_follow"], f["clv"], ek)
                break
            if f["wallet"] in square: sq_net[f["cid"]] += f["sign"] * f["usd"]
            all_net[f["cid"]] += f["sign"] * f["usd"]
        if sig:
            db.execute("INSERT OR IGNORE INTO signals (condition_id, asof, sport, market_type, start, fired_ts, wallet, side, fill_price, entry_price, usd, wallet_roi_t, streak, size_ratio, sq_opp_usd, crowd_same_usd, mins_to_start, settled, win, roi_follow, clv, event_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", sig); made += 1
        # ---- rule variants on primary lines (ML + primary spread + primary total), same wallets, same hedger exclusion
        elig = [f for f in fs if f["cid"] in main_all and f["usd"] >= MIN_FILL_USD and not hedger(f["wallet"])]
        def is_sharp(f):
            asof, sharp, _ = cache.get(monday(f["ts"])) or cache.setdefault(monday(f["ts"]), tiers_asof(db, f["ts"]))
            return asof is not None and f["wallet"] in sharp
        elig = [f for f in elig if is_sharp(f)]
        if elig:
            st = fs[0]["start"]
            # A: first sharp fill on any primary line, entered at its price
            f = elig[0]
            db.execute("INSERT OR IGNORE INTO event_signals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       ("A_first_primary", ek, f["cid"], f["sport"], qinfo[f["cid"]][0], st, f["ts"], f["wallet"], 0 if f["sign"] > 0 else 1,
                        f["side_price"] + ENTRY_COST, f["usd"], int(f["win"]), f["roi_follow"], f["clv"]))
            # B: by T-60m, the (market, side) with the most sharp $ ; entered at the T-60m price of that side
            pre = [f for f in elig if f["ts"] <= st - 3600]
            if pre:
                tot = defaultdict(float)
                for f in pre: tot[(f["cid"], f["sign"])] += f["usd"]
                (cid, sign), usd = max(tot.items(), key=lambda kv: kv[1])
                row = db.execute("SELECT p FROM prices WHERE condition_id=? AND ts<=? ORDER BY ts DESC LIMIT 1", (cid, st - 3600)).fetchone()
                if row:
                    p0 = row[0]; side_price = p0 if sign > 0 else 1 - p0
                    if 0.05 < side_price < 0.95:
                        win0 = w0_of(cid); win = (win0 == 1) if sign > 0 else (win0 == 0)
                        c = close_of(cid); clv = (sign * (c - p0)) if c is not None else None
                        db.execute("INSERT OR IGNORE INTO event_signals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                   ("B_max_money_T60", ek, cid, pre[0]["sport"], qinfo[cid][0], st, st - 3600, None, 0 if sign > 0 else 1,
                                    side_price + ENTRY_COST, usd, int(win), (1 / (side_price + ENTRY_COST) - 1) if win else -1.0, clv))
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
                                b.sport_hint, CASE a.side WHEN 0 THEN b.label0 ELSE b.label1 END, s.n, s.roi_mean, a.event_key, a.market_type, a.fills, a.hedge
                         FROM live_alerts a LEFT JOIN book.markets b ON b.condition_id=a.condition_id
                         LEFT JOIN wallet_scores s ON s.wallet=a.wallet AND s.asof=(SELECT MAX(asof) FROM wallet_scores)
                         WHERE a.ts >= ? ORDER BY a.ts""", (since_ts,)).fetchall()
    if not rows: return
    alerts = [dict(condition_id=r[0], tx=r[1], question=r[2], side=r[3], price=r[4], usd=r[5], wallet_roi_t=r[6], streak=r[7], sq_opp_usd=r[8],
                   start=r[9], ts=r[10], wallet=r[11], sport=r[12], side_label=r[13], wallet_markets=r[14], wallet_roi=r[15],
                   event_key=r[16], market_type=r[17], fills=r[18], hedge=r[19]) for r in rows]
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
    asof, sharp, square = tiers_asof(db, now, include_watchlist=True)
    if not sharp: print("no wallet snapshot yet"); return
    if not os.path.exists(BOOK_DB): print("no polybook db"); return
    bdb = sqlite3.connect(BOOK_DB)
    up = bdb.execute("SELECT condition_id, question, token0, game_start FROM markets WHERE game_start BETWEEN ? AND ?", (now + PRE_SEC, now + LIVE_HOURS * 3600)).fetchall()
    up_full = bdb.execute("SELECT condition_id, question, token0, game_start, label0, label1, sport_hint FROM markets WHERE game_start BETWEEN ? AND ?", (now + PRE_SEC, now + LIVE_HOURS * 3600)).fetchall()
    labels = {r[0]: (r[4], r[5]) for r in up_full}
    # make sure these markets exist in our universe with event keys (carry polybook's sport so the report can group them)
    for cid, q, tok0, gs, l0, l1, sport in up_full:
        db.execute("INSERT OR IGNORE INTO markets (condition_id, sport, market_type, start, question, token0, status, source) VALUES (?,?,?,?,?,?,'pending','polybook')",
                   (cid, sport, classify(q), gs, q, tok0))
        db.execute("UPDATE markets SET sport=? WHERE condition_id=? AND sport IS NULL", (sport, cid))
    assign_event_keys(db, now - 86400)
    ev_of = {r[0]: r[1] for r in db.execute("SELECT condition_id, event_key FROM markets WHERE start >= ?", (now - 86400,))}
    mtype = {r[0]: r[1] for r in db.execute("SELECT condition_id, market_type FROM markets WHERE start >= ?", (now - 86400,))}
    new = 0
    agg = {}   # (cid, wallet, side) -> dict
    raw_fills = []   # (cid, wallet, is0, buy, usd) for every sharp-wallet trade, buys and sells
    for cid, q, tok0, gs, l0, l1 in up_full:
        page = []
        for off in range(0, 5000, 1000):            # busy games (NFL ML ~1,100 pregame fills) need paging; most markets stop at one page
            chunk = get(f"https://data-api.polymarket.com/trades?market={cid}&limit=1000&offset={off}") or []; time.sleep(PAUSE)
            page += chunk
            if len(chunk) < 1000: break
        sq_net = 0.0
        for x in sorted(page, key=lambda x: x["timestamp"]):
            w = x.get("proxyWallet"); is0 = x.get("asset") == tok0; sign = 1 if ((x.get("side") == "BUY") == is0) else -1
            usd = float(x["price"]) * float(x["size"]); ts = int(x["timestamp"])
            if w in square: sq_net += sign * usd
            if w in sharp and ts < gs - PRE_SEC:
                raw_fills.append((cid, w, is0, x.get("side") == "BUY", usd))
                k = (cid, w, 0 if sign > 0 else 1)
                a = agg.get(k)
                if a is None:
                    agg[k] = dict(cid=cid, q=q, w=w, side=k[2], usd=usd, pxusd=float(x["price"]) * usd, n=1, ts=ts, tx=x.get("transactionHash"),
                                  sq=-sign * sq_net, gs=gs, t=sharp[w][0], l20=sharp[w][1], sign=sign)
                else:
                    a["usd"] += usd; a["pxusd"] += float(x["price"]) * usd; a["n"] += 1; a["ts"] = max(a["ts"], ts)
    # hedge flag: wallet NET LONG opposing directions within the event (exits are not hedges)
    by_event = defaultdict(list)
    for (cid, w, is0, buy, usd) in raw_fills:
        by_event[ev_of.get(cid, cid)].append((w, cid, is0, buy, usd))
    hedgers = {}
    for ek, entries in by_event.items():
        for w in net_hedgers(entries, lambda c: (mtype.get(c), None, labels.get(c))): hedgers[(ek, w)] = True
    for a in agg.values():
        if a["usd"] < MIN_FILL_USD: continue
        hedge = int(hedgers.get((ev_of.get(a["cid"], a["cid"]), a["w"]), False))
        r = db.execute("""INSERT INTO live_alerts (condition_id, ts, wallet, tx, side, price, usd, wallet_roi_t, streak, sq_opp_usd, question, start, event_key, market_type, fills, hedge)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                          ON CONFLICT(condition_id, tx, wallet, side, price) DO UPDATE SET usd=excluded.usd, fills=excluded.fills, ts=excluded.ts, hedge=excluded.hedge, sq_opp_usd=excluded.sq_opp_usd""",
                       (a["cid"], a["ts"], a["w"], f"agg:{a['cid'][:10]}:{a['w'][:10]}:{a['side']}", a["side"], a["pxusd"] / a["usd"], a["usd"], a["t"], a["l20"], a["sq"], a["q"], a["gs"],
                        ev_of.get(a["cid"], a["cid"]), mtype.get(a["cid"]), a["n"], hedge))
        new += r.rowcount
    db.commit()
    print(f"live: {len(up)} upcoming markets polled, {new} new sharp alerts")
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
        name = name or "unlabelled"
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
    lines.append(""); lines.append("RULE VARIANTS on primary lines (ML + primary spread + primary total), one bet per event:")
    for rule in ["A_first_primary", "B_max_money_T60"]:
        rs = [dict(cid=r[0], sport=r[1], start=r[2], win=r[3], roi=r[4], clv=r[5], mtype=r[6]) for r in
              db.execute("SELECT event_key, sport, start, win, roi_follow, clv, market_type FROM event_signals WHERE rule=? AND win IS NOT NULL", (rule,))]
        line(rule, rs)
        for s_ in ["mlb", "nfl", "atp", "epl"]:
            rs2 = [r for r in rs if r["sport"] == s_]
            if len(rs2) >= 20: line(f"  {rule[:1]} {s_}", rs2)
        for mt in ["moneyline", "spread", "total"]:
            rs3 = [r for r in rs if r["mtype"] == mt]
            if len(rs3) >= 20: line(f"  {rule[:1]} {mt}", rs3)
    try:
        import cell_lanes
        lines += cell_lanes.report_lines(db, now)
    except Exception as e:
        lines.append(f"\nFORWARD CELL LANES: error {e!r}")
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
    n_ev = assign_event_keys(db)
    db.execute("DELETE FROM event_signals"); db.execute("DELETE FROM signals"); db.commit()   # cheap to rebuild; keeps rules consistent
    fills = load_fills(db)
    snaps = ensure_snapshots(db, fills)
    n_sig = build_signals(db, fills)
    print(f"daily: +{n_new} universe, {n_crawled} crawled, {n_ev} event keys, {len(fills)} labelled fills, snapshots made {snaps}, +{n_sig} signals, {time.time()-t0:.0f}s")
    report(db)
    push({"summary": summary(db)})


if __name__ == "__main__":
    db = sqlite3.connect(DB, timeout=60); db.execute("PRAGMA journal_mode=WAL"); db.execute("PRAGMA busy_timeout=60000"); db.executescript(SCHEMA); ensure_columns(db)
    {"daily": daily, "live": live, "report": report}[sys.argv[1]](db)
