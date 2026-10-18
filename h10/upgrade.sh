#!/usr/bin/env bash
# H10's upgrade measure (docs/H10-PROTOCOL.md): an arm's changed app, on a copy of the same
# production data, from the change being saved to the app serving again; with the rows counted
# before and after.
#   bash h10/upgrade.sh spec  <workspace> <task> <port>
#   bash h10/upgrade.sh rails <workspace> <task> <port>
set -uo pipefail
ARM=$1; WS=$2; TASK=$3; PORT=$4
H=/mnt/d/code/crudspec/h10
RAILSDB=/mnt/d/code/AgentLang/.agentlang/campfire-matched-258/private/native-db-nc-set1-1-native/production.sqlite3
SPECDATA=/mnt/d/code/crudspec-run/bench-snap-nc   # the same data, imported (bench/import-rails.ts)
R=$HOME/h10-upgrade/$(basename "$WS"); rm -rf "$R"; mkdir -p "$R"
bash $H/stop-port.sh "$PORT"
if [ "$ARM" = spec ]; then
  cp -a "$SPECDATA" "$R/data"; rm -f "$R/data/app.lock"
  DB=$R/data/app.sqlite
  node $H/data.mjs counts "$DB" "$R/before.json" > /dev/null
  # the workspace's own copy of the language is what it was given: the build uses the repo's
  bash $H/spec-serve.sh "$WS/campfire.crud" "$R/build" "$R/data" "$PORT" migrate 2>&1 | tail -3 | tee "$R/time.txt"
else
  cp -a "$WS/app" "$R/app"
  mkdir -p "$R/data/db"; cp "$RAILSDB" "$R/data/db/production.sqlite3"
  DB=$R/data/db/production.sqlite3
  node $H/data.mjs counts "$DB" "$R/before.json" > /dev/null
  bash $H/rails-serve.sh "$R/app" "$R/data" "$PORT" migrate 2>&1 | tail -3 | tee "$R/time.txt"
fi
node $H/data.mjs counts "$DB" "$R/after.json" > /dev/null
node $H/data.mjs compare "$R/before.json" "$R/after.json" "$DB" "$TASK" | tee "$R/data.json"
bash $H/stop-port.sh "$PORT"
