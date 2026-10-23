"""Esports match-winner wallet FOLLOW lane — live signal job (era v26, 2026-10-23). First lane: dota2_wallet_follow,
charter docs/charters/dota2-wallet-follow-pilot.md; evidence docs/audits/2026-10-21-dota2-wallet-backtest.md.

Rule = the backtest's union of follow cells B S1 / B S3 (research/sharp/dota2_wallets.py, dota2_combo.py), live:
- records (dota2_records.pkl, built on the desktop by wallet_records.py SPORT=dota2, shipped daily by wallet-daily.sh):
  SHARP (S1) = >= 30 settled positions at ROI >= +10%; TEAM (S3) = >= 10 settled positions in markets naming one of
  this match's teams at ROI >= +15%; a position counts once its start + 4h is before the trigger;
- trigger = a wallet's first pregame BUY fill >= $100 on a token within 24h of start (full maker+taker tape, fills >= $50),
  qualified with records as of that fill;
- SHARP triggers on exactly one side -> follow it; else TEAM triggers on exactly one side -> follow it;
  triggers on both sides (and nothing one-sided) -> voided.
bet_label is the outcome INDEX: "A" = the market's first outcome (token0 = the app's sideA), "B" = second — the app's
esports side labels are parsed from the title and unreliable. detail carries the team name.
Pushes upcoming match-winner (BOn) markets to /api/bot/lane-signals; rows not re-pushed are cleared by the app.
Env: LANE, SERIES_ID (Gamma series, comma list), RECORDS, TITLE_PREFIX (e.g. "Dota 2: ").  usage: [--dry]
"""
import os, sys, time, json, pickle, bisect, re, urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

LANE = os.environ["LANE"]
SERIES = [x for x in os.environ["SERIES_ID"].split(",") if x]
RECORDS = os.environ["RECORDS"]
PREFIX = os.environ.get("TITLE_PREFIX", "Dota 2: ")
TRIG_USD, MIN_CASH = 100, 50
LOOKAHEAD_H = int(os.environ.get("LOOKAHEAD_H", 24))
TEAMS_RE = re.compile(r"^" + re.escape(PREFIX) + r"(.+?) vs\.? (.+?)(?: \(BO\d\))?(?: - |$)")
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

def upcoming_matches(now):
    out, seen = [], set()
    for sid in SERIES:
        off = 0
        while off < 2000:
            page = get(f"https://gamma-api.polymarket.com/events?series_id={sid}&closed=false&limit=100&offset={off}")
            if not isinstance(page, list): break
            for e in page:
                for m in e.get("markets", []):
                    q = m.get("question") or ""
                    if m.get("closed") or m.get("sportsMarketType") != "moneyline" or not re.search(r"\(BO\d\)", q): continue
                    tm = TEAMS_RE.match(q)
                    st = parse_ts(m.get("gameStartTime"))
                    if not tm or st is None or not (now < st <= now + LOOKAHEAD_H * 3600) or m["conditionId"] in seen: continue
                    try:
                        toks, outs = json.loads(m["clobTokenIds"]), json.loads(m["outcomes"])
                    except Exception:
                        continue
                    if len(toks) != 2: continue
                    seen.add(m["conditionId"])
                    out.append(dict(cid=m["conditionId"], q=q, st=st, tok0=toks[0], outs=outs,
                                    teams=(tm.group(1).strip(), tm.group(2).strip())))
            if len(page) < 100: break
            off += 100
    return out

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
    R = pickle.load(open(RECORDS, "rb")); team, allr = R["team"], R.get("all", {})
    age_h = (now - R["built_at"]) / 3600
    log(f"records [{R.get('sport')}]: {len(allr)} wallets >= 30 positions, {len(team)} team keys, built {age_h:.1f}h ago")
    def is_sharp(w, t):
        r = allr.get(w)
        if not r: return False
        n = bisect.bisect_left(r[0], t)
        return n >= 30 and r[2][n] > 0 and r[1][n] / r[2][n] >= 0.10
    def is_team(w, teams, t):
        for tm in teams:
            r = team.get((w, tm))
            if not r: continue
            n = bisect.bisect_left(r[0], t)
            if n >= 10 and r[2][n] > 0 and r[1][n] / r[2][n] >= 0.15: return True
        return False
    matches = upcoming_matches(now)
    log(f"{len(matches)} upcoming match winners")
    with ThreadPoolExecutor(16) as ex: tapes = dict(zip([m["cid"] for m in matches], ex.map(tape, [m["cid"] for m in matches])))
    signals, stats = [], defaultdict(int)
    for m in matches:
        t = tapes.get(m["cid"])
        if t is None: stats["tape_failed"] += 1; continue
        first = {}                                        # (wallet, side) -> first qualifying-size BUY ts
        for x in t:
            ts = int(x["timestamp"]); usd = float(x["price"]) * float(x["size"])
            if x.get("side") != "BUY" or usd < TRIG_USD or not (m["st"] - 86400 <= ts < min(now, m["st"])): continue
            k = (x.get("proxyWallet"), 0 if x.get("asset") == m["tok0"] else 1)
            if k not in first or ts < first[k]: first[k] = ts
        trig = {"S1": {0: [], 1: []}, "S3": {0: [], 1: []}}
        for (w, s), ts in first.items():
            if is_sharp(w, ts): trig["S1"][s].append(dict(wallet=w, ts=ts))
            if is_team(w, m["teams"], ts): trig["S3"][s].append(dict(wallet=w, ts=ts))
        side = kind = None
        for k in ("S1", "S3"):
            a, b = trig[k][0], trig[k][1]
            if bool(a) != bool(b): side, kind = (0 if a else 1), k; break
        any_trig = any(trig[k][s] for k in trig for s in (0, 1))
        if not any_trig: continue
        voided = side is None
        stats["voided" if voided else "signals"] += 1
        trig_ts = None if voided else min(x["ts"] for x in trig[kind][side])
        team_name = None if voided else (m["outs"][side] if len(m["outs"]) == 2 else None)
        print(f"   {m['q'][:70]}: {'VOIDED' if voided else f'follow {team_name} ({kind})'}  "
              f"S1 {len(trig['S1'][0])}/{len(trig['S1'][1])}  S3 {len(trig['S3'][0])}/{len(trig['S3'][1])}", flush=True)
        signals.append(dict(condition_id=m["cid"], question=m["q"][:200], start=m["st"],
                            bet_label=None if voided else ("A" if side == 0 else "B"), trigger_ts=trig_ts or now,
                            voided=1 if voided else 0,
                            detail=dict(team=team_name, kind=kind, outcomes=m["outs"],
                                        s1=[trig["S1"][0][:5], trig["S1"][1][:5]], s3=[trig["S3"][0][:5], trig["S3"][1][:5]])))
    summary = dict(updatedAt=now, recordsBuiltAt=R["built_at"], recordsAgeH=round(age_h, 1), matches=len(matches),
                   pushed=len(signals), **stats)
    log(f"{dict(stats)}; pushing {len(signals)}")
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
