"""Prune raw order-book events older than RETENTION_DAYS from polybook.db.

Runs at the end of polybook-report.sh. Deletes in rowid batches with a commit
per batch so the recorder (bookrec.py, 60 s busy timeout) never waits long,
and so the WAL never balloons by a whole day of rows in one transaction.
events is a plain rowid table appended in time order, so rowid order == recv_ms
order; the boundary lookup scans only the rows that are about to be deleted.
"""
import sqlite3
import sys
import time

DB = sys.argv[1] if len(sys.argv) > 1 else "/root/polybook/data/polybook.db"
RETENTION_DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 14
BATCH = 50_000

cutoff_ms = (int(time.time()) - RETENTION_DAYS * 86400) * 1000
db = sqlite3.connect(DB, timeout=120)
db.execute("PRAGMA busy_timeout = 120000")

row = db.execute(
    "SELECT rowid FROM events WHERE recv_ms >= ? ORDER BY rowid LIMIT 1", (cutoff_ms,)
).fetchone()
lo = db.execute("SELECT MIN(rowid) FROM events").fetchone()[0]
if row is None or lo is None or row[0] <= lo:
    print(f"prune: nothing older than {RETENTION_DAYS}d (boundary rowid {row and row[0]}, min rowid {lo})")
    sys.exit(0)

boundary = row[0]
deleted = 0
t0 = time.time()
cur = lo
while cur < boundary:
    hi = min(cur + BATCH, boundary)
    n = db.execute("DELETE FROM events WHERE rowid >= ? AND rowid < ?", (cur, hi)).rowcount
    db.commit()
    deleted += n
    cur = hi
db.execute("PRAGMA wal_checkpoint(PASSIVE)")
print(f"prune: deleted {deleted} events older than {RETENTION_DAYS}d (rowid < {boundary}) in {time.time() - t0:.1f}s")
