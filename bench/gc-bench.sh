#!/usr/bin/env bash
# The garbage collector's settings against memory and speed (bench/README.md): one binary, each
# setting uncached and with the fragment cache, two passes (the second in reverse order).
# Run as root with GOBIN set:  bash bench/gc-bench.sh <tag>
# A setting is "name GOGC GOMEMLIMIT", "-" for unset (unset GOGC: the app's own 400 and 512 MiB).
set -u
B=/mnt/d/code/crudspec/bench; T=${1:-gc1}
settings=(${SETTINGS:-"app - -" "gc100 100 -" "gc400lim64 400 64MiB"})
runs=(); for s in "${settings[@]}"; do for mode in off frag; do runs+=("$mode $s"); done; done
rev=(); for ((i=${#runs[@]}-1; i>=0; i--)); do rev+=("${runs[$i]}"); done
# another benchmark on these cores (AgentLang's sweeps) spoils both: wait for it to finish
busy() { pgrep -f "loadgen http|sweep-lifetime|crudspec-lifetime|/tmp/abba.sh|reopen-300/abba.sh" > /dev/null; }   # (their drivers too: between runs)
for pass in 1 2; do
  [ $pass = 1 ] && list=("${runs[@]}") || list=("${rev[@]}")
  for r in "${list[@]}"; do
    set -- $r; mode=$1; name=$2; gogc=$3; lim=$4; run="$T-$mode-$name-p$pass"
    while busy; do sleep 10; done
    env $( [ $mode = off ] && echo NO_CACHE=1 || echo NO_PAGE_CACHE=1 ) \
      $( [ $gogc != - ] && echo GOGC=$gogc ) $( [ $lim != - ] && echo GOMEMLIMIT=$lim ) \
      bash $B/crudspec-lifetime.sh "$run" 20 16 32 64
  done
done
echo ALLDONE
