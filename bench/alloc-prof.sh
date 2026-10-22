# Allocations per request and a CPU profile of Campfire's room page, uncached: heap profiles before
# and after a load, compared with pprof -base.   bash bench/alloc-prof.sh <binary> <tag>   (in WSL)
# Server on cores 0-3, load generator on 4-6, so a fair-bench run on 8-21 isn't disturbed.
set -u
export PATH=$PATH:/usr/local/go/bin
BIN=$1; TAG=$2; PORT=13790; O=~/csmem/prof-$TAG; rm -rf $O; mkdir -p $O
rm -rf ~/csmem/data-$TAG && cp -a /mnt/d/code/crudspec-run/bench-snap-nc5 ~/csmem/data-$TAG && rm -f ~/csmem/data-$TAG/app.lock
(CRUDSPEC_PPROF=6061 CRUDSPEC_NO_CACHE=1 TZ=America/New_York setsid taskset -c 0-3 $BIN --data ~/csmem/data-$TAG --assets /mnt/d/code/crudspec-assets/campfire --port $PORT > $O/server.log 2>&1 &)
for i in $(seq 1 100); do curl -fsS -o /dev/null http://127.0.0.1:$PORT/up 2>/dev/null && break; sleep 0.1; done
TOKEN=$(node -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync(process.env.HOME+'/csmem/data-$TAG/app.sqlite').prepare('select token from Session where id = 481019661').get().token)" 2>/dev/null)
LG=~/cm258/loadgen-linux/release/loadgen
curl -s -H "Cookie: session_token=$TOKEN" -o $O/body.html http://127.0.0.1:$PORT/rooms/486777696; echo "bytes $(stat -c %s $O/body.html)"
taskset -c 4-6 $LG http --base http://127.0.0.1:$PORT --cookie "session_token=$TOKEN" --path /rooms/486777696 --conc 4 --duration 5 --gzip 0 > /dev/null
curl -s -o $O/heap0.prof http://127.0.0.1:6061/debug/pprof/allocs
(taskset -c 4-6 $LG http --base http://127.0.0.1:$PORT --cookie "session_token=$TOKEN" --path /rooms/486777696 --conc 4 --duration 12 --gzip 0 > $O/lg.json &)
sleep 1; curl -s -o $O/cpu.prof "http://127.0.0.1:6061/debug/pprof/profile?seconds=8"; sleep 4
curl -s -o $O/heap1.prof http://127.0.0.1:6061/debug/pprof/allocs
N=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$O/lg.json','utf8')).ok)")
echo "requests in heap window ~ $N (+ fetch); rps $(node -e "console.log(JSON.parse(require('fs').readFileSync('$O/lg.json','utf8')).rps)")"
go tool pprof -sample_index=alloc_space -base $O/heap0.prof -top -nodecount=1 $BIN $O/heap1.prof 2>/dev/null | grep -E "^Showing|total" | head -3
go tool pprof -sample_index=alloc_objects -base $O/heap0.prof -top -nodecount=1 $BIN $O/heap1.prof 2>/dev/null | grep -E "total" | head -2
echo "== alloc_space top"; go tool pprof -sample_index=alloc_space -base $O/heap0.prof -top -nodecount=${NA:-25} $BIN $O/heap1.prof 2>/dev/null | tail -n +6
echo "== cpu top"; go tool pprof -top -nodecount=${N_CPU:-40} $BIN $O/cpu.prof 2>/dev/null | tail -n +5
pkill -f "$BIN --data $HOME/csmem/data-$TAG" || true
