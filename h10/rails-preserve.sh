#!/usr/bin/env bash
# The Rails arm's preservation check (docs/H10-PROTOCOL.md): the oracle's 42 scenarios run
# through a copy of the arm's app, compared with the goldens the unmodified app recorded.
#   wsl -d Ubuntu -u root -- bash /mnt/d/code/crudspec/h10/rails-preserve.sh <app-dir> <run-name>
set -uo pipefail
APP=$1; RUN=$2
REPO=/mnt/d/code/crudspec
O=$REPO/apps/campfire/oracle
OUTROOT=/home/ben/h10-oracle/$RUN
total=0; matched=0
for p in "smoke smoke-10" "slice-v1 slice-v1-e" "checker-findings findings-1" "v2-areas v2-areas-h"; do set -- $p
  out=$OUTROOT/$1
  rm -rf "$out"; mkdir -p "$out"; chown ben:ben "$OUTROOT" "$out"
  APP_SRC=$APP ORACLE_OUT_DIR=$out bash $O/rails/run.sh "h10-$RUN-$1-$(date +%s)" "$O/scenarios/$1" > "$out.log" 2>&1
  res=$(python3 $O/compare.py "$O/golden/$2" "$out" 2>&1 | tail -1)
  echo "$1: $res"
  n=$(echo "$res" | grep -o '^[0-9]*/[0-9]*' || echo "0/0")
  matched=$((matched + ${n%/*})); total=$((total + ${n#*/}))
done
echo "preserved: $matched/$total"
