#!/usr/bin/env bash
# Stops whatever listens on a loopback port in WSL (H10's servers).
#   bash h10/stop-port.sh <port>
fuser -k -TERM "$1/tcp" >/dev/null 2>&1 || true
for i in $(seq 1 50); do fuser "$1/tcp" >/dev/null 2>&1 || exit 0; sleep 0.1; done
fuser -k -KILL "$1/tcp" >/dev/null 2>&1 || true
