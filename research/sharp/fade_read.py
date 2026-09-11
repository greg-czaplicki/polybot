import sqlite3, math, time
from collections import defaultdict
db=sqlite3.connect("/root/polysharp/data/sharp.db")
t0=time.time()
asofs=[a for a, in db.execute("SELECT DISTINCT asof FROM wallet_scores ORDER BY asof")]
W=7*86400
def z_of(rs):
    n=len(rs)
    if n<2: return (0.0,0.0,n)
    m=sum(rs)/n; sd=math.sqrt(sum((x-m)**2 for x in rs)/n); return (m, m/(sd/math.sqrt(n)) if sd>0 else 0.0, n)
def fmt(label, rs):
    m,z,n=z_of(rs); print(f"  {label:44s} ROI {m*100:+6.1f}%  z={z:+5.1f}  n={n}")
# ------------------------------------------------------------ persistence: forward realized ROI by tier assigned at asof
fwd=defaultdict(list); fwd_w=defaultdict(set)
# ------------------------------------------------------------ fade: per market net square / sharp taker-buy notional in [T-6h, T-1h]
obs=[]  # dict per market
for A in asofs:
    tiers={w:t for w,t in db.execute("SELECT wallet, tier FROM wallet_scores WHERE asof=? AND n>=20", (A,))}
    fills=db.execute("""SELECT t.condition_id, t.wallet, t.asset=m.token0, t.price, t.size, m.sport, m.market_type, m.start, m.winner0
                        FROM markets m CROSS JOIN trades t INDEXED BY trades_cond ON t.condition_id=m.condition_id
                        WHERE m.status='done' AND m.winner0 IN (0,1) AND m.start>=? AND m.start<? AND t.side='BUY'
                          AND t.ts BETWEEN m.start-21600 AND m.start-3600 AND t.price*t.size>=5""",(A,A+W)).fetchall()
    per=defaultdict(lambda:{"sq":[0.0,0.0],"sh":[0.0,0.0],"all":[0.0,0.0]})
    meta={}
    for cid,w,is0,p,sz,sport,mt,st,win0 in fills:
        tier=tiers.get(w,"none"); win=win0 if is0 else 1-win0
        fwd[tier].append(win/p-1); fwd_w[tier].add(w)
        d=per[cid]; k=0 if is0 else 1; usd=p*sz
        d["all"][k]+=usd
        if tier=="square": d["sq"][k]+=usd
        if tier=="sharp": d["sh"][k]+=usd
        meta[cid]=(sport,mt,st,win0)
    for cid,d in per.items():
        sport,mt,st,win0=meta[cid]
        obs.append((cid,sport,mt,st,win0,d["sq"][0],d["sq"][1],d["sh"][0],d["sh"][1],d["all"][0],d["all"][1]))
    print(f"asof {time.strftime('%Y-%m-%d',time.gmtime(A))}: {len(fills)} fills, {len(per)} markets  ({time.time()-t0:.0f}s)", flush=True)
print("\nPERSISTENCE: forward realized taker ROI (fills in the week AFTER the snapshot, held to settlement, equal-weighted per fill)")
for t in ["square","mid","sharp","none"]:
    m,z,n=z_of(fwd[t]); print(f"  tier {t:7s} ROI {m*100:+6.1f}%  n_fills={n:7d}  n_wallets={len(fwd_w[t])}   (per-fill z inflated by market clustering: {z:+.1f})")
# executable entry price for a side: last taker BUY of that token in the last 30 min, >= $20
def entry(cid, side, st):
    tok = db.execute("SELECT token0, token1 FROM markets WHERE condition_id=?", (cid,)).fetchone()[side]
    r=db.execute("SELECT price FROM trades WHERE condition_id=? AND asset=? AND side='BUY' AND ts<=? AND ts>=? AND price*size>=20 ORDER BY ts DESC LIMIT 1",(cid,tok,st,st-1800)).fetchone()
    return r[0] if r else None
def run(name, pick_side, minusd):
    rows=[]
    for cid,sport,mt,st,win0,sq0,sq1,sh0,sh1,a0,a1 in obs:
        side=pick_side(sq0,sq1,sh0,sh1,a0,a1,minusd)
        if side is None: continue
        p=entry(cid,side,st)
        if p is None or not (0.05<=p<=0.95): continue
        win = win0 if side==0 else 1-win0
        rows.append((sport,mt,st,win/p-1,p))
    print(f"\n{name} (min net ${minusd}, entry = last executable taker-buy price of the chosen side)")
    fmt("ALL", [r[3] for r in rows])
    sts=sorted(r[2] for r in rows); med=sts[len(sts)//2] if sts else 0
    fmt("older half",[r[3] for r in rows if r[2]<med]); fmt("recent half",[r[3] for r in rows if r[2]>=med])
    for s in ["mlb","atp","wta","cs2","fifwc","nba","wnba","nfl","lol","val"]:
        rs=[r[3] for r in rows if r[0]==s]
        if len(rs)>=40: fmt(s, rs)
    for mt in ["moneyline","total","spread","prop"]:
        rs=[r[3] for r in rows if r[1]==mt]
        if len(rs)>=40: fmt("type="+mt, rs)
    for lo,hi in ((0.05,0.35),(0.35,0.65),(0.65,0.95)):
        rs=[r[3] for r in rows if lo<=r[4]<hi]
        if len(rs)>=40: fmt(f"entry {lo:.2f}-{hi:.2f}", rs)
def fade_sq(sq0,sq1,sh0,sh1,a0,a1,minusd):
    net=sq0-sq1
    if abs(net)<minusd: return None
    return 1 if net>0 else 0          # bet AGAINST net square money
def follow_sq(sq0,sq1,sh0,sh1,a0,a1,minusd):
    net=sq0-sq1
    if abs(net)<minusd: return None
    return 0 if net>0 else 1
def follow_sh(sq0,sq1,sh0,sh1,a0,a1,minusd):
    net=sh0-sh1
    if abs(net)<minusd: return None
    return 0 if net>0 else 1
def fade_sq_clean(sq0,sq1,sh0,sh1,a0,a1,minusd):
    net=sq0-sq1
    if abs(net)<minusd: return None
    side=1 if net>0 else 0
    # require sharps NOT on the square side (or absent)
    if (sh0-sh1>0 and side==1) or (sh1-sh0>0 and side==0): return None
    return side
def fade_crowd(sq0,sq1,sh0,sh1,a0,a1,minusd):
    net=a0-a1
    if abs(net)<minusd or (a0+a1)<=0 or abs(net)/(a0+a1)<0.6: return None
    return 1 if net>0 else 0
for minusd in (200, 1000):
    run("FADE net SQUARE money", fade_sq, minusd)
run("FADE net SQUARE money, sharps not with them", fade_sq_clean, 200)
run("FOLLOW net SQUARE money (mirror check)", follow_sq, 200)
run("FOLLOW net SHARP money (same mechanics, for comparison)", follow_sh, 200)
run("FADE the whole crowd (>=60% one-sided, any wallet)", fade_crowd, 2000)
print(f"\ndone {time.time()-t0:.0f}s")
