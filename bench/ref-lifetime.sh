# The Rails and Rust Campfire references under the same protocol as bench/crudspec-lifetime.sh: one
# server at a time, in an isolated network namespace (lo only) and its own cgroup v2, pinned to
# SRV_CPUS; the load generator on LG_CPUS; a sweep of connection counts, every response checked
# against the room_show contract. Copied from AgentLang's linux-bench-273/native-lifetime.sh (its
# installs, snapshot and contract are used read-only); that one measured a single 16-connection window.
# cache: off (none), frag (fragment caches only: Rails' Redis message fragments, Rust's fragment
# cache) or full (Rust's response cache too; Rails has none beyond its fragments).
# Run as root:  wsl -d Ubuntu -u root -- bash /mnt/d/code/crudspec/bench/ref-lifetime.sh <rails|rust> <run-name> <off|frag|full> [secs] [conns...]
# Never run with bash -x: the environment carries secrets.
set -euo pipefail
APP=$1; RUN=$2; MODE=${3:-off}; SECS=${4:-10}; shift 4 || shift $#; CONNS=("$@"); [ ${#CONNS[@]} -eq 0 ] && CONNS=(16 32 64)
case "$MODE" in off) CACHE=off;; frag|full) CACHE=on;; *) echo "cache must be off, frag or full"; exit 2;; esac
U=ben; UH=/home/$U; L=$UH/linuxbench
H=/mnt/d/code/AgentLang/.agentlang/once-campfire-verification
M=/mnt/d/code/AgentLang/.agentlang/campfire-matched-258
OUT=/mnt/d/code/crudspec/bench/runs/$RUN
FLOWBIN=${FLOWBIN:-$UH/linuxbench/flowhttp/campfire/flow_http_server}
W=$L/runs/$RUN; P=$L/private/$RUN
NS=lb273; CG=/sys/fs/cgroup/lb273-srv
SRV_CPUS=${SRV_CPUS:-8-11}; LG_CPUS=${LG_CPUS:-12-19}
LGBIN=$UH/cm258/loadgen-linux/release/loadgen
case "$APP" in rails|rust|flow) ;; *) echo "app must be rails, rust or flow"; exit 2;; esac
# flow: the Campfire Flow server (AgentLang scripts/Build-CampfireFlowServer.ps1 -Target linux-x64)
# on a fresh copy of the Rails-login snapshot DB with that snapshot's cookie (it cannot log in:
# no bcrypt), one worker per SRV_CPUS vCPU, pinned. CACHE on/off sets its process-wide
# fragment cache budget (--cache-mb ${FLOW_CACHE_MB:-32} / 0).
SNAP=${SNAP:-snap-nc}
test ! -e "$OUT" && test ! -e "$W" || { echo "immutable run exists"; exit 2; }
test ! -e "$CG" || { echo "cgroup $CG exists (another lifetime running?)"; exit 2; }
if ss -ltnH | awk '{print $4}' | grep -qE ':(13774|13775|6379)$'; then echo "host port busy"; exit 2; fi
mkdir -p "$OUT"; setpriv --reuid=$U --regid=$U --init-groups mkdir -p -m 700 "$P"
note() { echo "$(date -u +%FT%T.%3NZ) $*" | tee -a "$OUT/driver.log"; }
asu() { setpriv --reuid=$U --regid=$U --init-groups "$@"; }
inns() { nsenter --net=/run/netns/$NS "$@"; }

# Fresh ext4 workspace: storage/{db,files,logs} under the app root, as /rails/storage in the images.
if [ "$APP" = rails ]; then
  ROOT=$W/app; asu mkdir -p "$W"; asu cp -a "$L/rails/app" "$ROOT"
  if [ "$CACHE" = off ]; then asu cp "$M/no-cache-initializer.rb" "$ROOT/config/initializers/zz_benchmark_no_cache.rb"; fi
else
  ROOT=$W; asu mkdir -p "$ROOT"
fi
asu rm -rf "$ROOT/storage"; asu mkdir -p "$ROOT/storage/logs"
if [ "$APP" = flow ]; then
  asu mkdir -p "$ROOT/storage/db"; asu cp "$M/private/native-db-$SNAP/production.sqlite3" "$ROOT/storage/db/production.sqlite3"
else
  asu cp -r "$H/fixtures/default/db" "$ROOT/storage/db"; asu cp -r "$H/fixtures/default/storage" "$ROOT/storage/files"
fi
asu sqlite3 "$ROOT/storage/db/production.sqlite3" "UPDATE push_subscriptions SET endpoint = 'https://127.0.0.1:9/push/' || id; UPDATE webhooks SET url = 'http://127.0.0.1:9/hook/' || id;"

