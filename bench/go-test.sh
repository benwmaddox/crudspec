# Starts the compiled app in --test mode on an empty data directory (port $PORT).
set -e
PORT=${1:-13802}
MODE=${2---test}   # "" for an ordinary (non-test) run
export PATH=$PATH:/usr/local/go/bin GOFLAGS=-buildvcs=false
cd /mnt/d/code/crudspec-build/campfire && go build -o ~/crudspec-campfire .
pkill -f "crudspec-campfire.*$PORT" || true; sleep 0.3
rm -rf ~/cs-go-test && mkdir -p ~/cs-go-test
cd /mnt/d/code/crudspec
(TZ=America/New_York setsid ~/crudspec-campfire --data ~/cs-go-test/data --assets /mnt/d/code/crudspec-assets/campfire --port $PORT $MODE > ~/cs-go-test/server.log 2>&1 &)
for i in $(seq 1 50); do curl -fsS -o /dev/null http://127.0.0.1:$PORT/up 2>/dev/null && break; sleep 0.1; done
cat ~/cs-go-test/server.log
