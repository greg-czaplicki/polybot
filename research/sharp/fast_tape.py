"""Parallel replacement for `crawl()` + `nba_full_tape.py` on a backfill DB, for wallet backtests (2026-10-09).

For every discovered market without a full tape: CLOB meta (winner0, tokens, game start) + the FULL maker+taker tape
(fills >= $50, takerOnly=false) into fills_all / fills_done — exactly what *_wallets.py reads. Skips the taker-only tape
and price history that crawl() fetches (not used by the wallet reads). Network in WORKERS threads, writes on the main
thread. Resumable. Runs on the desktop.
usage: python3 fast_tape.py <db> [workers]
"""
import sqlite3, sys, time, json, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

DB = sys.argv[1]
WORKERS = int(sys.argv[2]) if len(sys.argv) > 2 else 8
MIN_CASH = 50
db = sqlite3.connect(DB, timeout=60); db.execute("PRAGMA journal_mode=WAL")
db.executescript("""
CREATE TABLE IF NOT EXISTS fills_all (condition_id TEXT, tx TEXT, wallet TEXT, asset TEXT, side TEXT, price REAL, size REAL, ts INTEGER,
  PRIMARY KEY (condition_id, tx, wallet, asset, side, price, size, ts));
CREATE TABLE IF NOT EXISTS fills_done (condition_id TEXT PRIMARY KEY, rows INTEGER, capped INTEGER, fetched_at INTEGER);
""")

def get(url, retries=6):
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"}), timeout=30) as r:
                return json.loads(r.read())
        except Exception:
            time.sleep(2 * (i + 1))
    return None

def fetch(cid, st):
    meta = get(f"https://clob.polymarket.com/markets/{cid}")
    if not meta or not meta.get("tokens"): return cid, None
    toks = meta["tokens"]
    winner0 = 1 if toks[0].get("winner") else (0 if toks[1].get("winner") else None)
    gs = meta.get("game_start_time")
    if gs:
        try: st = int(datetime.fromisoformat(gs.replace("Z", "+00:00")).timestamp())
        except ValueError: pass
    rows, off, capped = [], 0, 0
    while True:
        page = get(f"https://data-api.polymarket.com/trades?market={cid}&limit=1000&offset={off}&takerOnly=false"
                   f"&filterType=CASH&filterAmount={MIN_CASH}")
        if page is None or not isinstance(page, list): return cid, None
        rows += [(cid, x.get("transactionHash"), x.get("proxyWallet"), x.get("asset"), x.get("side"), float(x["price"]),
                  float(x["size"]), int(x["timestamp"])) for x in page]
        if len(page) < 1000: break
        off += 1000
        if off > 10000: capped = 1; break
    return cid, (st, toks[0]["token_id"], toks[1]["token_id"], winner0, rows, capped)

todo = db.execute("SELECT condition_id, start FROM markets WHERE condition_id NOT IN (SELECT condition_id FROM fills_done) "
                  "AND start + 4*3600 < ? ORDER BY start", (int(time.time()),)).fetchall()
print(f"{len(todo)} markets to fetch with {WORKERS} workers", flush=True)
t0, n, fail = time.time(), 0, 0
with ThreadPoolExecutor(WORKERS) as ex:
    for fut in as_completed([ex.submit(fetch, cid, st) for cid, st in todo]):
        cid, res = fut.result(); n += 1
        if res is None:
            fail += 1; db.execute("UPDATE markets SET status='error' WHERE condition_id=?", (cid,))
        else:
            st, t0k, t1k, w0, rows, capped = res
            db.execute("UPDATE markets SET start=?, token0=?, token1=?, winner0=?, status=?, fetched_at=? WHERE condition_id=?",
                       (st, t0k, t1k, w0, "done" if w0 is not None else "unresolved", int(time.time()), cid))
            db.executemany("INSERT OR IGNORE INTO fills_all VALUES (?,?,?,?,?,?,?,?)", rows)
            db.execute("INSERT OR REPLACE INTO fills_done VALUES (?,?,?,?)", (cid, len(rows), capped, int(time.time())))
        db.commit()
        if n % 200 == 0: print(f"{n}/{len(todo)}  fail {fail}  {time.time()-t0:.0f}s", flush=True)
db.execute("CREATE INDEX IF NOT EXISTS fills_all_wallet ON fills_all(wallet)")
db.execute("CREATE INDEX IF NOT EXISTS fills_all_cond ON fills_all(condition_id, ts)")
db.commit()
print(f"FAST TAPE DONE  {n} markets, {fail} failed, {time.time()-t0:.0f}s", flush=True)
