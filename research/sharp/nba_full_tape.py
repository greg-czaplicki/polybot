"""Fetch the FULL (maker + taker) tape of every backfilled NBA market, fills >= $50 cash, into fills_all.

polysharp's crawl uses the data-api default takerOnly=true, so wallets that only post orders are invisible there.
takerOnly=false returns one row per wallet per fill (maker rows included). The API stops at offset 10000
(11k rows); a $50 floor keeps the largest 2025-26 NBA market at ~7.8k rows, so every tape is complete above $50.
Resumable: markets already in fills_done are skipped.
usage: nohup python3 nba_full_tape.py [db] > data/nba/full_tape.log 2>&1 &
"""
import sqlite3, sys, time, json, urllib.request

DB = sys.argv[1] if len(sys.argv) > 1 else "/root/polysharp/data/nba/nba_2025.db"
MIN_CASH, PAUSE = 50, 0.15
db = sqlite3.connect(DB, timeout=60); db.execute("PRAGMA journal_mode=WAL")
db.executescript("""
CREATE TABLE IF NOT EXISTS fills_all (condition_id TEXT, tx TEXT, wallet TEXT, asset TEXT, side TEXT, price REAL, size REAL, ts INTEGER,
  PRIMARY KEY (condition_id, tx, wallet, asset, side, price, size, ts));
CREATE TABLE IF NOT EXISTS fills_done (condition_id TEXT PRIMARY KEY, rows INTEGER, capped INTEGER, fetched_at INTEGER);
""")

def get(url, retries=5):
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"}), timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:
            time.sleep(2 * (i + 1))
    return None

todo = [r[0] for r in db.execute("SELECT condition_id FROM markets WHERE status='done' AND condition_id NOT IN (SELECT condition_id FROM fills_done) ORDER BY start")]
print(f"{len(todo)} markets to fetch", flush=True)
t0 = time.time()
for i, cid in enumerate(todo):
    rows, off, capped, ok = [], 0, 0, True
    while True:
        page = get(f"https://data-api.polymarket.com/trades?market={cid}&limit=1000&offset={off}&takerOnly=false"
                   f"&filterType=CASH&filterAmount={MIN_CASH}")
        time.sleep(PAUSE)
        if page is None or not isinstance(page, list): ok = False; break
        rows += [(cid, x.get("transactionHash"), x.get("proxyWallet"), x.get("asset"), x.get("side"), float(x["price"]),
                  float(x["size"]), int(x["timestamp"])) for x in page]
        if len(page) < 1000: break
        off += 1000
        if off > 10000: capped = 1; break
    if not ok:
        print(f"FAIL {cid}", flush=True); continue
    db.executemany("INSERT OR IGNORE INTO fills_all VALUES (?,?,?,?,?,?,?,?)", rows)
    db.execute("INSERT OR REPLACE INTO fills_done VALUES (?,?,?,?)", (cid, len(rows), capped, int(time.time())))
    db.commit()
    if i % 200 == 0: print(f"{i}/{len(todo)}  {time.time()-t0:.0f}s", flush=True)
db.execute("CREATE INDEX IF NOT EXISTS fills_all_wallet ON fills_all(wallet)")
db.execute("CREATE INDEX IF NOT EXISTS fills_all_cond ON fills_all(condition_id, ts)")
db.commit()
print("FULL TAPE DONE", flush=True)
