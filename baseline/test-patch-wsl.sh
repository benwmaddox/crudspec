#!/usr/bin/env bash
# H1 baseline arm: runs the Rust port's own test suite with one baseline.patch applied.
#   wsl -d Ubuntu -u ben -- bash /mnt/d/code/crudspec/baseline/test-patch-wsl.sh <patch-wsl-path> <log-wsl-path>
# Exit 0: the tests pass (not caught). Exit 1: a test failed or the build failed (caught).
# Exit 2: the patch doesn't apply (a scoring error, not a catch).
set -uo pipefail
PATCH=$1
LOG=$2
L=$HOME/linuxbench
TREE=$L/crudspec-score
test -d "$TREE" || cp -a "$L/crudspec-baseline/src" "$TREE"
cd "$TREE"
git -c safe.directory='*' checkout -q -- . && git -c safe.directory='*' clean -qfd crates
if ! git -c safe.directory='*' apply "$PATCH"; then
  echo "patch does not apply" > "$LOG"
  exit 2
fi
export PATH=$HOME/.cargo/bin:$PATH
cargo test -p campfire -p campfire_db --no-fail-fast > "$LOG" 2>&1
status=$?
git -c safe.directory='*' checkout -q -- . && git -c safe.directory='*' clean -qfd crates
[ $status -eq 0 ] && exit 0 || exit 1
