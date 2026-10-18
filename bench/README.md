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
| `crudspec-writes.sh`, `post-writer.mjs` | The room page under reads and writes: readers at 32 connections while a writer posts into the same room at 0, 1, 5, 20 and 50 messages/s; reads/s, CPU per read, post latency and the fragment cache's hit rate. Run as root, with `GOBIN=<binary>` |
| `go-run.sh`, `go-prof.sh`, `go-test.sh`, `go-check.sh` | The compiled app (`lang/gogen`): start it on the snapshot, profile it, start it in `--test` mode, and run equity on it. For the fair run, use `GOBIN=<binary>` with `crudspec-lifetime.sh` |
| `runs/` | Results: `summary.jsonl` per run |

The load generator and the contract come from the AgentLang benchmark directories. They're used read-only.

## Two traps

- **The contract checks only the messages.** A page that drops buttons still passes. Pass `EXPECT_BYTES=351758` (the full room page as the Go build writes it, with its fragment markers since 17 Oct 2026; 335,674 before them, since buttons without handlers share one short token). When the size changes on purpose, compare the page with a known-good `body.html` with the tokens stripped to `crudspec-lifetime.sh` so a smaller page stops the run.
- **The screens check runs on Windows and reaches WSL through localhost forwarding.** A Windows process listening on the same port silently wins, which happened once with a stale TypeScript test server on 13801. Before `lang/browser/screens.ts`, check with `Get-NetTCPConnection -LocalPort <port> -State Listen` that nothing on Windows holds the port.
