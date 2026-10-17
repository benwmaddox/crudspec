#!/bin/bash
# startup with data: N rows spread like a chat app (most in one "messages" table), then load into memory
set -e
cd ~/gospike
N=${1:-1000000}
rm -f /tmp/spike.db
{
  for e in $(seq 0 27); do echo "CREATE TABLE e$e (id INTEGER PRIMARY KEY, seq INTEGER, created INTEGER, updated INTEGER, f0 TEXT, f1 INTEGER, f2 INTEGER, f3 TEXT, f4 INTEGER, f5 INTEGER, f6 TEXT, f7 INTEGER);"; done
  echo "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < $((N * 8 / 10))) INSERT INTO e0 SELECT i, i, i, i, 'message body text number ' || i || ' with some words in it', i % 500, i, 'x', i % 2000, 0, 'y', 0 FROM c;"
  for e in $(seq 1 27); do echo "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < $((N * 2 / 10 / 27))) INSERT INTO e$e SELECT i, i, i, i, 'row ' || i, i % 500, i, 'x', i % 2000, 0, 'y', 0 FROM c;"; done
} | sqlite3 /tmp/spike.db
ls -la /tmp/spike.db | awk '{print "db size: " $5 " bytes"}'
a=$(date +%s%N); ./spike /tmp/spike.db load-only; b=$(date +%s%N)
echo "start to all $N rows in memory with indexes: $(( (b - a) / 1000000 )) ms"
/usr/bin/time -f "peak RSS: %M KB" ./spike /tmp/spike.db load-only 2>&1 | tail -1
