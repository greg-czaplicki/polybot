"""NBA totals sharp-consensus FADE — live signal job (era v19 pilot). Charter: docs/charters/nba-totals-fade-pilot.md

Same rule as the 2025-26 backtest cell S5_consensus/total (research/sharp/nba_wallets.py), computed live:
- wallet records = pregame positions in settled NBA markets of the backfill DB (fills >= $50, maker + taker),
  stake >= $50, a position counts once its start + 4h is before the trigger;
- NBA sharp (S1) = >= 30 settled positions with record ROI >= +10% at the trigger time;
- trigger = a wallet's first pregame BUY >= $100 on a token, 0-24h before start;
- consensus = the 2nd distinct S1 wallet on a side while no S1 wallet is on the other side;
  consensus on both sides -> voided (no bet).
Pushes every signal for upcoming NBA game totals to the app (/api/bot/nba-fade-signals); the app's lane bets the
OTHER side in the bot's window. Runs every 10 min (nba-fade-live.timer).
usage: python3 nba_fade_live.py [--dry]
"""
import os, sys, time, json, pickle, sqlite3, urllib.request
from collections import defaultdict
import bisect

DB = os.environ.get("NBA_DB", "/root/polysharp/data/nba/nba_2025.db")
BOOK_DB = os.environ.get("BOOK_DB", "/root/polybook/data/polybook.db")
CACHE = os.environ.get("NBA_REC_CACHE", "/root/polysharp/data/nba/records.pkl")
SETTLE_LAG, MIN_STAKE, TRIG_USD, MIN_CASH = 4 * 3600, 50, 100, 50
S1_N, S1_ROI = 30, 0.10
LOOKAHEAD_H = 24
DRY = "--dry" in sys.argv
t0 = time.time()
def log(s): print(f"{s}  [{time.time()-t0:.0f}s]", flush=True)

def get(url, retries=4):
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"}), timeout=30) as r:
                return json.loads(r.read())
        except Exception:
            time.sleep(2 * (i + 1))
    return None

def records():
    """wallet -> (settle_ts list, cum pnl, cum stake); cached until the settled-market count changes."""
    db = sqlite3.connect(DB, timeout=60)
    key = db.execute("SELECT COUNT(*), COALESCE(MAX(fetched_at), 0) FROM fills_done").fetchone()
    try:
        with open(CACHE, "rb") as f:
            c = pickle.load(f)
        if c["key"] == key: return c["rec"]
    except Exception:
        pass
    mk = {cid: (st, w0) for cid, st, w0 in db.execute(
        "SELECT condition_id, start, winner0 FROM markets WHERE status='done' AND winner0 IN (0,1)")}
    pos = defaultdict(lambda: [0.0, 0.0])
    for cid, w, is0, sh, cash, buy in db.execute("""SELECT f.condition_id, f.wallet, f.asset = m.token0,
            SUM(CASE WHEN f.side='BUY' THEN f.size ELSE -f.size END), SUM(CASE WHEN f.side='BUY' THEN f.price*f.size ELSE -f.price*f.size END),
            SUM(CASE WHEN f.side='BUY' THEN f.price*f.size ELSE 0 END)
        FROM fills_all f JOIN markets m ON m.condition_id = f.condition_id WHERE f.ts < m.start GROUP BY 1, 2, 3"""):
        if cid not in mk: continue
        won = mk[cid][1] if is0 else 1 - mk[cid][1]
        p = pos[(cid, w)]; p[0] += sh * won - cash; p[1] += buy
    lists = defaultdict(list)
    for (cid, w), (pnl, stake) in pos.items():
        if stake >= MIN_STAKE: lists[w].append((mk[cid][0] + SETTLE_LAG, pnl, stake))
    rec = {}
    for w, lst in lists.items():
        if len(lst) < S1_N: continue                 # can never qualify
        lst.sort(); ts, cp, cs = [], [0.0], [0.0]
        for s, p, st in lst: ts.append(s); cp.append(cp[-1] + p); cs.append(cs[-1] + st)
        rec[w] = (ts, cp, cs)
    with open(CACHE + ".tmp", "wb") as f: pickle.dump({"key": key, "rec": rec}, f)
    os.replace(CACHE + ".tmp", CACHE)
    return rec

