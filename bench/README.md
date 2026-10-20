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

## The fair comparison (20 Oct 2026)

`fair-run.sh` runs crudspec, Rails and Rust under one protocol: `crudspec-lifetime.sh` for crudspec, `ref-lifetime.sh` for Rails and Rust (copied from AgentLang's `native-lifetime.sh`, which measured a single 16-connection window with a smaller load generator). Each server is pinned by its cgroup's cpuset to vCPUs 8-11, the load generator gets 12-21, every server gets a 10 s warmup and the same sweep of 16/32/64/128 connections, and each runs uncached, with fragment caches only (`CRUDSPEC_NO_PAGE_CACHE=1`; Rust with `CAMPFIRE_RESPONSE_CACHE_MB=0`), and fully cached. Two passes, the second in reverse order. `fair-summary.ts <tag>` takes each run's best clean window, over the time the load generator actually ran: a slow server keeps it waiting for queued requests past the window, which once made Rails look 25% faster. Rails uses 4 Puma workers (`RAILS_WORKERS`), its fastest here. The results are in the top-level README.

## Two traps

- **The contract checks only the messages.** A page that drops buttons still passes. Pass `EXPECT_BYTES=351758` (the full room page as the Go build writes it, with its fragment markers since 17 Oct 2026; 335,674 before them, since buttons without handlers share one short token). When the size changes on purpose, compare the page with a known-good `body.html` with the tokens stripped to `crudspec-lifetime.sh` so a smaller page stops the run.
- **The screens check runs on Windows and reaches WSL through localhost forwarding.** A Windows process listening on the same port silently wins, which happened once with a stale TypeScript test server on 13801. Before `lang/browser/screens.ts`, check with `Get-NetTCPConnection -LocalPort <port> -State Listen` that nothing on Windows holds the port.

## Compression (19 Oct 2026)

`crudspec-lifetime.sh` takes `GZIP=1` to have the load generator offer gzip; the default stays off, as in every run before (and as in report 282, which the comparisons with Rails and Rust use). The app gzips pages from the fragment cache's compressed pieces (`lang/gogen/rt/gzip.go`) and serves assets by content hash (`assets.go`). Room page, 32 connections, snapshot nc5:

| Run | req/s | CPU/req | Page on the wire |
| --- | ---: | ---: | ---: |
| `go-31-gzip0`, cached | 11,325 | 0.338 ms | 356,852 B |
| `go-31-gzip1`, cached | 13,421 | 0.286 ms | 23,505 B |
| `go-31-nocache-gzip0` | 1,079 | 3.54 ms | 356,852 B |
| `go-31-nocache-gzip1` | 988 | 3.92 ms | 29,727 B |

With the cache (the app's normal mode), compression is cheaper than writing the whole page: 18% more requests a second for 15% less CPU each. Without it, every piece is compressed afresh: 8% fewer requests a second. The page is 5 KB larger than in `go-30` (351,542 B), from the `?v=` hashes in asset addresses.

**Rails and Rust with gzip:** AgentLang report 259 measured both with gzip offered. Rails compresses (464 KB down to about 44 KB), and was about as fast either way (17 against 19 req/s uncached). Uncached, Rust went from 1,322 req/s to 987 with gzip. With its own cache, Rust serves a page compressed in advance (30,345 req/s). Report 282 measured none of the three with gzip, so the recorded comparisons are uncompressed against uncompressed. Rails and Rust weren't rerun.

**Uncached drift through 19 Oct** (32 connections, `go-bisect-*`): `3aac418` 1,156 req/s, `97a5e51` 1,120, now (gzip off) 1,072, against 1,203 in `go-30`. Each step is within run-to-run spread; the page's extra 5 KB is part of the last.
