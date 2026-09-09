"""Paper market-maker on recorded books. Stdlib only; runs on the VPS.

Policy (per market, both outcomes): rest a bid of QUOTE_USD at the best bid on token0 and on token1
(a bid on token1 is economically an ask on token0). Queue position = visible size at the level when we
join; cancellations can only shrink what is ahead of us (q_ahead = min(q_ahead, new level size));
taker SELL trades at our price consume q_ahead first, then fill us; a SELL below our price means our
level was swept and fills us fully. If the best bid moves above ours by more than one tick we cancel
and rejoin at the back of the new best. Inventory capped per token. At T-EXIT_MIN all inventory is
flattened at the best bid (taker); matched token0/token1 pairs are redeemed at $1 instead.
Reports P&L per $ filled, fill rates, and adverse selection, per sport. Fees assumed 0 (observed on wire).
"""
import json, os, sqlite3, sys, time
from collections import defaultdict

DB = sys.argv[1] if len(sys.argv) > 1 else "/root/polybook/data/polybook.db"
QUOTE_USD = float(os.environ.get("QUOTE_USD", 20))
INV_CAP_USD = float(os.environ.get("INV_CAP_USD", 60))
EXIT_MIN = int(os.environ.get("EXIT_MIN", 15))
START_MIN = int(os.environ.get("START_MIN", 360))   # begin quoting this many minutes before start
REJOIN_TICKS = 1
POLICY = os.environ.get("POLICY", "JOIN")          # JOIN: back of best-bid queue | IMPROVE: bid one tick above best when spread >= 2 ticks | THIN: join only if queue ahead <= MAXQ_USD
MAXQ_USD = float(os.environ.get("MAXQ_USD", 200))
PASSIVE_EXIT = os.environ.get("PASSIVE_EXIT", "1") == "1"      # rest inventory at the ask instead of holding to T-EXIT
PASSIVE_IMPROVE = os.environ.get("PASSIVE_IMPROVE", "1") == "1"  # exit one tick inside the spread when it is >= 2 ticks
SINCE = float(sys.argv[2]) if len(sys.argv) > 2 else 0  # only markets with game_start >= SINCE

db = sqlite3.connect(DB)
now = time.time()
markets = db.execute("SELECT condition_id, question, token0, token1, tick, game_start, sport_hint FROM markets WHERE game_start <= ? AND game_start >= ?", (now, SINCE)).fetchall()


def load_events(asset, t_from_ms, t_to_ms):
    return db.execute("SELECT recv_ms, type, side, price, size, payload FROM events WHERE asset=? AND recv_ms BETWEEN ? AND ? ORDER BY recv_ms, rowid",
                      (asset, t_from_ms, t_to_ms)).fetchall()


