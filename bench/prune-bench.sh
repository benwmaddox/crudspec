#!/usr/bin/env bash
# column pruning on vs off (bench/README.md): the same binary, uncached and with the fragment cache, two passes
# (the second in reverse order). Run as root with GOBIN set, and PAGE, COOKIE, ASSETS, SNAPDATA and
# NO_VALIDATE=1 for an app other than Campfire:  bash bench/prune-bench.sh <tag>
set -u
B=/mnt/d/code/crudspec/bench; T=${1:-prune1}
runs=("off on" "off 0" "frag on" "frag 0")
order=("${runs[@]}"); rev=(); for ((i=${#runs[@]}-1; i>=0; i--)); do rev+=("${runs[$i]}"); done
for pass in 1 2; do
  [ $pass = 1 ] && list=("${order[@]}") || list=("${rev[@]}")
  for r in "${list[@]}"; do
    set -- $r; mode=$1; pr=$2; name="$T-$mode-prune$pr-p$pass"
    if [ $mode = off ]; then env NO_CACHE=1 $( [ $pr = 0 ] && echo PRUNE=0 ) bash $B/crudspec-lifetime.sh "$name" 20 16 32 64
    else env NO_PAGE_CACHE=1 $( [ $pr = 0 ] && echo PRUNE=0 ) bash $B/crudspec-lifetime.sh "$name" 20 16 32 64; fi
  done
done
echo ALLDONE
