"""Execution replay for sharp-follow signals: one minute after a signal fires, rest a $STAKE bid at the signal's side price
(the sharp's price) on the recorded book; queue-position fill logic from paper_mm; cancel at T-15m. Reports fill rate,
minutes-to-fill, and the price actually obtained. Reads polysharp signals + live_alerts and the polybook events log."""
import json, os, sqlite3, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("QUOTE_USD", "10")
from paper_mm import Sim, load_events, db as bookdb  # reuse the book replay and queue mechanics

STAKE = float(os.environ.get("STAKE", 10)); EXIT_MIN = 15; DELAY_S = 60
SHARP_DB = os.environ.get("SHARP_DB", "/root/polysharp/data/sharp.db")
sdb = sqlite3.connect(SHARP_DB, timeout=60)
since = float(sys.argv[2]) if len(sys.argv) > 2 else time.time() - 86400
now = time.time()
# signals fired inside recorder coverage: settled signals table + live alerts (non-hedge, primary lines) for markets already started
rows = sdb.execute("""SELECT s.condition_id, s.fired_ts, s.side, s.fill_price, s.start, s.sport, s.market_type, 'signal' FROM signals s WHERE s.fired_ts >= ? AND s.start <= ?
                      UNION ALL
                      SELECT a.condition_id, a.ts, a.side, a.price, a.start, NULL, a.market_type, 'alert' FROM live_alerts a
                      WHERE a.ts >= ? AND a.start <= ? AND a.hedge=0 AND a.market_type IN ('moneyline','total','spread')""", (since, now - EXIT_MIN * 60, since, now - EXIT_MIN * 60)).fetchall()
mk = {r[0]: (r[1], r[2], r[3]) for r in bookdb.execute("SELECT condition_id, token0, token1, tick FROM markets")}
out = []
for cid, fired, side, price, start, sport, mtype, kind in rows:
    if cid not in mk: continue
    tok0, tok1, tick = mk[cid]; token = tok0 if side == 0 else tok1
    t_place = (fired + DELAY_S) * 1000; t_end = (start - EXIT_MIN * 60) * 1000
    ev = load_events(token, t_place - 30 * 60 * 1000, t_end)      # 30 min of context so the book is initialised before we place
    if not ev: out.append((cid, kind, sport, mtype, side, price, None, "no_book_data", None, None)); continue
    s = Sim(tick); placed = False; q_ahead0 = None; seen_book = False
    for ms, typ, sd, px, size, payload in ev:
        s.step(ms)
        if typ == "book":
            p = json.loads(payload); s.bids = {float(l["price"]): float(l["size"]) for l in p["bids"]}; s.asks = {float(l["price"]): float(l["size"]) for l in p["asks"]}; seen_book = True
        elif not seen_book: continue
        elif typ == "change":
            d = s.bids if sd == "BUY" else s.asks
            if size <= 0: d.pop(px, None)
            else: d[px] = size
            if s.order and sd == "BUY" and px == s.order["price"]: s.order["q_ahead"] = min(s.order["q_ahead"], size)
        elif typ == "trade":
            s.on_trade(ms, sd, px, size)
        if not placed and ms >= t_place and seen_book:
            # rest at the sharp's price if it is at or below the current best bid (join queue) ; else at best bid (never cross)
            bb = s.best_bid()
            if bb is None: continue
            lvl = round(min(price, bb), 4)
            s.order = {"price": lvl, "shares": STAKE / lvl, "q_ahead": s.bids.get(lvl, 0.0), "placed_ms": ms}; q_ahead0 = s.bids.get(lvl, 0.0) * lvl; placed = True
        if placed and s.inv > 0: break
    if not placed: out.append((cid, kind, sport, mtype, side, price, None, "never_placed", None, None)); continue
    if s.inv > 0:
        f = s.fills[0]; out.append((cid, kind, sport, mtype, side, price, f[1], "filled", (f[0] - t_place) / 60000, q_ahead0))
    else:
        out.append((cid, kind, sport, mtype, side, price, s.order["price"] if s.order else None, "unfilled", (t_end - t_place) / 60000, q_ahead0))
print(f"follow replay: {len(out)} signals since {time.strftime('%m-%d %H:%M', time.gmtime(since))}; $%.0f bid placed %ds after the sharp's fill, cancel T-%dm" % (STAKE, DELAY_S, EXIT_MIN))
filled = [o for o in out if o[7] == "filled"]; unf = [o for o in out if o[7] == "unfilled"]; nb = [o for o in out if o[7] in ("no_book_data", "never_placed")]
print(f"  filled {len(filled)}  unfilled {len(unf)}  no data {len(nb)}")
if filled: print(f"  fill rate {len(filled)/(len(filled)+len(unf))*100:.0f}%  median minutes-to-fill {sorted(o[8] for o in filled)[len(filled)//2]:.0f}  mean price vs sharp's {sum(o[6]-o[5] for o in filled)/len(filled)*100:+.2f}c  median $ ahead at placement {sorted(o[9] for o in filled)[len(filled)//2]:,.0f}")
if unf: print(f"  unfilled: median $ ahead at placement {sorted(o[9] for o in unf if o[9] is not None)[len([o for o in unf if o[9] is not None])//2]:,.0f}")
for o in out[:25]: print("   ", o[7], o[1], o[2], o[3], "side", o[4], "sharp px", round(o[5], 3), "ours", round(o[6], 3) if o[6] else None, "min", round(o[8], 1) if o[8] is not None else None, "ahead $", round(o[9]) if o[9] is not None else None, o[0][:10])