class Sim:
    def __init__(self, tick):
        self.tick = tick
        self.bids, self.asks = {}, {}
        self.order = None           # dict(price, shares, q_ahead, placed_ms)
        self.ask = None             # passive exit order: dict(price, shares, q_ahead)
        self.inv = 0.0              # shares held
        self.cost = 0.0             # $ paid
        self.proceeds = 0.0         # $ received from passive exits
        self.exits = 0
        self.fills = []             # (ms, price, shares)
        self.quoting_ms = 0
        self.last_ms = None
        self.joined = 0

    def best_bid(self):
        return max(self.bids) if self.bids else None

    def best_ask(self):
        return min(self.asks) if self.asks else None

    def mid(self):
        b, a = self.best_bid(), self.best_ask()
        return (b + a) / 2 if b is not None and a is not None else None

    def place(self, ms):
        p = self.best_bid()
        if p is None or self.inv * p >= INV_CAP_USD:
            return
        a = self.best_ask()
        if POLICY == "IMPROVE":
            if a is None or a - p < 2 * self.tick - 1e-9:
                return                      # spread too tight to improve; stay out
            p = round(p + self.tick, 4)
            q_ahead = 0.0                   # we create the level: first in queue
        elif POLICY == "THIN":
            q_ahead = self.bids.get(p, 0.0)
            if q_ahead * p > MAXQ_USD:
                return
        else:
            q_ahead = self.bids.get(p, 0.0)
        self.order = {"price": p, "shares": QUOTE_USD / p, "q_ahead": q_ahead, "placed_ms": ms}
        self.joined += 1

    def place_ask(self, ms):
        """Rest the whole inventory at the best ask (back of queue); one tick below if spread >= 2 ticks and PASSIVE_IMPROVE."""
        a = self.best_ask()
        if a is None or self.inv <= 1e-9:
            return
        b = self.best_bid()
        if PASSIVE_IMPROVE and b is not None and a - b >= 2 * self.tick - 1e-9:
            self.ask = {"price": round(a - self.tick, 4), "shares": self.inv, "q_ahead": 0.0}
        else:
            self.ask = {"price": a, "shares": self.inv, "q_ahead": self.asks.get(a, 0.0)}

    def on_change(self, ms, side, price, size):
        d = self.bids if side == "BUY" else self.asks
        if size <= 0:
            d.pop(price, None)
        else:
            d[price] = size
        o = self.order
        if o and side == "BUY":
            if price == o["price"]:
                o["q_ahead"] = min(o["q_ahead"], size)
            bb = self.best_bid()
            if bb is not None and bb > o["price"] + REJOIN_TICKS * self.tick + 1e-9:
                self.order = None  # cancel; rejoin at back of new best
                self.place(ms)
        k = self.ask
        if k and side == "SELL":
            if price == k["price"]:
                k["q_ahead"] = min(k["q_ahead"], size)
            ba = self.best_ask()
            if ba is not None and ba < k["price"] - REJOIN_TICKS * self.tick - 1e-9:
                self.ask = None
                self.place_ask(ms)

    def on_trade(self, ms, side, price, size):
        o = self.order
        if o and side == "SELL":
            if price < o["price"] - 1e-9:      # traded through our level: we were swept
                self.fill(ms, o["price"], o["shares"])
            elif abs(price - o["price"]) < 1e-9:
                take = max(0.0, size - o["q_ahead"])
                o["q_ahead"] = max(0.0, o["q_ahead"] - size)
                if take > 0:
                    self.fill(ms, o["price"], min(take, o["shares"]))
        k = self.ask
        if k and side == "BUY":
            if price > k["price"] + 1e-9:
                self.exit_fill(ms, k["price"], k["shares"])
            elif abs(price - k["price"]) < 1e-9:
                take = max(0.0, size - k["q_ahead"])
                k["q_ahead"] = max(0.0, k["q_ahead"] - size)
                if take > 0:
                    self.exit_fill(ms, k["price"], min(take, k["shares"]))

    def exit_fill(self, ms, price, shares):
        shares = min(shares, self.inv)
        self.inv -= shares
        self.proceeds += shares * price
        self.exits += 1
        self.ask["shares"] -= shares
        if self.ask["shares"] <= 1e-9:
            self.ask = None
        if self.inv > 1e-9 and self.ask is None:
            self.place_ask(ms)

    def fill(self, ms, price, shares):
        self.inv += shares
        self.cost += shares * price
        self.fills.append((ms, price, shares, self.mid()))
        if PASSIVE_EXIT:
            self.ask = None
            self.place_ask(ms)
        o = self.order
        if o:
            o["shares"] -= shares
            if o["shares"] <= 1e-9:
                self.order = None
                self.place(ms)

    def step(self, ms):
        if self.last_ms is not None and self.order:
            self.quoting_ms += ms - self.last_ms
        self.last_ms = ms


