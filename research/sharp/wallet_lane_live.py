"""Wallet-signal lane — live signal job for game totals, any sport (generalised from cfb_hot_live.py, 2026-10-09).
Lanes: nfl_wallet_follow (era v22, RULE=S3SQ, charter docs/charters/nfl-wallet-follow-pilot.md).
Env: LANE, SERIES_ID (Gamma series), RECORDS (pickle from wallet_records.py), RULE:
  HT    = follow HOT or TEAM wallets (the CFB rule);
  S3SQ  = follow TEAM wallets, and bet AGAINST SQUARE wallets (>= 30 settled, ROI <= -15%).
A side's support = follow-type wallets ON it + square wallets on the OTHER side; support on both sides -> voided.
--- original header (cfb_hot_live.py) ---

Rule = cell `A HT FOLLOW` of the NCAAF wallet backtest (docs/audits/2026-10-09-ncaaf-wallet-backtest.md), computed live:
- records (cfb_records.pkl, built on the desktop by cfb_records.py from the CFB backfill, shipped daily):
  HOT  = last 12 settled CFB positions >= 9 winners; TEAM = >= 10 settled positions in markets naming one of this
  game's teams at ROI >= +15%; a position counts once its start + 4h is before now;
- a wallet is ON Over (Under) when its pregame BUY cash on Over (Under), summed over ALL of the game's total lines,
  is >= $100 and exceeds its BUY cash on the other side (full maker+taker tape, fills >= $50);
- signal = HOT-or-TEAM wallets on exactly one side -> follow that side; on both sides -> voided (no bet).
Pushes the current state for every upcoming CFB game with a HOT/TEAM wallet on it to /api/bot/lane-signals
(lane cfb_hot_follow); rows not re-pushed are cleared by the app. Runs every 10 min (cfb-hot-live.timer).
usage: python3 cfb_hot_live.py [--dry]
"""
import os, sys, time, json, pickle, bisect, re, urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

LANE = os.environ["LANE"]
SERIES = os.environ["SERIES_ID"]                       # Gamma series id (per season)
RECORDS = os.environ["RECORDS"]
RULE = os.environ.get("RULE", "HT")
FOLLOW_KINDS, FADE_KINDS = {"HT": ({"hot", "team"}, set()), "S3SQ": ({"team"}, {"square"})}[RULE]
ON_USD, MIN_CASH = 100, 50
LOOKAHEAD_H = int(os.environ.get("LOOKAHEAD_H", 24))
PUSH_LO, PUSH_HI = 0.30, 0.70                          # lines worth pushing (lane band is narrower, app-side)
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

def parse_ts(s):
    from datetime import datetime
    if not s: return None
    s = s.replace(" ", "T"); s = s + ":00" if re.search(r"[+-]\d\d$", s) else s
    try: return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except ValueError: return None

def upcoming_games(now):
    games, off = [], 0
    while off < 2000:
        page = get(f"https://gamma-api.polymarket.com/events?series_id={SERIES}&closed=false&limit=100&offset={off}")
        if not isinstance(page, list): break
        for e in page:
            lines = []
            for m in e.get("markets", []):
                if m.get("sportsMarketType") != "totals" or m.get("closed"): continue
                st = parse_ts(m.get("gameStartTime"))
                if st is None or not (now < st <= now + LOOKAHEAD_H * 3600): continue
                try:
                    toks, outs = json.loads(m["clobTokenIds"]), json.loads(m["outcomes"])
                    px = [float(x) for x in json.loads(m.get("outcomePrices") or "[]")]
                except Exception:
                    continue
                if len(toks) != 2 or [o.lower() for o in outs] != ["over", "under"]: continue
                lines.append(dict(cid=m["conditionId"], over=toks[0], st=st, q=m.get("question"), line=m.get("line"),
                                  p_over=px[0] if px else None))
            if lines:
                tm = re.match(r"^(.+?) vs\.? (.+?)$", (e.get("title") or "").strip())
                games.append(dict(title=e.get("title"), teams=(tm.group(1).strip(), tm.group(2).strip()) if tm else (),
                                  st=min(l["st"] for l in lines), lines=lines))
        if len(page) < 100: break
        off += 100
    return games

