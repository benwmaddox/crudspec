# CPU profile of the compiled app under room-page load (after bench/go-run.sh).
export PATH=$PATH:/usr/local/go/bin
(~/cm258/loadgen-linux/release/loadgen http --base http://127.0.0.1:13775 --cookie "session_token=$(cat ~/cs-go/token)" --path /rooms/486777696 --conc 4 --duration 12 --gzip 0 > /tmp/lg.json &)
sleep 1; curl -s -o /tmp/cpu.prof "http://127.0.0.1:6060/debug/pprof/profile?seconds=8"; sleep 4
cut -c1-300 /tmp/lg.json; echo
go tool pprof -top -cum -nodecount=${N:-70} ~/crudspec-campfire /tmp/cpu.prof 2>/dev/null | tail -n +6