# Environment: image ENV + reference.env (docker --env-file semantics: VAR=VAL verbatim) + the -e flags.
ENVV=(LANG=C.UTF-8 HOME=$UH USER=$U RAILS_ENV=production HTTP_IDLE_TIMEOUT=60 HTTP_READ_TIMEOUT=300 HTTP_WRITE_TIMEOUT=300)
if [ "$APP" = rails ]; then
  ENVV+=(PATH=$L/rails/bundle/bin:$L/ruby-3.4.10/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
         GEM_HOME=$L/rails/bundle BUNDLE_APP_CONFIG=$L/rails/bundle BUNDLE_SILENCE_ROOT_WARNING=1 BUNDLE_DEPLOYMENT=1
         BUNDLE_PATH=$L/rails/bundle BUNDLE_WITHOUT=development LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
         APP_VERSION=verification GIT_REVISION=90b330024dec3e757c79b6a7e6568f93da8e3148)
  CMD=(bin/boot)
elif [ "$APP" = flow ]; then
  ENVV+=(PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)
  # Private config (secret_key_base from reference.env, never printed), mode 600 in the private run dir.
  asu bash -c "umask 077; { printf 'secret_key_base='; grep '^SECRET_KEY_BASE=' '$H/fixtures/default/reference.env' | head -1 | cut -d= -f2- | tr -d '\r\n'; printf '\nauthority=127.0.0.1:13774\n'; } > '$P/config.txt'"
  WORKERS=$(taskset -c "$SRV_CPUS" nproc)
  if [ "$CACHE" = on ]; then FLOW_MB=${FLOW_CACHE_MB:-32}; else FLOW_MB=0; fi
  CMD=("$FLOWBIN" --port 13774 --db "$ROOT/storage/db/production.sqlite3" --config "$P/config.txt" --workers "$WORKERS" --pin --cache-mb "$FLOW_MB")
else
  ENVV+=(PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)
  if [ "$CACHE" = off ]; then ENVV+=(CAMPFIRE_RESPONSE_CACHE_MB=0 CAMPFIRE_FRAGMENT_CACHE_MB=0); fi
  if [ "$MODE" = frag ]; then ENVV+=(CAMPFIRE_RESPONSE_CACHE_MB=0); fi   # its fragment cache alone
  CMD=("$L/rust/bin/campfire" server)
fi
[ "$APP" = flow ] || while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue;; esac; ENVV+=("$line")
done < "$H/fixtures/default/reference.env"
ENVV+=(WEB_CONCURRENCY=${RAILS_WORKERS:-3} JOB_CONCURRENCY=3 RAILS_MAX_THREADS=${RAILS_THREADS:-5} RAILS_LOG_LEVEL=warn HTTP_PORT=13774 TARGET_PORT=13775)

cleanup() {
  if [ -e "$CG" ]; then
    if [ -n "${BOOT:-}" ] && kill -0 "$BOOT" 2>/dev/null; then kill -TERM "$BOOT" 2>/dev/null || true
      for i in $(seq 1 300); do [ "$(wc -l < "$CG/cgroup.procs")" -le 1 ] && ! grep -qv "^$BOOT$" "$CG/cgroup.procs" && break; sleep 0.1; done; fi
    [ -n "${BOOT:-}" ] && { kill -0 "$BOOT" 2>/dev/null && kill -KILL "$BOOT" 2>/dev/null; wait "$BOOT" 2>/dev/null || true; }
    if [ -s "$CG/cgroup.procs" ]; then echo 1 > "$CG/cgroup.kill"; note "cleanup: cgroup.kill needed"; fi
    for i in $(seq 1 100); do grep -q "populated 0" "$CG/cgroup.events" && break; sleep 0.1; done
    rmdir "$CG" 2>/dev/null || note "cleanup: could not remove $CG"
  fi
  ip netns del $NS 2>/dev/null || true
  [ -f "$W/server.log" ] && cp "$W/server.log" "$OUT/server.log"
  grep -ciE 'session_token=|_campfire_session=|password|secret_key' "$OUT/server.log" > "$OUT/server-log-secret-scan.txt" 2>/dev/null || true
  echo "$(date -u +%FT%T.%3NZ) cleanup done; host listeners on 13774/13775/6379: $(ss -ltnH | awk '{print $4}' | grep -cE ':(13774|13775|6379)$' || true)" >> "$OUT/driver.log"
}
trap cleanup EXIT

ip netns add $NS; ip -n $NS link set lo up
mkdir "$CG"; echo "$SRV_CPUS" > "$CG/cpuset.cpus"   # a hard pin: a process that resets its affinity stays on these
( cd "$ROOT"; echo $BASHPID > "$CG/cgroup.procs"
  exec nsenter --net=/run/netns/$NS taskset -c "$SRV_CPUS" setpriv --reuid=$U --regid=$U --init-groups env -i "${ENVV[@]}" "${CMD[@]}" ) \
  > "$W/server.log" 2>&1 &
