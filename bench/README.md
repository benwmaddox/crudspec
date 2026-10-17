# Benchmarks

The fair-benchmark setup from AgentLang report 282:
- WSL2, the server in its own network namespace and cgroup, pinned to vCPUs 8-11;
- the load generator pinned to vCPUs 12-19;
- every response validated against the canonical room_show contract (40 messages).

The Rust port's recorded results are the baseline (`docs/AOT-DESIGN.md`).

| File | What |
| --- | --- |
| `import-rails.ts` | Imports the benchmark's Rails snapshot into a crudspec Campfire data directory, keeping every id: `node bench/import-rails.ts <production.sqlite3> <data dir>` |
| `validate-room.mjs` | The room_show contract check in Node, for checking a page before a run |
| `crudspec-lifetime.sh` | One runtime lifetime: start, warm up, sweep connection counts, CPU from the cgroup, memory (PSS). Run as root: `wsl -d Ubuntu -u root -- bash /mnt/d/code/crudspec/bench/crudspec-lifetime.sh <run> [secs] [conns…]` |
| `go-run.sh`, `go-prof.sh`, `go-test.sh`, `go-check.sh` | The compiled app (`lang/gogen`): start it on the snapshot, profile it, start it in `--test` mode, and run equity on it. For the fair run, use `GOBIN=<binary>` with `crudspec-lifetime.sh` |
| `runs/` | Results: `summary.jsonl` per run |

The load generator and the contract come from the AgentLang benchmark directories. They're used read-only.
