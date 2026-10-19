#!/usr/bin/env bash
# The H10 study's upgrade measure (docs/H10-STUDY-PROTOCOL.md; as h10/upgrade.sh): an arm's changed app, on a copy of the same
# production data, from the change being saved to the app serving again; with the rows counted
# before and after.
#   bash h10/study/upgrade.sh spec  <workspace> <task> <port>
#   bash h10/study/upgrade.sh rails <workspace> <task> <port>
set -uo pipefail
ARM=$1; WS=$2; TASK=$3; PORT=$4
H=/mnt/d/code/crudspec/h10
RAILSDB=/mnt/d/code/AgentLang/.agentlang/campfire-matched-258/private/native-db-nc-set1-1-native/production.sqlite3
SPECDATA=/mnt/d/code/crudspec-run/bench-snap-nc4   # the same data, imported, cleaned, storage format 4
R=$HOME/h10-study-upgrade/$(basename "$WS"); rm -rf "$R"; mkdir -p "$R"
bash $H/stop-port.sh "$PORT"
# Both copies are cleaned the same way first: the snapshot holds rows the spec's rules refuse
# (5 push subscriptions to endpoints it doesn't permit, a message whose user is gone), which
# block any spec upgrade before the change is even looked at (docs/H10-PROTOCOL.md).
clean() { sqlite3 "$1" "DELETE FROM $2 WHERE id IN (56887440, 782661003, 257765087, 283769004, 782661004); DELETE FROM $3 WHERE id = 933434637;"; }
if [ "$ARM" = spec ]; then
  cp -a "$SPECDATA" "$R/data"; rm -f "$R/data/app.lock"
  DB=$R/data/app.sqlite
  clean "$DB" PushSubscription Message
  node $H/data.mjs counts "$DB" "$R/before.json" > /dev/null
  # the workspace's own copy of the language is what it was given: the build uses the repo's
  SMTP_PORT=$((PORT + 20000)) bash $H/study/spec-serve.sh "$WS/campfire.crud" "$R/build" "$R/data" "$PORT" migrate 2>&1 | tail -3 | tee "$R/time.txt"
else
  cp -a "$WS/app" "$R/app"
  mkdir -p "$R/data/db"; cp "$RAILSDB" "$R/data/db/production.sqlite3"
  DB=$R/data/db/production.sqlite3
  clean "$DB" push_subscriptions messages
  node $H/data.mjs counts "$DB" "$R/before.json" > /dev/null
  SMTP_PORT=$((PORT + 20000)) bash $H/study/rails-serve.sh "$R/app" "$R/data" "$PORT" migrate 2>&1 | tail -3 | tee "$R/time.txt"
fi
node $H/data.mjs counts "$DB" "$R/after.json" > /dev/null
node $H/data.mjs compare "$R/before.json" "$R/after.json" "$DB" "$TASK" | tee "$R/data.json"
bash $H/stop-port.sh "$PORT"
