#!/usr/bin/env bash
# Serves a copy of the native Rails Campfire (ONCE Campfire 90b3300, ~ben/linuxbench) on a
# loopback port, for H10 (docs/H10-PROTOCOL.md).
#   bash h10/rails-serve.sh <app-dir> <data-dir> <port> [fresh|migrate]
# fresh: an empty database from the app's schema. migrate: the data dir's database, migrated.
# It prints the time to serving. Secrets are generated per run and never written to the repo.
set -euo pipefail
APP=$1; DATA=$2; PORT=$3; MODE=${4:-fresh}
L=$HOME/linuxbench
mkdir -p "$DATA/db" "$DATA/logs" "$DATA/files"
rm -rf "$APP/storage"; ln -s "$DATA" "$APP/storage"
# loopback only
sed -i 's|^bind "tcp://0.0.0.0:#{PORT}"|bind "tcp://127.0.0.1:#{PORT}"|' "$APP/config/puma.rb"
SECRET_FILE=$DATA/secret_key_base
test -s "$SECRET_FILE" || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SECRET_FILE"
ENVV=(LANG=C.UTF-8 HOME=$HOME USER=$USER RAILS_ENV=production DISABLE_SSL=1 SECRET_KEY_BASE=$(cat "$SECRET_FILE")
      PATH=$L/rails/bundle/bin:$L/ruby-3.4.10/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      GEM_HOME=$L/rails/bundle BUNDLE_APP_CONFIG=$L/rails/bundle BUNDLE_SILENCE_ROOT_WARNING=1 BUNDLE_DEPLOYMENT=1
      BUNDLE_PATH=$L/rails/bundle BUNDLE_WITHOUT=development APP_VERSION=h10 PORT=$PORT
      GIT_REVISION=90b330024dec3e757c79b6a7e6568f93da8e3148 RAILS_LOG_LEVEL=warn WEB_CONCURRENCY=0)
cd "$APP"
t0=$(date +%s%N)
if [ "$MODE" = fresh ]; then env -i "${ENVV[@]}" bin/rails db:schema:load >/dev/null
else env -i "${ENVV[@]}" bin/rails db:migrate >/dev/null; fi
(env -i "${ENVV[@]}" setsid bin/rails server -p "$PORT" -b 127.0.0.1 > "$DATA/logs/server.log" 2>&1 &)
for i in $(seq 1 1200); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/up" 2>/dev/null && break; sleep 0.1; done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/up" || { tail -20 "$DATA/logs/server.log"; exit 3; }
echo "rails serving on $PORT after $(( ($(date +%s%N) - t0) / 1000000 )) ms ($MODE)"