def run_market(cid, question, t0, t1, tick, gs, sport):
    start_ms = (gs - START_MIN * 60) * 1000
    end_ms = (gs - EXIT_MIN * 60) * 1000
    sims = {}
    for tok in (t0, t1):
        ev = load_events(tok, start_ms, end_ms)
        if not ev:
            continue
        s = Sim(tick)
        seen_book = False
        for ms, typ, side, price, size, payload in ev:
            s.step(ms)
            if typ == "book":
                p = json.loads(payload)
                s.bids = {float(l["price"]): float(l["size"]) for l in p["bids"]}
                s.asks = {float(l["price"]): float(l["size"]) for l in p["asks"]}
                seen_book = True
                if s.order is None:
                    s.place(ms)
            elif not seen_book:
                continue
            elif typ == "change":
                s.on_change(ms, side, price, size)
                if s.order is None:
                    s.place(ms)
            elif typ == "trade":
                s.on_trade(ms, side, price, size)
        sims[tok] = s
    if len(sims) < 1:
        return None
    s0, s1 = sims.get(t0), sims.get(t1)
    inv0 = s0.inv if s0 else 0; inv1 = s1.inv if s1 else 0
    pairs = min(inv0, inv1)
    cost = (s0.cost if s0 else 0) + (s1.cost if s1 else 0)
    proceeds = (s0.proceeds if s0 else 0) + (s1.proceeds if s1 else 0)
    exits = (s0.exits if s0 else 0) + (s1.exits if s1 else 0)
    # exit: pairs redeem at $1, remainder flattened at best bid (taker, 0 fee); mark version uses mid
    rem0, rem1 = inv0 - pairs, inv1 - pairs
    def exit_val(s, rem, use_mid):
        if not s or rem <= 0: return 0.0
        px = s.mid() if use_mid else s.best_bid()
        return rem * (px if px is not None else 0.0)
    pnl_flat = proceeds + pairs * 1.0 + exit_val(s0, rem0, False) + exit_val(s1, rem1, False) - cost
    pnl_mid = proceeds + pairs * 1.0 + exit_val(s0, rem0, True) + exit_val(s1, rem1, True) - cost
    fills = [(f, tok) for s, tok in ((s0, 0), (s1, 1)) if s for f in s.fills]
    filled_usd = cost
    # adverse selection: mid 5 min after each fill vs fill price (maker's side: bought at price, wants mid >= price)
    adverse = []
    for (ms, price, shares, mid_at), tok in fills:
        s = s0 if tok == 0 else s1
        # approximate mid 5 min later from event stream: replay is done; use fills' own mid at fill and market end mid
        adverse.append((mid_at - price) if mid_at is not None else 0.0)
    quoting_min = sum(s.quoting_ms for s in sims.values()) / 60000 / len(sims)
    return dict(cid=cid, q=question, sport=sport, fills=len(fills), filled_usd=filled_usd, pairs_usd=pairs,
                pnl_flat=pnl_flat, pnl_mid=pnl_mid, quoting_min=quoting_min, joined=sum(s.joined for s in sims.values()),
                spread_at_fill=sum(adverse) / len(adverse) if adverse else None, inv_end_usd=exit_val(s0, rem0, False) + exit_val(s1, rem1, False),
                proceeds=proceeds, exits=exits)


def main():
    res = [r for r in (run_market(*m) for m in markets) if r]
    print(f"paper MM [{POLICY} passive_exit={PASSIVE_EXIT} improve_exit={PASSIVE_IMPROVE}]: {len(res)} markets with pregame data (game_start >= {time.strftime('%Y-%m-%d %H:%M', time.gmtime(SINCE)) if SINCE else 'any'}); quote ${QUOTE_USD:.0f}/side, inv cap ${INV_CAP_USD:.0f}/token, exit T-{EXIT_MIN}m, quoting from T-{START_MIN}m")
    def agg(rows, name):
        if not rows: return
        f = sum(r["filled_usd"] for r in rows); pf = sum(r["pnl_flat"] for r in rows); pm = sum(r["pnl_mid"] for r in rows)
        fills = sum(r["fills"] for r in rows); qm = sum(r["quoting_min"] for r in rows); pairs = sum(r["pairs_usd"] for r in rows)
        inv = sum(r["inv_end_usd"] for r in rows); pe = sum(r["proceeds"] for r in rows); ex = sum(r["exits"] for r in rows)
        print(f"  {name:8s} mkts={len(rows):3d} fills={fills:4d} filled=${f:8.0f} passive-exited=${pe:6.0f}({ex}) pairs=${pairs:5.0f} crossed-at-exit=${inv:6.0f} | P&L flatten ${pf:+7.2f} ({(pf/f*100 if f else 0):+.2f}c/$) mid ${pm:+7.2f} ({(pm/f*100 if f else 0):+.2f}c/$) | fills/quoting-hour {fills/(qm/60) if qm else 0:.1f}  $filled/quoting-hour ${f/(qm/60) if qm else 0:.0f}")
    agg(res, "ALL")
    by = defaultdict(list)
    for r in res: by[r["sport"]].append(r)
    for s, rows in sorted(by.items(), key=lambda kv: -len(kv[1])): agg(rows, s)
    print("\nworst / best markets by flatten P&L:")
    for r in sorted(res, key=lambda r: r["pnl_flat"])[:3] + sorted(res, key=lambda r: -r["pnl_flat"])[:3]:
        print(f"  {r['pnl_flat']:+7.2f}  filled ${r['filled_usd']:6.0f} fills {r['fills']:3d}  {r['sport']:6s} {r['q'][:60]}")


if __name__ == "__main__":
    main()
