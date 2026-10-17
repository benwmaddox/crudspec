# Starts the compiled app in --test mode on an empty data directory (port 13802).
set -e
export PATH=$PATH:/usr/local/go/bin GOFLAGS=-buildvcs=false
cd /mnt/d/code/crudspec-build/campfire && go build -o ~/crudspec-campfire .
pkill -f "crudspec-campfire.*13802" || true; sleep 0.3
rm -rf ~/cs-go-test && mkdir -p ~/cs-go-test
cd /mnt/d/code/crudspec
(TZ=America/New_York setsid ~/crudspec-campfire --data ~/cs-go-test/data --assets /mnt/d/code/crudspec-assets/campfire --port 13802 --test > ~/cs-go-test/server.log 2>&1 &)
for i in $(seq 1 50); do curl -fsS -o /dev/null http://127.0.0.1:13802/up 2>/dev/null && break; sleep 0.1; done
cat ~/cs-go-test/server.log
