#!/usr/bin/env bash
# Runs the baseline's test suite for the crates that hold the slice, with timings.
set -euo pipefail
cd "$HOME/linuxbench/crudspec-baseline/src"
start=$(date +%s)
cargo test -p campfire -p campfire_db --no-fail-fast 2>&1 | tee "$HOME/linuxbench/crudspec-baseline/test-$(date +%Y%m%dT%H%M%S).log" | grep -E "^test result|error\[|FAILED|panicked" | tail -40
echo "elapsed $(( $(date +%s) - start ))s"
