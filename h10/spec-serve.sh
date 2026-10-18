#!/usr/bin/env bash
# Builds a crudspec spec and serves it on a loopback port, for H10 (docs/H10-PROTOCOL.md).
#   bash h10/spec-serve.sh <spec.crud> <build-dir> <data-dir> <port> [fresh|migrate]
# fresh: an empty database. migrate: the data dir's database, upgraded with `cli migrate`
# (which builds the app's data step itself). It prints the time to serving.
set -euo pipefail
SPEC=$1; BUILD=$2; DATA=$3; PORT=$4; MODE=${5:-fresh}
REPO=/mnt/d/code/crudspec
export PATH=$PATH:/usr/local/go/bin GOFLAGS=-buildvcs=false
t0=$(date +%s%N)
cd "$REPO"
node lang/cli.ts build "$SPEC" --out "$BUILD" > "$BUILD.build.log" 2>&1 || { tail -20 "$BUILD.build.log"; exit 1; }
t1=$(date +%s%N)
if [ "$MODE" = migrate ]; then node lang/cli.ts migrate "$SPEC" --data "$DATA" > "$BUILD.migrate.log" 2>&1 || { tail -20 "$BUILD.migrate.log"; exit 2; }; fi
t2=$(date +%s%N)
mkdir -p "$DATA"
(TZ=America/New_York setsid "$BUILD/app" --data "$DATA" --assets /mnt/d/code/crudspec-assets/campfire --port "$PORT" > "$DATA/server.log" 2>&1 &)
for i in $(seq 1 300); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/up" 2>/dev/null && break; sleep 0.05; done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/up" || { tail -20 "$DATA/server.log"; exit 3; }
t3=$(date +%s%N)
echo "spec serving on $PORT after $(( (t3 - t0) / 1000000 )) ms ($MODE: build $(( (t1 - t0) / 1000000 )), migrate $(( (t2 - t1) / 1000000 )), start $(( (t3 - t2) / 1000000 )))"