BOOT=$!
if [ "$APP" = flow ]; then
  # No /up route: the portable host prints READY once every worker is listening.
  for i in $(seq 1 1200); do grep -q '^READY ' "$W/server.log" 2>/dev/null && break; sleep 0.1; done
  grep -q '^READY ' "$W/server.log" || { note "not ready"; tail -20 "$W/server.log"; exit 3; }
else
  for i in $(seq 1 1200); do inns curl -fsS -o /dev/null http://127.0.0.1:13774/up 2>/dev/null && break; sleep 0.1; done
  inns curl -fsS -o /dev/null http://127.0.0.1:13774/up || { note "not ready"; tail -20 "$W/server.log"; exit 3; }
fi
note "ready app=$APP cache=$CACHE run=$RUN boot_pid=$BOOT procs=$(wc -l < "$CG/cgroup.procs") ns_listeners=$(inns ss -ltnH | awk '{print $4}' | tr '\n' ' ') host_listeners_13774_13775_6379=$(ss -ltnH | awk '{print $4}' | grep -cE ':(13774|13775|6379)$' || true)"
ps -o pid,psr,comm,args -p "$(paste -sd, "$CG/cgroup.procs")" | cut -c1-110 > "$OUT/procs-ready.txt"
for pid in $(cat "$CG/cgroup.procs"); do echo "$pid $(taskset -cp "$pid" 2>/dev/null | awk '{print $NF}')"; done > "$OUT/affinity.txt"
if [ "$APP" = rails ]; then
  # Same env, one-off runner: confirms YJIT gets enabled by Rails and jemalloc is preloaded (booleans only).
  note "runner_yjit_jemalloc=$(cd "$ROOT" && inns taskset -c "$SRV_CPUS" setpriv --reuid=$U --regid=$U --init-groups env -i "${ENVV[@]}" bin/rails runner 'print RubyVM::YJIT.enabled?, " ", File.read("/proc/self/maps").include?("jemalloc")' 2>/dev/null | tail -c 40)"
  for pid in $(pgrep -f "puma: cluster worker" | head -3); do grep -q " $pid$" <(sed 's/^/ /' "$CG/cgroup.procs") && echo "worker $pid jemalloc_mapped=$(grep -c jemalloc /proc/$pid/maps)"; done >> "$OUT/affinity.txt"
fi
sleep 3

LJ() { ruby -rjson -e 'print JSON.parse(File.read(ARGV[0]))[ARGV[1]]' "$H/fixtures/default/labels.json" "$1"; }
ROOM=$(LJ rooms.watercooler)
LG() { inns taskset -c "$LG_CPUS" setpriv --reuid=$U --regid=$U --init-groups "$LGBIN" "$@"; }
if [ "$APP" = flow ]; then
  # Room route only: the snapshot's Rails session cookie, no login/scrape/contracts.rb
  # (every response is still validated against the canonical room_show contract below).
  COOKIE=$(tr -d '\r\n' < "$M/private/rails-cookie-$SNAP.txt")
  note "flow: snapshot=$SNAP cookie from snapshot; contracts.rb skipped (room route only)"