def tape(cid):
    rows = []
    for off in range(0, 11000, 1000):
        page = get(f"https://data-api.polymarket.com/trades?market={cid}&limit=1000&offset={off}&takerOnly=false"
                   f"&filterType=CASH&filterAmount={MIN_CASH}")
        if not isinstance(page, list): return None
        rows += page
        if len(page) < 1000: break
    return rows

def main():
    now = int(time.time())
    R = pickle.load(open(RECORDS, "rb")); hot, team, allr = R["hot"], R["team"], R.get("all", {})
    age_h = (now - R["built_at"]) / 3600
    log(f"records: {len(hot)} hot-eligible, {len(team)} team keys, built {age_h:.1f}h ago")
    def is_hot(w):
        r = hot.get(w)
        if not r: return False
        n = bisect.bisect_left(r[0], now)
        return n >= 12 and r[1][n] - r[1][n - 12] >= 9
    def is_team(w, teams):
        for tm in teams:
            r = team.get((w, tm))
            if not r: continue
            n = bisect.bisect_left(r[0], now)
            if n >= 10 and r[2][n] > 0 and r[1][n] / r[2][n] >= 0.15: return True
        return False
    def is_square(w):
        r = allr.get(w)
        if not r: return False
        n = bisect.bisect_left(r[0], now)
        return n >= 30 and r[2][n] > 0 and r[1][n] / r[2][n] <= -0.15
    games = upcoming_games(now)
    cids = [l["cid"] for g in games for l in g["lines"]]
    log(f"{len(games)} upcoming games, {len(cids)} total lines")
    with ThreadPoolExecutor(16) as ex: tapes = dict(zip(cids, ex.map(tape, cids)))
    signals, stats = [], defaultdict(int)
    for g in games:
        buys = defaultdict(lambda: [0.0, 0.0])            # wallet -> [under cash, over cash]
        failed = False
        for l in g["lines"]:
            t = tapes.get(l["cid"])
            if t is None: failed = True; continue
            for x in t:
                ts = int(x["timestamp"])
                if x.get("side") != "BUY" or ts >= min(now, l["st"]): continue
                buys[x.get("proxyWallet")][1 if x.get("asset") == l["over"] else 0] += float(x["price"]) * float(x["size"])
        if failed: stats["tape_failed"] += 1
        on = {0: [], 1: []}                              # support for betting side s
        for w, b in buys.items():
            for s in (0, 1):
                if b[s] >= ON_USD and b[s] > b[1 - s]:
                    kinds = {k for k, ok in (("hot", "hot" in FOLLOW_KINDS and is_hot(w)),
                                             ("team", "team" in FOLLOW_KINDS and is_team(w, g["teams"])),
                                             ("square", "square" in FADE_KINDS and is_square(w))) if ok}
                    if kinds & FOLLOW_KINDS: on[s].append(dict(wallet=w, kinds=sorted(kinds & FOLLOW_KINDS), usd=round(b[s])))
                    if kinds & FADE_KINDS: on[1 - s].append(dict(wallet=w, kinds=["fade_square"], usd=round(b[s])))
        if not on[0] and not on[1]: continue
        voided = bool(on[0] and on[1])
        label = None if voided else ("Over" if on[1] else "Under")
        stats["voided" if voided else "signals"] += 1
        print(f"   {g['title']}: {'VOIDED' if voided else 'follow ' + label}  over={len(on[1])} under={len(on[0])}", flush=True)
        for l in g["lines"]:
            if l["p_over"] is None or not (PUSH_LO <= l["p_over"] <= PUSH_HI): continue
            signals.append(dict(condition_id=l["cid"], question=f"{g['title']}: O/U {l['line']}", start=l["st"],
                                bet_label=label, trigger_ts=now, voided=1 if voided else 0,
                                detail=dict(over=on[1][:10], under=on[0][:10])))
    summary = dict(updatedAt=now, recordsBuiltAt=R["built_at"], recordsAgeH=round(age_h, 1), games=len(games),
                   lines=len(cids), pushed=len(signals), **stats)
    log(f"{dict(stats)}; pushing {len(signals)} lines")
    if not DRY: push({"lane": LANE, "signals": signals, "summary": summary})

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
    req = urllib.request.Request(f"{base}/api/bot/lane-signals", method="POST", data=json.dumps(payload).encode(),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "polysharp/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: print("push:", json.load(r))
    except Exception as e:  # noqa
        print("push failed:", str(e)[:200])

if __name__ == "__main__":
    main()
