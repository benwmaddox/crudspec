#!/usr/bin/env bash
# The spec arm's preservation check (docs/H10-PROTOCOL.md): the 42 oracle scenarios replayed
# against the arm's spec, compiled, in --test mode.
#   bash h10/spec-preserve.sh <spec.crud> <port>
set -uo pipefail
SPEC=$1; PORT=$2
REPO=/mnt/d/code/crudspec
export PATH=$PATH:/usr/local/go/bin GOFLAGS=-buildvcs=false
B=$HOME/h10-preserve/$PORT; rm -rf "$B"; mkdir -p "$B"
cd "$REPO"
node lang/cli.ts build "$SPEC" --out "$B/build" > "$B/build.log" 2>&1 || { echo "build failed"; tail -5 "$B/build.log"; echo "preserved: 0/42"; exit 1; }
bash $REPO/h10/stop-port.sh "$PORT"
(TZ=America/New_York setsid "$B/build/app" --data "$B/data" --assets /mnt/d/code/crudspec-assets/campfire --port "$PORT" --test --check-cache > "$B/server.log" 2>&1 &)
for i in $(seq 1 100); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/up" 2>/dev/null && break; sleep 0.1; done
total=0; matched=0
for p in "smoke smoke-10" "slice-v1 slice-v1-e" "checker-findings findings-1" "v2-areas v2-areas-h"; do set -- $p
  res=$(node apps/campfire/test/replay-runtime.ts "$SPEC" "http://127.0.0.1:$PORT" "apps/campfire/oracle/scenarios/$1" "apps/campfire/oracle/golden/$2" 2>/dev/null | grep "scenarios match" | tail -1)
  echo "$1: $res"
  n=$(echo "$res" | grep -o '^[0-9]*/[0-9]*' || echo "0/0")
  matched=$((matched + ${n%/*})); total=$((total + ${n#*/}))
done
bash $REPO/h10/stop-port.sh "$PORT"
echo "preserved: $matched/$total"
echo "cache check: $(grep -c "^cache check:" "$B/server.log" || true) mismatches (--check-cache)"
