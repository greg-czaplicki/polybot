"""Build the exchange research dataset: full trade tape + 1-min prices per settled market.

Sources (public, free, retrospective):
  CLOB   /markets/{condition_id}          tokens, game_start_time, winner
  Data   /trades?market=&limit=1000&offset= every fill (wallet, side, price, size, ts)
  CLOB   /prices-history?market=<token>&startTs&endTs&fidelity=1  1-min mid for token 0

Usage: python3 build_dataset.py markets.jsonl data/exchange.db
Resumable: markets with status='done' are skipped.
"""
import json, sqlite3, sys, time, urllib.request, urllib.error

UA = {"User-Agent": "curl/8.5.0"}
PAUSE = 0.12  # seconds between requests

def get(url, retries=4):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429 or e.code >= 500:
                time.sleep(2 * (i + 1)); continue
            raise
        except Exception:
            time.sleep(2 * (i + 1))
    return None

def main(markets_path, db_path):
    db = sqlite3.connect(db_path)
    db.executescript("""
    CREATE TABLE IF NOT EXISTS markets (
      condition_id TEXT PRIMARY KEY, sport_tag TEXT, market_type TEXT, event_time INTEGER,
      first_seen INTEGER, outcome TEXT, question TEXT, game_start_time TEXT,
      token0 TEXT, token1 TEXT, label0 TEXT, label1 TEXT, winner0 INTEGER,
      status TEXT, trades_n INTEGER, prices_n INTEGER, fetched_at INTEGER, error TEXT);
    CREATE TABLE IF NOT EXISTS trades (
      condition_id TEXT, tx TEXT, wallet TEXT, asset TEXT, outcome_index INTEGER,
      side TEXT, price REAL, size REAL, ts INTEGER,
      PRIMARY KEY (condition_id, tx, wallet, asset, side, price, size, ts));
    CREATE INDEX IF NOT EXISTS trades_cond_ts ON trades(condition_id, ts);
    CREATE TABLE IF NOT EXISTS prices (
      condition_id TEXT, token TEXT, ts INTEGER, p REAL, PRIMARY KEY (condition_id, ts));
    """)
    rows = [json.loads(l) for l in open(markets_path)]
    done = {r[0] for r in db.execute("SELECT condition_id FROM markets WHERE status='done'")}
    todo = [r for r in rows if r["condition_id"] not in done]
    print(f"markets {len(rows)} done {len(done)} todo {len(todo)}", flush=True)
    t0 = time.time()
    for i, m in enumerate(todo):
        cid = m["condition_id"]; et = int(m["event_time"])
        err = None; trades_n = 0; prices_n = 0
        try:
            meta = get(f"https://clob.polymarket.com/markets/{cid}"); time.sleep(PAUSE)
            if not meta or not meta.get("tokens"):
                raise RuntimeError("no_clob_market")
            toks = meta["tokens"]
            t0id, t1id = toks[0]["token_id"], toks[1]["token_id"]
            winner0 = 1 if toks[0].get("winner") else (0 if toks[1].get("winner") else None)
            db.execute("""INSERT OR REPLACE INTO markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (cid, m["sport_tag"], m["market_type"], et, m["first_seen"], m["outcome"],
                 meta.get("question"), meta.get("game_start_time"), t0id, t1id,
                 toks[0].get("outcome"), toks[1].get("outcome"), winner0, "pending", 0, 0, int(time.time()), None))
            # tape
            off = 0
            while True:
                page = get(f"https://data-api.polymarket.com/trades?market={cid}&limit=1000&offset={off}") or []
                time.sleep(PAUSE)
                db.executemany("INSERT OR IGNORE INTO trades VALUES (?,?,?,?,?,?,?,?,?)",
                    [(cid, x.get("transactionHash"), x.get("proxyWallet"), x.get("asset"), x.get("outcomeIndex"),
                      x.get("side"), float(x["price"]), float(x["size"]), int(x["timestamp"])) for x in page])
                trades_n += len(page)
                if len(page) < 1000 or off >= 20000: break
                off += 1000
            # prices for token 0, 48h before start to 6h after
            hist = get(f"https://clob.polymarket.com/prices-history?market={t0id}&startTs={et-172800}&endTs={et+21600}&fidelity=1") or {}
            time.sleep(PAUSE)
            pts = hist.get("history", [])
            db.executemany("INSERT OR IGNORE INTO prices VALUES (?,?,?,?)",
                [(cid, t0id, int(p["t"]), float(p["p"])) for p in pts])
            prices_n = len(pts)
            db.execute("UPDATE markets SET status='done', trades_n=?, prices_n=? WHERE condition_id=?", (trades_n, prices_n, cid))
        except Exception as e:
            err = str(e)[:200]
            db.execute("INSERT OR REPLACE INTO markets (condition_id, sport_tag, market_type, event_time, first_seen, outcome, status, error, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (cid, m["sport_tag"], m["market_type"], et, m["first_seen"], m["outcome"], "error", err, int(time.time())))
        db.commit()
        if (i + 1) % 50 == 0 or err:
            el = time.time() - t0
            print(f"[{i+1}/{len(todo)}] {m['sport_tag']} trades={trades_n} prices={prices_n} err={err} elapsed={el:.0f}s eta={el/(i+1)*(len(todo)-i-1):.0f}s", flush=True)
    print("DONE", flush=True)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
