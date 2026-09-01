#!/usr/bin/env python3
"""Normalize tennis-data.co.uk xlsx season files to one CSV per tour.

Output: matches_atp.csv / matches_wta.csv with stable lowercase columns.
Rows are kept in file order (site order is chronological by tournament).
No filtering here beyond dropping fully-empty rows — population rules
(tour level, walkovers, retirement labels) are applied downstream so the
raw snapshot stays faithful to source.
"""
import csv, glob, os, re
import openpyxl

BASE = os.path.dirname(os.path.abspath(__file__))
COLS = ["date", "tournament", "series", "surface", "round", "best_of",
        "winner", "loser", "wrank", "lrank", "wpts", "lpts", "comment",
        "b365w", "b365l", "psw", "psl", "maxw", "maxl", "avgw", "avgl",
        "wsets", "lsets", "year_file", "tour"]

def norm(h):
    return re.sub(r"[^a-z0-9]", "_", str(h).strip().lower())

for tour in ("atp", "wta"):
    out_path = os.path.join(BASE, f"matches_{tour}.csv")
    n_rows = 0
    with open(out_path, "w", newline="") as out:
        w = csv.DictWriter(out, fieldnames=COLS)
        w.writeheader()
        for f in sorted(glob.glob(os.path.join(BASE, "tennisdata", f"{tour}_*.xlsx"))):
            year = re.search(r"(\d{4})", os.path.basename(f)).group(1)
            wb = openpyxl.load_workbook(f, read_only=True)
            ws = wb.active
            rows = ws.iter_rows(values_only=True)
            hdr = [norm(h) for h in next(rows)]
            idx = {h: i for i, h in enumerate(hdr)}
            def get(r, k):
                i = idx.get(k)
                return r[i] if i is not None and i < len(r) else None
            for r in rows:
                if get(r, "winner") is None and get(r, "loser") is None:
                    continue
                d = get(r, "date")
                w.writerow({
                    "date": d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else d,
                    "tournament": get(r, "tournament"),
                    "series": get(r, "series") or get(r, "tier"),
                    "surface": get(r, "surface"),
                    "round": get(r, "round"),
                    "best_of": get(r, "best_of"),
                    "winner": get(r, "winner"), "loser": get(r, "loser"),
                    "wrank": get(r, "wrank"), "lrank": get(r, "lrank"),
                    "wpts": get(r, "wpts"), "lpts": get(r, "lpts"),
                    "comment": get(r, "comment"),
                    "b365w": get(r, "b365w"), "b365l": get(r, "b365l"),
                    "psw": get(r, "psw"), "psl": get(r, "psl"),
                    "maxw": get(r, "maxw"), "maxl": get(r, "maxl"),
                    "avgw": get(r, "avgw"), "avgl": get(r, "avgl"),
                    "wsets": get(r, "wsets"), "lsets": get(r, "lsets"),
                    "year_file": year, "tour": tour,
                })
                n_rows += 1
            wb.close()
    print(f"{tour}: {n_rows} rows -> {out_path}")

# Coverage blocker-check (charter: >=90% closing-odds coverage required)
for tour in ("atp", "wta"):
    with open(os.path.join(BASE, f"matches_{tour}.csv")) as f:
        rows = list(csv.DictReader(f))
    by_year = {}
    for r in rows:
        y = r["year_file"]
        c = by_year.setdefault(y, [0, 0, 0, 0])  # n, ps, b365, any
        c[0] += 1
        c[1] += bool(r["psw"] and r["psl"])
        c[2] += bool(r["b365w"] and r["b365l"])
        c[3] += bool((r["psw"] and r["psl"]) or (r["b365w"] and r["b365l"])
                     or (r["avgw"] and r["avgl"]))
    print(f"[{tour}] year: n  pinnacle%  b365%  any-odds%")
    for y in sorted(by_year):
        n, ps, b, a = by_year[y]
        print(f"  {y}: {n}  {100*ps/n:.1f}  {100*b/n:.1f}  {100*a/n:.1f}")
