"""Per-sport counterparty deep dive: where do small takers cross the spread for free?
One observation per (market, side, cell); event-clustered z; entry = actual fill price (executable).
usage: python3 cell_read.py mlb
"""
import sqlite3, math, sys, json, time
from collections import defaultdict
SPORT=sys.argv[1]; MINUSD, MAXUSD = 5, 100
db=sqlite3.connect("/root/polysharp/data/sharp.db")
db.execute("ATTACH DATABASE '/root/polybook/data/polybook.db' AS book")
t0=time.time()
def pband(p): return "20-40c" if p<0.40 else "40-50c" if p<0.50 else "50-60c" if p<0.60 else "60-80c" if p<0.80 else "80-95c"
def tband(m): return "0-15m" if m<15 else "15-60m" if m<60 else "60-180m" if m<180 else "3-6h"
def clz(obs):
    """obs = [(roi, cluster)] -> mean, clustered z, n"""
    n=len(obs)
    if n<2: return (0.0,0.0,n)
    m=sum(r for r,_ in obs)/n
    g=defaultdict(float)
    for r,c in obs: g[c]+=r-m
    se=math.sqrt(sum(v*v for v in g.values()))/n
    return (m, m/se if se>0 else 0.0, n)
def line(label, obs, minn=30):
    m,z,n=clz(obs)
    if n>=minn: print(f"  {label:36s} ROI {m*100:+6.1f}%  z={z:+5.1f}  n={n:5d}")
fills=db.execute("""SELECT m.condition_id, COALESCE(m.event_key,m.condition_id), m.market_type, m.start, m.winner0,
                           t.asset=m.token0, t.price, t.size, t.ts, t.asset
                    FROM markets m CROSS JOIN trades t INDEXED BY trades_cond ON t.condition_id=m.condition_id
                    WHERE m.sport=? AND m.status='done' AND m.winner0 IN (0,1) AND t.side='BUY'
                      AND t.ts BETWEEN m.start-21600 AND m.start AND t.price*t.size BETWEEN ? AND ?
                    ORDER BY m.condition_id, t.ts""",(SPORT,MINUSD,MAXUSD)).fetchall()
print(f"{SPORT}: {len(fills)} small taker BUY fills, {len({f[0] for f in fills})} markets ({time.time()-t0:.0f}s)")
# per (market, side, cell) mean roi
cell=defaultdict(lambda: defaultdict(list))   # cellkey -> (cid,side) -> [roi]
meta={}
prev_ts={}
for cid,ek,mt,st,w0,is0,p,sz,ts,asset in fills:
    if not (0.20<=p<0.95): continue
    win = w0 if is0 else 1-w0; roi=win/p-1; mins=(st-ts)/60
    since = (ts-prev_ts[cid])/60 if cid in prev_ts else None; prev_ts[cid]=ts
    meta[(cid,is0)]=(ek,st)
    keys=[("ALL",), ("type",mt), ("price",pband(p)), ("time",tband(mins)), ("price×time",pband(p),tband(mins)),
          ("type×time",mt,tband(mins)), ("type×price",mt,pband(p))]
    if since is not None:
        sb = "<1m" if since<1 else "1-5m" if since<5 else "5-30m" if since<30 else ">30m"
        keys.append(("since-last-trade",sb)); keys.append(("since×time",sb,tband(mins)))
    for k in keys: cell[k][(cid,is0)].append(roi)
def obs_of(k, half=None, med=None):
    out=[]
    for (cid,is0),rs in cell[k].items():
        ek,st=meta[(cid,is0)]
        if half=="old" and st>=med: continue
        if half=="new" and st<med: continue
        out.append((sum(rs)/len(rs), ek))
    return out
