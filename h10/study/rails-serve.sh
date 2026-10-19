#!/usr/bin/env bash
# The study's Rails serve (docs/H10-STUDY-PROTOCOL.md): h10/rails-serve.sh plus what the study's
# tasks need, the same for every run: its own Redis (Action Cable, Resque) and a Resque worker
# for jobs; mail to the harness's mail server; the movable clock (config/initializers/h10_harness.rb).
#   bash h10/study/rails-serve.sh <app> <data-dir> <port> [fresh|migrate]
# Environment: SMTP_PORT (the harness's mail server, default 2525).
set -euo pipefail
APP=$1; DATA=$2; PORT=$3; MODE=${4:-fresh}
L=$HOME/linuxbench
RPORT=$((PORT + 10000))
mkdir -p "$DATA/db" "$DATA/logs" "$DATA/files"
cp /mnt/d/code/crudspec/h10/study/rails/h10_harness.rb "$APP/config/initializers/h10_harness.rb"
rm -rf "$APP/storage"; ln -s "$DATA" "$APP/storage"
sed -i 's|^bind "tcp://0.0.0.0:#{PORT}"|bind "tcp://127.0.0.1:#{PORT}"|' "$APP/config/puma.rb"
SECRET_FILE=$DATA/secret_key_base
test -s "$SECRET_FILE" || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SECRET_FILE"
redis-cli -p "$RPORT" shutdown nosave >/dev/null 2>&1 || true
redis-server --port "$RPORT" --bind 127.0.0.1 --save "" --appendonly no --daemonize yes --logfile "$DATA/logs/redis.log" >/dev/null
for i in $(seq 1 50); do redis-cli -p "$RPORT" ping >/dev/null 2>&1 && break; sleep 0.1; done
ENVV=(LANG=C.UTF-8 HOME=$HOME USER=$USER RAILS_ENV=production DISABLE_SSL=1 SECRET_KEY_BASE=$(cat "$SECRET_FILE")
      PATH=$L/rails/bundle/bin:$L/ruby-3.4.10/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      GEM_HOME=$L/rails/bundle BUNDLE_APP_CONFIG=$L/rails/bundle BUNDLE_SILENCE_ROOT_WARNING=1 BUNDLE_DEPLOYMENT=1
      BUNDLE_PATH=$L/rails/bundle BUNDLE_WITHOUT=development APP_VERSION=h10 PORT=$PORT
      GIT_REVISION=90b330024dec3e757c79b6a7e6568f93da8e3148 RAILS_LOG_LEVEL=warn WEB_CONCURRENCY=0
      REDIS_URL=redis://127.0.0.1:$RPORT SMTP_ADDRESS=127.0.0.1 SMTP_PORT=${SMTP_PORT:-2525} MAIL_FROM=campfire@h10.test
      APP_URL=http://127.0.0.1:$PORT H10_CLOCK_FILE=$DATA/h10_clock TZ=America/New_York)
cd "$APP"
t0=$(date +%s%N)
if [ "$MODE" = fresh ]; then rm -f "$DATA/h10_clock"; env -i "${ENVV[@]}" bin/rails db:schema:load >/dev/null
else env -i "${ENVV[@]}" bin/rails db:migrate >/dev/null; fi
(env -i "${ENVV[@]}" setsid bin/rails server -p "$PORT" -b 127.0.0.1 > "$DATA/logs/server.log" 2>&1 < /dev/null &)
(env -i "${ENVV[@]}" QUEUE='*' INTERVAL=0.5 setsid bin/rails resque:work > "$DATA/logs/worker.log" 2>&1 < /dev/null &)
for i in $(seq 1 1200); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/up" 2>/dev/null && break; sleep 0.1; done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/up" || { tail -20 "$DATA/logs/server.log"; exit 3; }
echo "rails serving on $PORT after $(( ($(date +%s%N) - t0) / 1000000 )) ms ($MODE; redis $RPORT, a Resque worker)"
