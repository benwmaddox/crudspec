# The fair comparison: crudspec, Rails and Rust Campfire on the room page, each uncached, with
# fragment caches only, and fully cached (crudspec's page cache, Rust's response cache), under one
# protocol (bench/crudspec-lifetime.sh and bench/ref-lifetime.sh): the server pinned to vCPUs 8-11 (its cgroup's cpuset),
# the load generator to 12-21, a 10 s warmup, a sweep of 16/32/64/128 connections for SECS each,
# every response checked. Two passes, the second in reverse order, so drift favours no one.
# Run as root:  wsl -d Ubuntu -u root -- env GOBIN=<compiled Campfire> bash /mnt/d/code/crudspec/bench/fair-run.sh <tag> [secs]
set -u
TAG=$1; SECS=${2:-20}; B=/mnt/d/code/crudspec/bench
export LG_CPUS=12-21 WARMUP=10 RAILS_WORKERS=${RAILS_WORKERS:-4}   # Rails: a Puma worker per vCPU, its fastest here (3 measured slower)
test -n "${GOBIN:-}" || { echo "GOBIN=<the compiled app> is required"; exit 64; }
runs=("crudspec off" "crudspec frag" "crudspec full" "rails off" "rails frag" "rust off" "rust frag" "rust full")
one() {
  local app=$1 mode=$2 pass=$3 run="fair-$TAG-$1-$2-$3"
  echo "== $run"
  if [ "$app" = crudspec ]; then
    case $mode in off) NO_CACHE=1 bash $B/crudspec-lifetime.sh "$run" "$SECS" 16 32 64 128;; frag) NO_PAGE_CACHE=1 bash $B/crudspec-lifetime.sh "$run" "$SECS" 16 32 64 128;; full) bash $B/crudspec-lifetime.sh "$run" "$SECS" 16 32 64 128;; esac
  else
    bash $B/ref-lifetime.sh "$app" "$run" "$mode" "$SECS" 16 32 64 128
  fi
}
for r in "${runs[@]}"; do one $r a; done
for ((i=${#runs[@]}-1; i>=0; i--)); do one ${runs[$i]} b; done
echo "== all done"
