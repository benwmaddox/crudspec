#!/usr/bin/env bash
# Replays oracle scenarios over HTTP against the Rust baseline (or a patched copy of it).
# Rails builds each scenario's setup and normalizes the final state; the Rust server serves
# every action. Results land in oracle/replays/<run>/, in the golden-file format.
#
#   wsl -d Ubuntu -u root -- bash /mnt/d/code/crudspec/oracle/rails/replay-rust.sh <run> <scenario-dir> [baseline-src]
set -euo pipefail
RUN=$1
SCEN=$2
U=ben; UH=/home/$U; L=$UH/linuxbench
SRC=${3:-$L/crudspec-baseline/src}
REPO=/mnt/d/code/crudspec
W=$L/crudspec-runs/replay-$RUN
OUT=${ORACLE_OUT_DIR:-$REPO/oracle/replays/$RUN}
PORT=${REPLAY_PORT:-13775}   # the app port; the port below it is the HTTP front
test ! -e "$W" || { echo "run $RUN exists"; exit 2; }
asu() { setpriv --reuid=$U --regid=$U --init-groups "$@"; }

# Build the server (debug: same behaviour, much faster to rebuild for patched copies).
asu env -i HOME=$UH PATH=$UH/.cargo/bin:/usr/local/bin:/usr/bin:/bin bash -c "cd '$SRC' && cargo build -q -p campfire"
BIN=$SRC/target/debug/campfire

asu mkdir -p "$W"
asu cp -a "$L/rails/app" "$W/app"
ROOT=$W/app
asu rm -rf "$ROOT/storage"; asu mkdir -p "$ROOT/storage/db" "$ROOT/storage/logs" "$ROOT/storage/files"
asu cp "$REPO/oracle/rails/oracle.rb" "$W/oracle.rb"
asu mkdir -p "$W/scenarios" "$W/out"
case $SCEN in /*) ;; *) SCEN=$REPO/$SCEN ;; esac
asu cp "$SCEN"/*.json "$W/scenarios/"

SECRET=$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')
BASE=(LANG=C.UTF-8 HOME=$UH USER=$U RAILS_ENV=production DISABLE_SSL=1 SECRET_KEY_BASE=$SECRET RAILS_LOG_LEVEL=warn)
ENVV=("${BASE[@]}"
      PATH=$L/rails/bundle/bin:$L/ruby-3.4.10/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      GEM_HOME=$L/rails/bundle BUNDLE_APP_CONFIG=$L/rails/bundle BUNDLE_SILENCE_ROOT_WARNING=1 BUNDLE_DEPLOYMENT=1
      BUNDLE_PATH=$L/rails/bundle BUNDLE_WITHOUT=development APP_VERSION=crudspec-oracle
      GIT_REVISION=90b330024dec3e757c79b6a7e6568f93da8e3148)
SERVER="cd '$ROOT' && exec env -i ${BASE[*]} PATH=/usr/local/bin:/usr/bin:/bin CAMPFIRE_STORAGE_PATH='$ROOT/storage' \
  CAMPFIRE_RESPONSE_CACHE_MB=0 CAMPFIRE_FRAGMENT_CACHE_MB=0 HTTP_PORT=$((PORT - 1)) TARGET_PORT=$PORT JOB_CONCURRENCY=1 '$BIN' server"

! (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null || { echo "port $PORT already in use"; exit 2; }
cd "$ROOT"
asu env -i "${ENVV[@]}" bin/rails db:schema:load >/dev/null
asu env -i "${ENVV[@]}" ORACLE_OUT="$W/out" ORACLE_TARGET=http://127.0.0.1:$PORT ORACLE_TARGET_NAME="rust@$(git -c safe.directory="*" -C "$SRC" rev-parse --short HEAD)$(git -c safe.directory="*" -C "$SRC" diff --quiet || echo +patch)" \
  ORACLE_SERVER_CMD="$SERVER" ORACLE_SERVER_LOG="$W/server.log" bin/rails runner "$W/oracle.rb" "$W"/scenarios/*.json || true
mkdir -p "$OUT"
cp "$W"/out/*.json "$OUT/" 2>/dev/null || true
echo "replays: $OUT ($(ls "$OUT" | wc -l))"
