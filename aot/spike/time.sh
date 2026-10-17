#!/bin/bash
# times: first build with an empty build cache, a rebuild after regenerating the app package, and startup
set -e
cd ~/gospike
ms() { echo $(( ($2 - $1) / 1000000 )); }
go clean -cache >/dev/null
a=$(date +%s%N); go build -o spike .; b=$(date +%s%N)
echo "first build, empty cache (deps + runtime + app): $(ms $a $b) ms"
# regenerate only the app package (new salt, so it must recompile), as a spec edit would
cp /mnt/d/code/crudspec/.scratch/gospike/regen/app/*.go app/
a=$(date +%s%N); go build -o spike .; b=$(date +%s%N)
echo "rebuild after regenerating the app package: $(ms $a $b) ms"
touch app/gen0.go; sed -i 's/const salt = \([0-9]*\)/const salt = \1 + 1/' app/gen0.go
a=$(date +%s%N); go build -o spike .; b=$(date +%s%N)
echo "rebuild after a one-line change: $(ms $a $b) ms"
rm -f /tmp/spike.db; a=$(date +%s%N); ./spike /tmp/spike.db load-only; b=$(date +%s%N)
echo "process start to loaded (empty db, schema absent): $(ms $a $b) ms"
