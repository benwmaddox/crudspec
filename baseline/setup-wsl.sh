#!/usr/bin/env bash
# Pins the baseline: the hand-written Rust port of Campfire (once-campfire-rust) at 6dae2fd,
# cloned from the local copy used by AgentLang. Its reference/ submodule is the Rails app
# (ONCE Campfire 90b3300), which the asset build reads. Run as user ben inside WSL.
set -euo pipefail
B=$HOME/linuxbench/crudspec-baseline
SRC=/mnt/d/code/AgentLang/.agentlang/campfire-reference
if [ ! -d "$B/src" ]; then
  mkdir -p "$B"
  git clone -q "$SRC" "$B/src"
fi
cd "$B/src"
git checkout -q 6dae2fd
if [ ! -f reference/Gemfile ]; then
  git -c protocol.file.allow=always submodule update --init reference 2>/dev/null \
    || { rm -rf reference; git clone -q "$SRC/reference" reference; }
fi
git -C reference checkout -q 90b330024dec3e757c79b6a7e6568f93da8e3148
git log -1 --format="baseline %h %s"
git -C reference log -1 --format="reference %h %s"
