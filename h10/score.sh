#!/usr/bin/env bash
# Scores one H10 run (docs/H10-PROTOCOL.md): hand work, acceptance on a fresh database,
# preservation, and the upgrade on production data. Writes h10/results/<run>/.
#   bash h10/score.sh <spec|rails> <run> <task> <port>
#   (the Rails arm's preservation needs root: it is run separately, h10/rails-preserve.sh)
set -uo pipefail
ARM=$1; RUN=$2; TASK=$3; PORT=$4
REPO=/mnt/d/code/crudspec; H=$REPO/h10
WS=/mnt/d/code/h10-runs/$RUN
OUT=$H/results/$RUN; mkdir -p "$OUT"
# hand work: what changed besides the spec
if [ "$ARM" = spec ]; then
  { echo "spec lines changed: $(diff "$REPO/apps/campfire/campfire.crud" "$WS/campfire.crud" | grep -c '^[<>]')"
    diff -q "$REPO/apps/campfire/widgets.go" "$WS/widgets.go" >/dev/null || echo "changed: widgets.go"
    (cd "$REPO/lang" && find . -type f -not -path '*/node_modules/*' -not -path './browser/*' | sort) > /tmp/h10-lang-a
    (cd "$WS/lang" && find . -type f | sort) > /tmp/h10-lang-b
    diff /tmp/h10-lang-a /tmp/h10-lang-b | grep '^[<>]' | sed 's/^/lang file list: /'
    while read f; do [ -f "$WS/lang/$f" ] && ! cmp -s "$REPO/lang/$f" "$WS/lang/$f" && [ "$f" != ./README.md ] && echo "changed: lang/$f"; done < /tmp/h10-lang-a
    ls "$WS" | grep -v -x -e WORKSPACE.md -e campfire.crud -e widgets.go -e lang -e tools | sed 's/^/added: /'
  } > "$OUT/handwork.txt"
  diff -u "$REPO/apps/campfire/campfire.crud" "$WS/campfire.crud" > "$OUT/change.diff"
else
  (cd /tmp && diff -r -q "$HOME/linuxbench/rails/app" "$WS/app" -x storage -x log -x tmp 2>/dev/null | grep -v 'config/puma.rb') > "$OUT/handwork.txt"
  diff -r -u "$HOME/linuxbench/rails/app" "$WS/app" -x storage -x log -x tmp > "$OUT/change.diff" 2>/dev/null
fi
# acceptance on a fresh database
bash $H/stop-port.sh "$PORT"
if [ "$ARM" = spec ]; then
  rm -rf "$HOME/h10-score/$RUN"
  bash $H/spec-serve.sh "$WS/campfire.crud" "$HOME/h10-score/$RUN/build" "$HOME/h10-score/$RUN/data" "$PORT" fresh > "$OUT/serve.txt" 2>&1
else
  rm -rf "$HOME/h10-score/$RUN"; mkdir -p "$HOME/h10-score/$RUN"; cp -a "$WS/app" "$HOME/h10-score/$RUN/app"
  bash $H/rails-serve.sh "$HOME/h10-score/$RUN/app" "$HOME/h10-score/$RUN/data" "$PORT" fresh > "$OUT/serve.txt" 2>&1
fi
cmd.exe /c "node D:\\code\\crudspec\\h10\\accept.mjs http://127.0.0.1:$PORT $TASK D:\\code\\crudspec\\h10\\results\\$RUN\\accept.json" > /dev/null 2>&1
bash $H/stop-port.sh "$PORT"
# preservation (spec arm here)
[ "$ARM" = spec ] && bash $H/spec-preserve.sh "$WS/campfire.crud" "$PORT" > "$OUT/preserve.txt" 2>&1
# the upgrade on production data
bash $H/upgrade.sh "$ARM" "$WS" "$TASK" "$PORT" > "$OUT/upgrade.txt" 2>&1
cp "$HOME/h10-upgrade/$RUN/time.txt" "$HOME/h10-upgrade/$RUN/data.json" "$OUT/" 2>/dev/null
echo "scored $RUN: $(node -e "const r=require('$OUT/accept.json');console.log('accepted', r.pass, r.checks.map(c=>c.pass?'P':'f').join(''))" 2>/dev/null) | $(tail -1 "$OUT/preserve.txt" 2>/dev/null) | $(cat "$OUT/time.txt" 2>/dev/null | tail -1) | data $(cat "$OUT/data.json" 2>/dev/null)"
