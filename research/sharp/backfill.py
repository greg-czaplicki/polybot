"""One-time backfill of settled sports main-line markets (moneyline/totals/spreads, volume >= MIN_VOL) from Gamma, day by day,
then crawl their tapes/prices/winners through polysharp.crawl(). Run unattended:  nohup python3 backfill.py 2026-06-01 2026-07-29 &
Idempotent: markets already present are skipped; crawl resumes from status='pending'."""
import os, sys, time, json, sqlite3, urllib.request
from datetime import date, timedelta
sys.argv = [sys.argv[0], "report"] + sys.argv[1:]
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "polysharp.py")).read().split("if __name__")[0]
exec(src)
MIN_VOL = float(os.environ.get("MIN_VOL", 25000))
start_day = date.fromisoformat(sys.argv[2]); end_day = date.fromisoformat(sys.argv[3])

db = sqlite3.connect(DB, timeout=60); db.execute("PRAGMA journal_mode=WAL"); db.execute("PRAGMA busy_timeout=60000"); db.executescript(SCHEMA); ensure_columns(db)
d = start_day; found = 0
while d <= end_day:
    off = 0; day_n = 0
    while True:
        page = get(f"https://gamma-api.polymarket.com/markets?closed=true&tag_id=1&limit=100&offset={off}&volume_num_min={int(MIN_VOL)}"
                   f"&end_date_min={d}T00:00:00Z&end_date_max={d}T23:59:59Z") or []
        time.sleep(PAUSE)
        for m in page:
            if m.get("sportsMarketType") not in ("moneyline", "totals", "spreads") or m.get("negRisk"): continue
            gs = parse_start(m.get("gameStartTime")) if "parse_start" in globals() else None
            if gs is None:
                try:
                    from datetime import datetime
                    raw = (m.get("gameStartTime") or "").replace(" ", "T")
                    raw = raw + ":00" if raw.endswith("+00") else raw
                    gs = int(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp())
                except Exception:
                    continue
            try:
                toks = json.loads(m["clobTokenIds"])
            except Exception:
                continue
            if len(toks) != 2: continue
            r = db.execute("INSERT OR IGNORE INTO markets (condition_id, sport, market_type, start, question, token0, token1, status, source) VALUES (?,?,?,?,?,?,?,'pending','backfill')",
                           (m["conditionId"], (m.get("slug") or "").split("-")[0], classify(m.get("question")), gs, m.get("question"), toks[0], toks[1]))
            day_n += r.rowcount
        if len(page) < 100 or off >= 2000: break
        off += 100
    db.commit(); found += day_n
    print(f"{d}: +{day_n} markets (total {found})", flush=True)
    d += timedelta(days=1)
print("discovery done; crawling pending…", flush=True)
while True:
    n = crawl(db, limit=200)
    left = db.execute("SELECT COUNT(*) FROM markets WHERE status='pending' AND start + ? < ?", (SETTLE_LAG, int(time.time()))).fetchone()[0]
    print(f"crawled {n}, pending {left}", flush=True)
    if n == 0 or left == 0: break
print("BACKFILL DONE", flush=True)
