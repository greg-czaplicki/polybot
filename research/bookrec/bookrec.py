"""polybook — record live CLOB order books for PREGAME sports markets.

Raw event log (book snapshots, price_change deltas, last_trade_price) plus a
per-minute top-of-book summary, so a paper market-maker can be simulated with
real queue position later. Discovery: Gamma markets with a gameStartTime in the
next 24h, order book enabled, not negRisk; dropped 10 min after start.

Runs on the VPS under polyarb's venv (websockets, httpx). Dry, read-only:
never places orders, never touches polywhaler-bot or polyarb state.
"""
import asyncio, json, logging, os, sqlite3, time
from datetime import datetime, timezone
import httpx, websockets

log = logging.getLogger("polybook")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

DB_PATH = os.environ.get("BOOK_DB", "/root/polybook/data/polybook.db")
GAMMA = "https://gamma-api.polymarket.com"
WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
ASSETS_PER_CONN = int(os.environ.get("ASSETS_PER_CONN", 40))
MAX_MARKETS = int(os.environ.get("MAX_MARKETS", 300))
DISCOVERY_S = int(os.environ.get("DISCOVERY_S", 300))
LOOKAHEAD_S = int(os.environ.get("LOOKAHEAD_S", 24 * 3600))
KEEP_AFTER_START_S = int(os.environ.get("KEEP_AFTER_START_S", 600))
SNAPSHOT_LEVELS = 10
KEEP_LEVELS = int(os.environ.get("KEEP_LEVELS", 5))  # persist level changes only this close to the top of book
DISCOVERY_DEPTH = int(os.environ.get("DISCOVERY_DEPTH", 2100))  # Gamma 422s at offset >= 2100

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS markets (
  condition_id TEXT PRIMARY KEY, slug TEXT, question TEXT, token0 TEXT, token1 TEXT,
  label0 TEXT, label1 TEXT, tick REAL, min_size REAL, game_start INTEGER, sport_hint TEXT,
  liquidity REAL, volume24h REAL, first_seen INTEGER, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS events (
  recv_ms INTEGER NOT NULL, exch_ms INTEGER, asset TEXT NOT NULL, type TEXT NOT NULL,
  side TEXT, price REAL, size REAL, payload TEXT);
CREATE INDEX IF NOT EXISTS events_asset_t ON events(asset, recv_ms);
CREATE TABLE IF NOT EXISTS tob_minute (
  asset TEXT NOT NULL, minute INTEGER NOT NULL, best_bid REAL, best_ask REAL,
  bid_size REAL, ask_size REAL, bid_depth5 REAL, ask_depth5 REAL, n_events INTEGER,
  PRIMARY KEY (asset, minute));
CREATE TABLE IF NOT EXISTS health (t INTEGER PRIMARY KEY, markets INTEGER, assets INTEGER,
  conns INTEGER, events_1m INTEGER, trades_1m INTEGER, ws_rtt_ms REAL);
"""


def parse_start(raw):
    if not raw:
        return None
    try:
        raw = raw.replace(" ", "T")
        if raw.endswith("+00"):
            raw += ":00"
        return int(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


class Store:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)
        self.buf = []
        self.events_1m = 0
        self.trades_1m = 0
        self.dropped = 0

    def event(self, recv_ms, exch_ms, asset, typ, side=None, price=None, size=None, payload=None):
        self.buf.append((recv_ms, exch_ms, asset, typ, side, price, size, payload))
        self.events_1m += 1
        if typ == "trade":
            self.trades_1m += 1
        if len(self.buf) >= 2000:
            self.flush()

    def flush(self):
        if self.buf:
            self.db.executemany("INSERT INTO events VALUES (?,?,?,?,?,?,?,?)", self.buf)
            self.buf = []
            self.db.commit()

    def market(self, m, now):
        self.db.execute("""INSERT INTO markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(condition_id) DO UPDATE SET last_seen=excluded.last_seen,
            liquidity=excluded.liquidity, volume24h=excluded.volume24h""",
            (m["condition_id"], m["slug"], m["question"], m["token0"], m["token1"], m["label0"], m["label1"],
             m["tick"], m["min_size"], m["game_start"], m["sport_hint"], m["liquidity"], m["volume24h"], now, now))

    def tob(self, rows):
        self.db.executemany("INSERT OR REPLACE INTO tob_minute VALUES (?,?,?,?,?,?,?,?,?)", rows)
        self.db.commit()

    def health(self, *row):
        self.db.execute("INSERT OR REPLACE INTO health VALUES (?,?,?,?,?,?,?)", row)
        self.db.commit()


class Books:
    """In-memory L2 per asset: {asset: {"bids": {price: size}, "asks": {...}, "n": events since last summary}}"""
    def __init__(self):
        self.b = {}

    def snapshot(self, asset, bids, asks):
        self.b[asset] = {
            "bids": {float(l["price"]): float(l["size"]) for l in bids if float(l["size"]) > 0},
            "asks": {float(l["price"]): float(l["size"]) for l in asks if float(l["size"]) > 0},
            "n": 1,
        }

    def change(self, asset, side, price, size):
        """Apply a level change; return True if the level is within KEEP_LEVELS of the top of its side (worth persisting)."""
        bk = self.b.get(asset)
        if bk is None:
            return False
        d = bk["bids"] if side == "BUY" else bk["asks"]
        if size <= 0:
            d.pop(price, None)
        else:
            d[price] = size
        bk["n"] += 1
        if not d:
            return True
        if side == "BUY":
            rank = sum(1 for p in d if p > price)
        else:
            rank = sum(1 for p in d if p < price)
        return rank < KEEP_LEVELS

    def summary_rows(self, minute):
        rows = []
        for asset, bk in self.b.items():
            bids, asks = bk["bids"], bk["asks"]
            if not bids and not asks:
                continue
            bb = max(bids) if bids else None
            ba = min(asks) if asks else None
            top_b = sorted(bids, reverse=True)[:5]
            top_a = sorted(asks)[:5]
            rows.append((asset, minute, bb, ba, bids.get(bb) if bb else None, asks.get(ba) if ba else None,
                         sum(bids[p] * p for p in top_b), sum(asks[p] * p for p in top_a), bk["n"]))
            bk["n"] = 0
        return rows


class Recorder:
    def __init__(self, store: Store):
        self.store = store
        self.books = Books()
        self.tasks = []
        self.gen = 0
        self.assets = []
        self.rtt = None

    async def set_tokens(self, tokens):
        if tokens == self.assets:
            return
        self.assets = tokens
        self.gen += 1
        for t in self.tasks:
            t.cancel()
        self.tasks = [asyncio.create_task(self._conn(tokens[i:i + ASSETS_PER_CONN], self.gen))
                      for i in range(0, len(tokens), ASSETS_PER_CONN)]
        log.info("ws pool: %d connections for %d assets", len(self.tasks), len(tokens))

    async def _conn(self, assets, gen):
        backoff = 1
        while gen == self.gen:
            try:
                async with websockets.connect(WS_URL, ping_interval=10, ping_timeout=20, max_size=2**23) as ws:
                    await ws.send(json.dumps({"assets_ids": assets, "type": "market"}))
                    backoff = 1
                    pinger = asyncio.create_task(self._ping(ws))
                    try:
                        async for raw in ws:
                            self._handle(raw)
                    finally:
                        pinger.cancel()
            except asyncio.CancelledError:
                return
            except Exception as e:  # noqa
                log.warning("ws error %s; reconnect in %ds", e, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)

    async def _ping(self, ws):
        try:
            while True:
                await asyncio.sleep(10)
                await ws.send("PING")
                t0 = time.time()
                await asyncio.wait_for(await ws.ping(), timeout=10)
                self.rtt = (time.time() - t0) * 1000
        except Exception:  # noqa
            return

    def _handle(self, raw):
        if raw in ("PONG", "PING"):
            return
        recv_ms = int(time.time() * 1000)
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return
        for e in (data if isinstance(data, list) else [data]):
            if not isinstance(e, dict):
                continue
            et = e.get("event_type")
            exch_ms = int(float(e.get("timestamp") or recv_ms))
            asset = e.get("asset_id")
            if et == "book":
                bids, asks = e.get("bids", []), e.get("asks", [])
                self.books.snapshot(asset, bids, asks)
                # store top N each side (bids listed low→high on the wire; take the highest)
                payload = json.dumps({"bids": sorted(bids, key=lambda l: -float(l["price"]))[:SNAPSHOT_LEVELS],
                                      "asks": sorted(asks, key=lambda l: float(l["price"]))[:SNAPSHOT_LEVELS],
                                      "n_bids": len(bids), "n_asks": len(asks)})
                self.store.event(recv_ms, exch_ms, asset, "book", payload=payload)
            elif et == "price_change":
                for ch in e.get("price_changes", e.get("changes", [])):
                    a = ch.get("asset_id", asset)
                    side, price, size = ch["side"], float(ch["price"]), float(ch["size"])
                    if self.books.change(a, side, price, size):
                        self.store.event(recv_ms, exch_ms, a, "change", side, price, size)
                    else:
                        self.store.dropped += 1
            elif et == "last_trade_price":
                self.store.event(recv_ms, exch_ms, asset, "trade", e.get("side"),
                                 float(e.get("price") or 0), float(e.get("size") or 0),
                                 json.dumps({"fee_rate_bps": e.get("fee_rate_bps")}))
            elif et == "tick_size_change":
                self.store.event(recv_ms, exch_ms, asset, "tick", payload=json.dumps(e))


async def discover(client: httpx.AsyncClient, store: Store):
    now = int(time.time())
    found = {}
    # Gamma caps pages at 100 regardless of limit; liquid game markets all sit within the top few thousand by 24h volume.
    for offset in range(0, DISCOVERY_DEPTH, 100):
        try:
            r = await client.get(f"{GAMMA}/markets", params={"active": "true", "closed": "false",
                                 "order": "volume24hr", "ascending": "false", "limit": 100, "offset": offset}, timeout=30)
            r.raise_for_status()
        except Exception as e:  # noqa
            log.warning("gamma page %d failed: %s", offset, e)
            break
        page = r.json()
        for m in page:
            gs = parse_start(m.get("gameStartTime"))
            if gs is None or m.get("negRisk") or not m.get("enableOrderBook") or not m.get("acceptingOrders"):
                continue
            if not (now - KEEP_AFTER_START_S <= gs <= now + LOOKAHEAD_S):
                continue
            try:
                toks = json.loads(m["clobTokenIds"]); labels = json.loads(m.get("outcomes") or "[]")
            except Exception:  # noqa
                continue
            if len(toks) != 2:
                continue
            found[m["conditionId"]] = {
                "condition_id": m["conditionId"], "slug": m.get("slug", ""), "question": m.get("question", ""),
                "token0": toks[0], "token1": toks[1], "label0": labels[0] if len(labels) > 1 else None,
                "label1": labels[1] if len(labels) > 1 else None,
                "tick": float(m.get("orderPriceMinTickSize") or 0.01), "min_size": float(m.get("orderMinSize") or 5),
                "game_start": gs, "sport_hint": (m.get("slug") or "").split("-")[0],
                "liquidity": float(m.get("liquidityNum") or 0), "volume24h": float(m.get("volume24hr") or 0),
            }
        if len(page) < 100:
            break
        await asyncio.sleep(0.2)
    chosen = sorted(found.values(), key=lambda m: -m["liquidity"])[:MAX_MARKETS]
    for m in chosen:
        store.market(m, now)
    store.db.commit()
    return chosen


async def main():
    store = Store(DB_PATH)
    rec = Recorder(store)
    async with httpx.AsyncClient(headers={"User-Agent": "polybook/0.1"}) as client:
        markets = []
        last_disc = 0
        last_minute = int(time.time() // 60)
        while True:
            now = time.time()
            if now - last_disc >= DISCOVERY_S:
                try:
                    markets = await discover(client, store)
                    tokens = sorted({t for m in markets for t in (m["token0"], m["token1"])})
                    await rec.set_tokens(tokens)
                    log.info("discovery: %d pregame markets, %d tokens", len(markets), len(tokens))
                except Exception as e:  # noqa
                    log.warning("discovery failed: %s", e)
                last_disc = now
            minute = int(now // 60)
            if minute != last_minute:
                store.flush()
                store.tob(rec.books.summary_rows(last_minute))
                store.health(int(last_minute * 60), len(markets), len(rec.assets), len(rec.tasks),
                             store.events_1m, store.trades_1m, rec.rtt)
                log.info("minute: %d events kept, %d deep changes dropped, %d trades", store.events_1m, store.dropped, store.trades_1m)
                store.events_1m = store.trades_1m = store.dropped = 0
                last_minute = minute
            store.flush()
            await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(main())
