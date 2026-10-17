# Builds the generated Campfire program and starts it on a fresh copy of the bench snapshot.
#   bash bench/go-run.sh [port]
set -e
export PATH=$PATH:/usr/local/go/bin GOFLAGS=-buildvcs=false
PORT=${1:-13775}
cd /mnt/d/code/crudspec-build/campfire && go build -o ~/crudspec-campfire .
pkill -f "crudspec-campfire.*--port $PORT" || true; sleep 0.3
rm -rf ~/cs-go && mkdir -p ~/cs-go && cp -a /mnt/d/code/crudspec-run/bench-snap-nc ~/cs-go/data && rm -f ~/cs-go/data/app.lock
cd /mnt/d/code/crudspec
(CRUDSPEC_PPROF=6060 TZ=America/New_York setsid ~/crudspec-campfire --data ~/cs-go/data --assets /mnt/d/code/crudspec-assets/campfire --port $PORT > ~/cs-go/server.log 2>&1 &)
for i in $(seq 1 50); do curl -fsS -o /dev/null http://127.0.0.1:$PORT/up 2>/dev/null && break; sleep 0.1; done
cat ~/cs-go/server.log
node -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync(process.env.HOME+'/cs-go/data/app.sqlite').prepare('select token from Session where id = 481019661').get().token)" 2>/dev/null > ~/cs-go/token