def is_sharp(rec, w, t):
    r = rec.get(w)
    if not r: return False
    n = bisect.bisect_left(r[0], t)
    return n >= S1_N and r[2][n] > 0 and r[1][n] / r[2][n] >= S1_ROI

def market_signal(rec, cid, tok0, start):
    """(consensus token index | None, trigger ts, wallets, voided, s1 wallets per side)"""
    rows = []
    for off in range(0, 11000, 1000):
        page = get(f"https://data-api.polymarket.com/trades?market={cid}&limit=1000&offset={off}&takerOnly=false"
                   f"&filterType=CASH&filterAmount={MIN_CASH}")
        time.sleep(0.15)
        if not isinstance(page, list): return None
        rows += page
        if len(page) < 1000: break
    first = {}
    for x in rows:
        ts = int(x["timestamp"]); usd = float(x["price"]) * float(x["size"])
        if x.get("side") != "BUY" or usd < TRIG_USD or not (start - 86400 <= ts < start): continue
        k = (x.get("proxyWallet"), 0 if x.get("asset") == tok0 else 1)
        if k not in first or ts < first[k]: first[k] = ts
    trig = sorted((ts, w, s) for (w, s), ts in first.items())
    seen = {0: [], 1: []}; cons = {}
    for ts, w, s in trig:
        if not is_sharp(rec, w, ts) or w in seen[s]: continue
        seen[s].append(w)
        if len(seen[s]) == 2 and not seen[1 - s] and s not in cons: cons[s] = (ts, list(seen[s]))
    if not cons: return dict(side=None, s1=[len(seen[0]), len(seen[1])], fills=len(rows))
    if len(cons) == 2: return dict(side=None, voided=True, s1=[len(seen[0]), len(seen[1])], fills=len(rows))
    s, (ts, ws) = next(iter(cons.items()))
    return dict(side=s, ts=ts, wallets=ws, voided=False, s1=[len(seen[0]), len(seen[1])], fills=len(rows))

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
    if not base or not key: print("push skipped: no BOT_BASE_URL/BOT_API_KEY"); return
    req = urllib.request.Request(f"{base}/api/bot/nba-fade-signals", method="POST", data=json.dumps(payload).encode(),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "polysharp/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r: print("push:", json.load(r))
    except Exception as e:  # noqa
        print("push failed:", str(e)[:200])

def main():
    now = int(time.time())
    rec = records(); log(f"records: {len(rec)} wallets with >= {S1_N} positions")
    bdb = sqlite3.connect(BOOK_DB, timeout=60)
    ups = bdb.execute("""SELECT condition_id, question, token0, game_start, label0, label1 FROM markets
                         WHERE sport_hint='nba' AND question LIKE '%: O/U %' AND game_start BETWEEN ? AND ?""",
                      (now, now + LOOKAHEAD_H * 3600)).fetchall()
    signals, stats = [], defaultdict(int)
    for cid, q, tok0, start, l0, l1 in ups:
        sig = market_signal(rec, cid, tok0, start)
        if sig is None: stats["fetch_failed"] += 1; continue
        stats["markets"] += 1
        if sig.get("voided"): stats["voided"] += 1
        if sig["side"] is None and not sig.get("voided"): continue
        labels = (l0, l1)
        cons_label = labels[sig["side"]] if sig["side"] is not None else None
        signals.append(dict(condition_id=cid, question=q, start=start, consensus_label=cons_label,
                            fade_label=(labels[1 - sig["side"]] if sig["side"] is not None else None),
                            trigger_ts=sig.get("ts"), wallets=sig.get("wallets", []), voided=1 if sig.get("voided") else 0,
                            s1_over=sig["s1"][0 if (l0 or "").lower().startswith("o") else 1],
                            s1_under=sig["s1"][1 if (l0 or "").lower().startswith("o") else 0]))
        if not sig.get("voided"): stats["signals"] += 1
    log(f"{len(ups)} upcoming NBA totals; {dict(stats)}")
    for s in signals: print("  ", s["question"], "consensus", s["consensus_label"], "-> fade", s["fade_label"], "voided" if s["voided"] else "")
    summary = dict(updatedAt=now, records=len(rec), upcoming=len(ups), **stats)
    if not DRY: push({"signals": signals, "summary": summary})

if __name__ == "__main__":
    main()
