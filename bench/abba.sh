#!/usr/bin/env bash
# Two builds of the room page, interleaved A B B A (so drift over the run falls on both alike),
# uncached and with the fragment cache. Run as root:
#   bash bench/abba.sh <binary A> <binary B> <tag> [modes: "off frag"]
set -u
B=/mnt/d/code/crudspec/bench; A=$1; Bb=$2; T=$3; MODES=${4:-"off frag"}
# another benchmark on these cores (AgentLang's sweeps) spoils both: wait for it to finish
busy() { pgrep -f "loadgen http|sweep-lifetime|crudspec-lifetime|/tmp/abba.sh|reopen-300/abba.sh" > /dev/null; }   # (their drivers too: between runs)
for mode in $MODES; do
  i=0
  for X in A B B A; do
    i=$((i+1)); bin=$A; [ $X = B ] && bin=$Bb
    while busy; do sleep 10; done
    env GOBIN=$bin $( [ $mode = off ] && echo NO_CACHE=1 || echo NO_PAGE_CACHE=1 ) \
      bash $B/crudspec-lifetime.sh "$T-$mode-$i$X" 20 16 32 64 > /dev/null 2>&1
    echo "$T-$mode-$i$X: $(tail -1 $B/runs/$T-$mode-$i$X/pss.txt 2>/dev/null)"
  done
done
echo ALLDONE