else
EMAIL=$(LJ emails.david); PASS=$(LJ passwords.all)
COOKIE=$(LG login --base http://127.0.0.1:13774 --email "$EMAIL" --password "$PASS" | ruby -rjson -e 'print JSON.parse(STDIN.read)["cookie"]')
unset PASS
CSS=$(LG scrape --base http://127.0.0.1:13774 --cookie "$COOKIE" --room "$ROOM" | ruby -rjson -e 'print JSON.parse(STDIN.read)["css"]')
inns setpriv --reuid=$U --regid=$U --init-groups ruby "$H/bench/contracts.rb" http://127.0.0.1:13774 "$COOKIE" "$ROOT/storage/db/production.sqlite3" "$H/fixtures/default/labels.json" "$CSS" "$P/contracts" > /dev/null 2> "$OUT/contracts.err.log" || true
note "contracts.rb files=$(ls "$P/contracts" 2>/dev/null | wc -l) stderr_lines=$(wc -l < "$OUT/contracts.err.log")"
ruby -rjson -e 'a=JSON.parse(File.read(ARGV[0])); b=JSON.parse(File.read(ARGV[1])); ok = a["message_ids"]==b["message_ids"] && a["message_content"]==b["message_content"]; puts "own room_show contract matches canonical ids+content: #{ok} ids=#{a["message_ids"].length} required_equal=#{a["required"]==b["required"]}"; exit(ok ? 0 : 1)' "$P/contracts/room_show.json" "$M/contracts-preflight-1/room_show.json" | tee -a "$OUT/driver.log"
fi
for n in 1 2; do LG fetch --base http://127.0.0.1:13774 --cookie "$COOKIE" --path "/rooms/$ROOM" --out "$P/body$n.html" > /dev/null; done
note "decoded_bytes=$(stat -c %s "$P/body1.html") body_constant=$(cmp -s "$P/body1.html" "$P/body2.html" && echo yes || echo no)"
cg_usec() { awk '$1=="usage_usec"{print $2}' "$CG/cpu.stat"; }
redis_keys() { inns redis-cli -p 6379 dbsize 2>/dev/null || echo n/a; }
[ "$APP" = rails ] && note "redis_keys_before_warmup=$(redis_keys)"
LG http --base http://127.0.0.1:13774 --cookie "$COOKIE" --path "/rooms/$ROOM" --validate "$M/contracts-preflight-1/room_show.json" --conc 4 --duration ${WARMUP:-10} --gzip 0 > "$OUT/warmup-gzip0.json"
note "warmup $(cut -c1-300 "$OUT/warmup-gzip0.json")"
# the sweep: one measured window per connection count, as bench/crudspec-lifetime.sh measures
NCPU=$(taskset -c "$SRV_CPUS" nproc); NLG=$(taskset -c "$LG_CPUS" nproc)
for C in "${CONNS[@]}"; do
  S0=$(cg_usec)
  /usr/bin/time -f "%U %S" -o "$P/client-$C.txt" \
    nsenter --net=/run/netns/$NS taskset -c "$LG_CPUS" setpriv --reuid=$U --regid=$U --init-groups "$LGBIN" http --base http://127.0.0.1:13774 --cookie "$COOKIE" --path "/rooms/$ROOM" --validate "$M/contracts-preflight-1/room_show.json" --conc "$C" --duration "$SECS" --gzip 0 > "$OUT/cell-$C.json"
  S1=$(cg_usec)
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const [u, s] = require("fs").readFileSync(process.argv[2], "utf8").trim().split(" ").map(Number);
    const cpu = (Number(process.argv[3]) - Number(process.argv[4])) / 1e6, secs = r.secs ?? Number(process.argv[5]);   // as long as the load generator ran: past the window for queued requests
    const ok = r.ok ?? 0;
    console.log(JSON.stringify({ conns: Number(process.argv[6]), ok, errors: r.errors ?? r.failed ?? null, invalid: r.invalid ?? null, rps: +(ok / secs).toFixed(1),
      cpu_ms_per_req: +(cpu * 1000 / Math.max(1, ok)).toFixed(3), server_util: +(cpu / (secs * Number(process.argv[7]))).toFixed(2),
      client_util: +((u + s) / (secs * Number(process.argv[8]))).toFixed(2), p50: r.p50_ms ?? r.latency?.p50 ?? null, p99: r.p99_ms ?? r.latency?.p99 ?? null }));
  ' "$OUT/cell-$C.json" "$P/client-$C.txt" "$S1" "$S0" "$SECS" "$C" "$NCPU" "$NLG" | tee -a "$OUT/summary.jsonl"
done
# PSS summed over every process in the server cgroup, grouped by command.
for pid in $(cat "$CG/cgroup.procs"); do
  printf '%s\t%s\n' "$(cat /proc/$pid/comm 2>/dev/null)" "$(awk '/^Pss:/{print $2}' /proc/$pid/smaps_rollup 2>/dev/null)"
done | awk -F'\t' '$2!=""{s[$1]+=$2; n[$1]++; t+=$2} END{for(k in s) printf "%s x%d %.1fMB; ", k, n[k], s[k]/1024; printf "TOTAL_PSS_MB=%.1f\n", t/1024}' | tee -a "$OUT/pss.txt" | sed 's/^/pss: /' | tee -a "$OUT/driver.log"
[ "$APP" = rails ] && note "redis_keys_after=$(redis_keys)"
unset COOKIE
kill -TERM "$BOOT"; T0=$(date +%s.%N)
for i in $(seq 1 300); do kill -0 "$BOOT" 2>/dev/null || break; sleep 0.1; done
wait "$BOOT" && RC=0 || RC=$?
# Docker semantics: when the container's PID 1 exits, everything else in it is killed.
LEFT=$(wc -l < "$CG/cgroup.procs"); [ "$LEFT" -gt 0 ] && echo 1 > "$CG/cgroup.kill"
for i in $(seq 1 50); do [ -s "$CG/cgroup.procs" ] || break; sleep 0.1; done
note "stopped exit=$RC secs=$(ruby -e "printf('%.1f', $(date +%s.%N)-$T0)") killed_after_pid1_exit=$LEFT"
