"""Mechanics test for the paper market-maker: synthetic book, queue consumption, sweep, rejoin, pairs."""
import json, os, sqlite3, subprocess, sys, time, tempfile
gs = int(time.time()) - 60  # market "started" a minute ago
t_start = (gs - 360 * 60) * 1000
d = tempfile.mkdtemp(); path = os.path.join(d, "t.db")
db = sqlite3.connect(path)
db.executescript(open(os.path.join(os.path.dirname(__file__), "bookrec.py")).read().split('SCHEMA = """')[1].split('"""')[0])
db.execute("INSERT INTO markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ("c1", "s", "Q", "A", "B", "a", "b", 0.01, 5, gs, "mlb", 0, 0, 0, 0))
ev = []
ms = t_start + 1000
book = json.dumps({"bids": [{"price": "0.40", "size": "100"}, {"price": "0.39", "size": "500"}], "asks": [{"price": "0.42", "size": "100"}], "n_bids": 2, "n_asks": 1})
ev.append((ms, ms, "A", "book", None, None, None, book))                 # we join bid 0.40 behind 100 shares (our size = 20/0.40 = 50)
ev.append((ms + 1000, ms + 1000, "A", "trade", "SELL", 0.40, 80, None))   # consumes 80 ahead -> q_ahead 20, no fill
ev.append((ms + 2000, ms + 2000, "A", "change", "BUY", 0.40, 20, None))   # level now 20 (consistent)
ev.append((ms + 3000, ms + 3000, "A", "trade", "SELL", 0.40, 50, None))   # 20 ahead consumed, we fill 30
ev.append((ms + 4000, ms + 4000, "A", "trade", "SELL", 0.39, 10, None))   # traded through -> remaining 20 filled (sweep)
# token B: join at 0.58, better bid appears -> rejoin; then sweep fills us fully
bookB = json.dumps({"bids": [{"price": "0.58", "size": "1000"}], "asks": [{"price": "0.60", "size": "100"}], "n_bids": 1, "n_asks": 1})
ev.append((ms, ms, "B", "book", None, None, None, bookB))
ev.append((ms + 1000, ms + 1000, "B", "change", "BUY", 0.60, 50, None))    # new best bid 0.60 (2 ticks better) -> we rejoin at 0.60 behind 50
ev.append((ms + 2000, ms + 2000, "B", "trade", "SELL", 0.59, 10, None))    # traded through 0.60 -> filled 20/0.60 = 33.3 shares
db.executemany("INSERT INTO events VALUES (?,?,?,?,?,?,?,?)", ev); db.commit(); db.close()
out = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "paper_mm.py"), path], capture_output=True, text=True).stdout
print(out)
# expectations: A filled 50 shares @0.40 = $20; B filled 33.33 @0.60 = $20; pairs = 33.33 -> $33.33 redemption; remainder A 16.67 shares flattened at best bid 0.40 -> $6.67
# cost 40; value 33.33 + 6.67 = 40 -> pnl_flat = 0.00 ; pnl_mid: A remainder at mid 0.41 -> +0.17
assert "mkts=  1" in out and "fills=   3" in out, out
assert "filled=$      40" in out, out
assert "pairs=$    33" in out, out
print("MECHANICS OK")
