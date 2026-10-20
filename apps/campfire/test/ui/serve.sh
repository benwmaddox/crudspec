#!/usr/bin/env bash
# Serves Rails Campfire (ONCE Campfire 90b3300, the native install) and crudspec's Campfire side
# by side on loopback ports, each from an empty database, for the UI parity tests (ui.test.ts).
#   wsl -e bash /mnt/d/code/crudspec/apps/campfire/test/ui/serve.sh [rails-port] [spec-port]
# Redis (Action Cable) is started on loopback if it isn't running. Secrets are made per run.
set -euo pipefail
RP=${1:-3101}; SP=${2:-3102}
REPO=/mnt/d/code/crudspec
W=$HOME/ui-parity; mkdir -p "$W"
bash "$REPO/h10/stop-port.sh" "$RP" >/dev/null 2>&1 || true
bash "$REPO/h10/stop-port.sh" "$SP" >/dev/null 2>&1 || true
redis-cli ping >/dev/null 2>&1 || (redis-server --bind 127.0.0.1 --port 6379 --save "" --appendonly no --daemonize yes >/dev/null)
# Rails: a fresh copy of the app, an empty database
rm -rf "$W/rails" && mkdir -p "$W/rails" && cp -a "$HOME/linuxbench/rails/app" "$W/rails/app"
bash "$REPO/h10/rails-serve.sh" "$W/rails/app" "$W/rails/data" "$RP" fresh
# crudspec: built from the spec, an empty database
rm -rf "$W/spec" && mkdir -p "$W/spec"
bash "$REPO/h10/spec-serve.sh" apps/campfire/campfire.crud "$W/spec/build" "$W/spec/data" "$SP" fresh