starts=sorted({st for ek,st in meta.values()}); med=starts[len(starts)//2]
print(f"time split at {time.strftime('%Y-%m-%d',time.gmtime(med))}\n")
for prefix in ["ALL","type","price","time","price×time","type×time","type×price","since-last-trade","since×time"]:
    print(f"== {prefix}   (one obs per market-side, mean small-taker fill ROI; z clustered by event)")
    for k in sorted([k for k in cell if k[0]==prefix], key=lambda k:k[1:]):
        m,z,n=clz(obs_of(k))
        if n<30: continue
        mo,zo,no=clz(obs_of(k,"old",med)); mn,zn,nn=clz(obs_of(k,"new",med))
        print(f"  {str(k[1:]):30s} ROI {m*100:+6.1f}%  z={z:+5.1f}  n={n:5d}   | older {mo*100:+5.1f}% (n={no})  recent {mn*100:+5.1f}% (n={nn})")
    print()
# ---------------- exchange features from polybook top-of-book (Sept coverage only)
print("== spread / depth at the fill minute (polybook top-of-book, September coverage only)")
tobobs=defaultdict(lambda: defaultdict(list))
n_tob=0
for cid,ek,mt,st,w0,is0,p,sz,ts,asset in fills:
    if not (0.20<=p<0.95): continue
    r=db.execute("SELECT best_bid,best_ask,ask_size FROM book.tob_minute WHERE asset=? AND minute<=? AND minute>=? ORDER BY minute DESC LIMIT 1",(asset,ts//60,ts//60-10)).fetchone()
    if not r or r[0] is None or r[1] is None or r[1]<=r[0]: continue
    n_tob+=1; win = w0 if is0 else 1-w0; roi=win/p-1; sp=round((r[1]-r[0])*100); dep=r[2]*r[1]
    sb="1c" if sp<=1 else "2c" if sp==2 else "3-4c" if sp<=4 else "5c+"
    dbk="<$500" if dep<500 else "$500-2k" if dep<2000 else "$2k-10k" if dep<10000 else "$10k+"
    for k in (("spread",sb),("depth@ask",dbk),("spread×time",sb,tband((st-ts)/60))): tobobs[k][(cid,is0)].append(roi)
print(f"  fills with a book snapshot: {n_tob}")
for k in sorted(tobobs, key=lambda k:(k[0],k[1:])):
    obs=[(sum(rs)/len(rs), meta[(cid,is0)][0]) for (cid,is0),rs in tobobs[k].items()]
    line(str(k), obs, 20)
# ---------------- our selection on top of the cell
print("\n== OUR PICKS vs the cell they sit in (entry = first small taker-BUY fill of the pick's token within 60 min after the pick)")
try: picks=json.load(open(f"/root/polysharp/data/{SPORT}_picks.json"))
except Exception as e: picks=[]; print("no picks file", e)
tok={cid:(t0_,t1_,w0_,ek_) for cid,t0_,t1_,w0_,ek_ in db.execute("SELECT condition_id, token0, token1, winner0, COALESCE(event_key,condition_id) FROM markets WHERE sport=? AND status='done'",(SPORT,))}
# verify side mapping A->token0 using the pick price vs token0 price at creation
agree={"A=token0":0,"A=token1":0}
for pk in picks[:400]:
    if pk["condition_id"] not in tok: continue
    r=db.execute("SELECT p FROM prices WHERE condition_id=? AND ts<=? ORDER BY ts DESC LIMIT 1",(pk["condition_id"],pk["created_at"])).fetchone()
    if not r: continue
    p0=r[0]; pp=pk["price"]; a0 = abs(pp-p0) if pk["sharp_side"]=="A" else abs(pp-(1-p0))
    a1 = abs(pp-(1-p0)) if pk["sharp_side"]=="A" else abs(pp-p0)
    agree["A=token0"]+= a0<a1; agree["A=token1"]+= a1<a0
print("  side-mapping check:", agree)
A_is0 = agree["A=token0"]>=agree["A=token1"]
res=defaultdict(list); base=defaultdict(list); matched=0; missing=0
for pk in picks:
    cid=pk["condition_id"]
    if cid not in tok: missing+=1; continue
    t0_,t1_,w0_,ek_=tok[cid]; is0 = (pk["sharp_side"]=="A")==A_is0; asset = t0_ if is0 else t1_
    r=db.execute("SELECT price, ts FROM trades WHERE condition_id=? AND asset=? AND side='BUY' AND ts BETWEEN ? AND ? AND price*size BETWEEN ? AND ? ORDER BY ts LIMIT 1",(cid,asset,pk["created_at"],pk["created_at"]+3600,MINUSD,MAXUSD)).fetchone()
    if not r: missing+=1; continue
    matched+=1; p,ts=r; win = w0_ if is0 else 1-w0_; roi=win/p-1
    mstart=db.execute("SELECT start FROM markets WHERE condition_id=?",(cid,)).fetchone()[0]; mins=(mstart-ts)/60
    ck=("price×time",pband(p),tband(mins)); typ=pk["market_type"] if pk["market_type"] in ("moneyline","total") else "other"
    cohort = "live" if pk["src"]=="live" else ("shadow clean" if pk["clean"] else "shadow dirty")
    res[(cohort,"ALL")].append((roi,ek_)); res[(cohort,typ)].append((roi,ek_)); res[(cohort,ck[1],ck[2])].append((roi,ek_))
    # cell baseline: mean small-taker roi in the same cell, same market-side excluded is overkill; use cell mean over all markets
    cb=cell[ck].get((cid,is0))
    base[(cohort,"ALL")].append((clz(obs_of(ck))[0],ek_))
print(f"  picks matched to an executable fill: {matched}, unmatched/unknown market: {missing}")
for k in sorted(res, key=lambda k:(k[0],str(k[1:]))):
    m,z,n=clz(res[k])
    if n<10: continue
    extra=""
    if k[1]=="ALL": extra=f"   | cell-baseline avg {clz(base[(k[0],'ALL')])[0]*100:+.1f}% -> selection adds {(m-clz(base[(k[0],'ALL')])[0])*100:+.1f} pts"
    print(f"  {k[0]:13s} {str(k[1:]):26s} ROI {m*100:+6.1f}%  z={z:+5.1f}  n={n:4d}{extra}")
print(f"\ndone {time.time()-t0:.0f}s")
