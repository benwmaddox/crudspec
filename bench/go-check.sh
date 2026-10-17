# Every check against the compiled Campfire: equity (42 scenarios), screens, the agent e2e.
set -e
cd /mnt/d/code/crudspec
bash bench/go-test.sh 13801 > /dev/null
for p in "smoke smoke-10" "slice-v1 slice-v1-e" "checker-findings findings-1" "v2-areas v2-areas-h"; do set -- $p
  node apps/campfire/test/replay-runtime.ts apps/campfire/campfire.crud http://127.0.0.1:13801 apps/campfire/oracle/scenarios/$1 apps/campfire/oracle/golden/$2 2>&1 | grep -v -i "experimental\|trace-warn" | tail -3; done
