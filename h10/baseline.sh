#!/usr/bin/env bash
# The acceptance checks against both unmodified apps: the shared steps must pass on both, and
# each task's checks must fail on both (docs/H10-PROTOCOL.md, step 1).
#   bash h10/baseline.sh   (from Windows: wsl -e bash /mnt/d/code/crudspec/h10/baseline.sh)
set -uo pipefail
H=/mnt/d/code/crudspec/h10
OUT=$H/baseline; mkdir -p "$OUT"
for task in topic pin display; do
  bash $H/stop-port.sh 13861; bash $H/stop-port.sh 13862
  rm -rf ~/h10-base && mkdir -p ~/h10-base && cp -a ~/linuxbench/rails/app ~/h10-base/app
  bash $H/rails-serve.sh ~/h10-base/app ~/h10-base/rails-data 13861 fresh
  bash $H/spec-serve.sh /mnt/d/code/crudspec/apps/campfire/campfire.crud ~/h10-base/spec-build ~/h10-base/spec-data 13862 fresh
  echo "$task" > "$OUT/.task"
  cmd.exe /c "node D:\\code\\crudspec\\h10\\accept.mjs http://127.0.0.1:13861 $task D:\\code\\crudspec\\h10\\baseline\\rails-$task.json" > /dev/null 2>&1
  cmd.exe /c "node D:\\code\\crudspec\\h10\\accept.mjs http://127.0.0.1:13862 $task D:\\code\\crudspec\\h10\\baseline\\spec-$task.json" > /dev/null 2>&1
done
bash $H/stop-port.sh 13861; bash $H/stop-port.sh 13862
