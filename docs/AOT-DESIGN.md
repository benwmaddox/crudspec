# Ahead-of-time compilation: design

> **Where it stands (18 Oct 2026):** the compiled Go app is the only implementation; the TypeScript runtime and interpreter are removed. With the fragment cache the room page serves 11,267-11,326 req/s at 0.34 ms CPU (`go-23`); without it 1,391-1,400 at 2.8 ms (`go-22`). The sections below are the design and its history, in order; the last ones are current.

*17 Oct 2026.*
- *Target: **Go** (the owner, 17 Oct 2026).*
- *Data: **in SQLite, not in memory** (the owner, 17 Oct 2026).*
- *Baseline: the Rust port's recorded results.*

**Status (17 Oct 2026): built.** See `lang/gogen/README.md` and "Results" below.

*This refines H6 ("generated code is efficient") and H9 ("the loop is fast") in `docs/HYPOTHESES.md`.*

## Requirements (the owner's, 17 Oct 2026)

| | Requirement | Notes |
| --- | --- | --- |
| Compile | under **15 s** for a modest project | Campfire, about 1,350 spec lines, is the yardstick. This is a full build: spec to running binary. |
| Startup | under **5 s** | A plain start. An upgrade start is reported separately (see Limits). |
| Speed | at least **25% of a reasonable C-based app** | Measured as throughput at saturation, on the same workloads and pinned cores. |

H6's own proposed thresholds were success at **≥ 0.8×** a hand-written service, and kill below 0.5×. The owner's 25% is a floor. **Agreed (17 Oct 2026): 25% is the requirement, 0.8× the aspiration.**

## Where the time goes today

Today's costs are mostly **algorithmic, not about the language the engine runs on**. A native backend copying these patterns would still miss the target:

| Today | Cost | Where |
| --- | --- | --- |
| The whole dataset is loaded into memory at start, and SQLite is only written back to | memory and startup grow with the data | `server.ts` startup, `store-sqlite.ts` `load()` |
| Every action copies the whole store, so it can roll back | O(all rows) per write | `interp.ts` `run()`: `this.store.clone()` |
| Every `where` scans its whole table, then sorts it | O(table) per query, including `count(…)` inside per-row expressions, which is quadratic | `interp.ts` `select()` |
| Every action rechecks every invariant on every row | O(all rows) per write | `interp.ts` `checkInvariants()` |
| Every save compares every row as JSON | O(all rows) per write | `store-sqlite.ts` `persist()` |
| Any change makes every open page refetch itself in full | O(clients × page) per write | `server.ts`, the live script |
| Read permissions are evaluated row by row after the scan | O(rows) per view | `interp.ts` `viewRows()` |

So the first part of the design is **shared, not native**: an SQL planner that the TypeScript runtime uses as well. The second part is the Go backend.

## Architecture

```
spec ──parse/check──▶ typed AST ──lower──▶ IR (SQL plans) ──┬──▶ TypeScript runtime (dev: instant reload)
                                                            └──▶ codegen ──▶ Go app package ──go build──▶ binary
                                                                                (+ prebuilt runtime package, cached)
test interpreter (in-memory, no database): the semantic reference for scenarios and the checker
```

### 1. Lowering to an IR with SQL plans (shared by both runtimes)

**SQLite is the store**, in the TypeScript runtime and in the compiled app alike. Nothing loads the dataset into memory. The test interpreter keeps its in-memory store, because scenario tests need no database.

- **Typed records:** one struct per entity, with typed fields. References are row ids.
- **Indexes the spec implies, as real SQLite indexes:**
  - a unique index per unique key (empty values never clash, as in SQL);
  - an index per reference field;
  - `(reference, created)` composite indexes where views order by time.

  The migration plan creates and drops them. It already creates the unique and reference indexes.
- **Queries compile to prepared SQL.**
  - `rows Message where .room == room order by created window 40 last` becomes `SELECT … FROM Message WHERE room = ? ORDER BY created DESC, seq DESC LIMIT 40`, then reversed.
  - `count(…)` becomes `SELECT count(*)`; `exists(…)` becomes `EXISTS`; `the(…)` becomes a lookup on a unique or primary key.
  - **Read permissions are folded into the query** where they're expressible: `member(actor, message.room)` becomes `AND EXISTS (SELECT 1 FROM Membership WHERE room = Message.room AND user = ?)`. Actor-only conditions are checked once, not per row.
  - **Expressions with no SQL form** (some text functions, fns that call other fns) are evaluated on the fetched rows.
  - The planner reports every query it can't push down, and every query whose cost depends on a table's size. That makes N+1 patterns visible at compile time (H6).
- **Transactions:** each action runs in one SQLite transaction (`BEGIN IMMEDIATE`). A refusal (`require … else`, an invariant, a unique key) is a `ROLLBACK`. SQLite is the undo log.
- **Invariants checked incrementally, inside the transaction:**
  - Each invariant's reads are found statically. `Session: self.user.status == active` reads `Session.user` and `User.status`.
  - Before commit, the transaction rechecks only the rows it touched, and rows that reach them through references. A change to `User.status` rechecks that user's sessions, with a query on `Session.user`.
- **Triggers run inside the same transaction**, as generated code. Workflows run after commit, as today.
- **Live updates by dependency:**
  - Each view records which tables, and which keys, it read.
  - A commit knows what it wrote, and notifies only the pages whose views it touched.
  - Partial re-rendering can come later.
- **Caching is optional and measured separately:** a fragment cache keyed by row and `updated`, like the Rust port's.

These help the TypeScript runtime as much as the compiler. Built first, they show how much of the gap is algorithmic, and they give the compiler a finished plan to emit.

### 2. A prebuilt runtime package, and generated app code only

To build in 15 s, only the app's code is compiled per project. The runtime package is compiled once per runtime version and cached by Go. It holds:
- HTTP/1.1 and server-sent events;
- SQLite access: a connection pool, prepared statements, transactions;
- crypto, from Go's standard and `x/crypto` libraries;
- JSON;
- HTML escaping and string building;
- the outbound HTTP client with the network guard;
- the test endpoints;
- the agent interface and MCP.

Generated code is:
- structs, row scanners and the SQL for every query;
- one function per action, view and fn;
- compiled templates for screens;
- tables of static strings;
- the agent descriptor.

### 3. Concurrency

SQLite in WAL mode allows many readers alongside one writer.
- **Reads:** a request that only reads runs on its own pooled connection, so views render in parallel across cores.
- **Writes:** actions run one at a time on the writer connection. That gives the same semantics as today's runtime, which runs one action at a time.
- **Measure per core, and per machine on the baseline's 4 cores.**

## Why Go

| | Go | C (clang) | Rust | Generated JavaScript on V8 |
| --- | --- | --- | --- | --- |
| Per-project compile, app code only | **2.4 s** measured (spike below) | fast at `-O1` | too slow for 15 s | instant |
| Startup | milliseconds: open the database and prepare statements | milliseconds | milliseconds | about a second |
| Likely speed against C | about 0.5–0.9× for this kind of work | about 1× | about 1× | about 0.2–0.5×; at risk against the floor |
| Runtime to build ourselves | little: HTTP, the TLS client, JSON and crypto are in the standard and `x/` libraries | a lot, and memory safety | medium | none |

## What doesn't port as it is

| Today (TypeScript) | In a compiled app |
| --- | --- |
| `--widgets` modules (Campfire's four widgets) | Widgets become **declarative templates**: HTML with placeholders for the arguments, kept in the app folder and compiled in |
| `--harness` modules (Campfire's scenario setup) | Unchanged: the harness keeps driving the binary over HTTP. `/_test/fixture`, which is generic, is built into the binary |
| Externs `post_json`, `opengraph`, `web_push` | Reimplemented in Go against the same tests. The RFC 8291 vector test and the QR decode test move with them |
| Page scripts (live refresh, pickers, paste previews, push) | Unchanged: they are static assets served by the binary |
| `plan` / `migrate` (Node) | They stay in the CLI. The binary checks that the schema hash matches and refuses to start otherwise. Deploying is compile, then migrate, then start |
| `describe`, `review`, `scaffold`, `screens` | They stay in the CLI, working from the spec. The binary embeds the generated descriptor |

## Correctness: the same behaviour, shown over HTTP

The test interpreter stays the reference. A compiled build counts as correct only if, over HTTP, it passes:
- the 42 Rails-oracle replay scenarios;
- the screens baselines (every screen's structure the same);
- `agent.mjs` and the MCP SDK client check;
- the annotation check, and the review probes replayed against the binary.

All of these already drive HTTP. Each build is also checked differentially: the interpreter and the binary run the same scenarios and must agree on every response.

## Limits to state

- **Startup doesn't depend on the data size.** It opens the database, checks the schema hash and prepares statements, and memory stays small.
- **An upgrade start is slower than a plain start.** It copies the database (`VACUUM INTO`) and rehearses the whole upgrade, so it takes time in proportion to the database size. It is reported separately from the 5-second plain start.
- **SQLite means one writer at a time, on one machine.** That suits a modest project. A Postgres backend behind the same query layer is the route to several servers; it isn't planned yet.

## Spike results (17 Oct 2026, WSL2, 22 vCPUs, Go 1.27.2; scripts in `aot/spike/`)

The generated Go is shaped like the planned output, on a small runtime package with a pure-Go SQLite driver (`modernc.org/sqlite`). The size is **twice Campfire's estimate**: 28 entities, 90 actions, 26 views, 96 screens, 17,600 lines.

| | Time | Requirement |
| --- | ---: | --- |
| First build, empty build cache (SQLite driver + runtime + app) | 10.9 s | under 15 s |
| **Rebuild after regenerating the app package** (what a spec edit causes) | **2.4 s** | under 15 s |
| Rebuild after a one-line change | 2.3 s | |
| Start, empty database | 3 ms | under 5 s |
| Start, loading 1,000,000 rows into memory | 2.5 s, peak RSS 317 MB | *superseded: data stays in SQLite* |

- **The SQLite driver choice is open.** `modernc.org/sqlite` is pure Go and builds without a C compiler. `mattn/go-sqlite3` uses cgo and is usually faster per query; it compiles once into the build cache, so per-project builds stay fast. Both get benchmarked.
- **The speed target, from the recorded Rust results** (AgentLang report 282: room page, 40 messages, 4 pinned vCPUs, every response validated):
  - the Rust port served 1,573 req/s at 2.39 ms CPU per request uncached, and 9,855 req/s at 0.40 ms with its fragment cache;
  - **so the 25% floor is about 393 req/s (at most about 9.6 ms CPU per request) uncached, and about 2,460 req/s cached.**

## Today's gap (17 Oct 2026, `bench/runs/quick-1`; one quick sweep, not the full three-repetition protocol)

The current TypeScript runtime ran on the imported snapshot (`bench/import-rails.ts`) under the same setup. Every response passed the room_show contract. The page is 376,880 bytes; Rails' is about 417 KB.

| | Req/s | CPU ms per request | Server use of 4 vCPUs |
| --- | ---: | ---: | ---: |
| crudspec runtime today, 16 / 32 / 64 connections | 19.4 / 21.2 / 24.4 | 57.6 / 56.3 / 56.5 | 0.28–0.34 (Node uses about one core) |
| Rust port, uncached (recorded) | 1,573 | 2.39 | 0.94 |
| **The floor (25%)** | **≥ 393** | **≤ 9.6** | |

**Today is about 1.4% of the Rust port's throughput**, at 24× the CPU per request.

A CPU profile of the same page (80 requests) shows where the time goes:
- **About half is button visibility.** For each button on each message, the runtime dry-runs the whole action (`wouldPass` → `run`). Each dry run copies the entire store (10% of time) and rechecks every invariant on every row (10%), and refusals are thrown as exceptions (6%).
- **Most of the rest** is expression evaluation in the interpreter, and full-table `select` scans (9%).

**The planner's first job is therefore clear:** decide whether to show a button by evaluating only the action's leading `require` guards, which have no writes. Don't run the action. Then come the SQL plans and incremental invariants.

## Measurement plan

1. **The baseline:**
   - the Rust port's recorded results, under the fair-benchmark protocol: Linux/WSL2, pinned and equal cores, interleaved runs, with and without cache, every response validated, CPU, throughput, p99 and memory;
   - workloads: the room page (recorded); a message post with unread fan-out, a search, and a bot API post, which the Rust port runs once.
2. **Today's gap:** the current TypeScript runtime on the room page, under the same harness. This needs:
   - an importer from the Rails snapshot that keeps its ids;
   - a crudspec mode in a copy of the harness kept in this repository;
   - room pages that pass the harness's room-page contract.
3. **After the SQL planner:** the same measurement again. The difference is the algorithmic share of the gap.
4. **The compiled build:** H6 scored against the baseline; H9 against the 15 s build.

## Phases

1. **The SQL planner in the TypeScript runtime:**
   - queries, permissions and counts as SQL against SQLite;
   - actions in SQLite transactions;
   - incremental invariants;
   - live updates by dependency;
   - no in-memory copy of the data.

   Equity must stay 42/42 over HTTP. Benchmark before and after.
2. ~~The compile-time spike, and choosing the target language.~~ Done: Go.
3. ~~The Go runtime package~~ Done (`lang/gogen/rt`): HTTP, SQLite, the test endpoints and the agent surface. Port the externs and their tests.
4. ~~Codegen to Go~~ Done (`lang/gogen/gen.ts`): The differential tests against the interpreter must pass.
5. Benchmarks for H6 and H9: done for throughput, start and build (Results). The report is still to write.

## Results (17 Oct 2026)

Campfire compiled with `node lang/cli.ts build`:
- **Equity:** all 42 scenarios over HTTP.
- **Screens:** 18 of 18 match the baseline.
- **Agents:** the agent end-to-end check and the MCP SDK client check pass.

| Measure | Result | Threshold |
| --- | --- | --- |
| Room page throughput (`bench/runs/go-11`, 4 server vCPUs, contract-validated, exact page size) | 1,523 req/s, 2.54 ms CPU per request; 97% of Rust's 1,573 | at least 25% required, 0.8× aspired: **both met** |
| Start | 14 ms | under 5 s: **met** |
| Build | generate about 2 s plus a warm `go build` about 3 s; a cold Go cache about 29 s (cgo SQLite) | under 15 s: **met warm, missed cold** |
| Memory under load | 156 MB PSS | not set |

Where it differs from the plan:
- **No separate IR:** the generator lowers the AST straight to Go, planning SQL as `sqlplan.ts` does.
- **The UI is compiled to Go functions,** not walked as a tree.
- **Upgrades stay in the TypeScript CLI:** the binary checks the database's version and refuses to start on a mismatch.
- **The TypeScript runtime is kept** as the reference.

How it got from 46% to 97%: typed Go from the type pass (`lang/types.ts`), pooled page buffers, prefetch plans, lazily decoded JSON columns, and shared handler tokens and gate checks (`lang/gogen/README.md`).

## Decisions

| | Decision |
| --- | --- |
| Target language | **Go** (the owner, 17 Oct 2026) |
| Data | **in SQLite, not in memory** (the owner, 17 Oct 2026) |
| Baseline | the Rust port, from its recorded results. Assumed; the owner may name another |
| Thresholds | **agreed (the owner, 17 Oct 2026):** at least 25% of the baseline's throughput is required, 0.8× is the aspiration, a full build in under 15 s, a plain start in under 5 s |

## The interpreter is gone (17 Oct 2026)

The sections above describe the TypeScript interpreter and runtime as they were. Both are removed: upgrades run spec code in the app (`app migrate-data`), the change report and the annotation check run it too (`app probe`), and equity is the replay against the app. The differential check against the interpreter is replaced by the Rails oracle alone.

## Where the room page's time goes (17 Oct 2026, `bench/runs/go-16`, 1,560 req/s)

A CPU and allocation profile of the room page (`bench/go-prof.sh`):
- **Boxing is small.** `runtime.convT*`, `rt.BoxRef` and the `rt.As*` unboxers are about 4% of CPU. Rows as typed Go structs instead of value slots would save at most that, and would touch storage, the identity map, prefetch, agents and the test endpoints. **Not done.**
- **Contexts are large.** A context copied for each row a query filters (`Ctx.OnRow`, 13% of allocated bytes), a render context and variable map for each component call (`RCtx.ctx` and `copyVars`, 13%), and handler-token arguments (`Offer`, `HiddenArg`, 15% cumulative).
- **Buffer growth** (`bytes.growSlice`) is 15% of allocated bytes.

The next gain is typed UI: component parameters and loop variables as Go arguments rather than a variable map, with the map kept only where a handler token needs it.

Done after that profile (17 Oct 2026):
- **Typed UI and fewer contexts** (`go-18`): component parameters and row loop variables as typed Go variables, one scope per loop rather than a copy per item, one row context per query, the page's request shared by its render contexts, and the main part written straight into its presized buffer. 1,770-1,820 req/s at 2.2 ms CPU per request, from 1,570 at 2.5.
- **Large buffers kept across collections** (`go-20`, `go-21`): memory under load 160 MB -> 71 MB, for about 3% of throughput (1,716-1,744 req/s).

## Live updates and the fragment cache (17 Oct 2026)

The review's first and second recommendations, done:
- **Targeted live updates.** Pages are told only of commits that changed what they read, and refresh by fragment. Around every action of the 42 scenarios (709 page renders): 0 pages left wrong, 25 refreshed whole, and 1.26 MB moved against 17.0 MB had each told page been fetched whole (before this, every open page fetched itself whole on every commit).
- **The fragment cache.** `bench/runs/go-23`: **11,267-11,326 req/s at 0.34 ms CPU** per request, against the Rust port's recorded 9,855 req/s at 0.40 ms with its fragment cache. Without the cache (`go-22`), tracking costs the uncached page about 20%: 1,391-1,400 req/s, from 1,740.

The benchmark makes no writes, the cache's best case; the scenarios cover writes, and in them no page differs from its uncached render.

## Reads with writes (18 Oct 2026, `bench/runs/w-1`)

Readers load the room page at 32 connections while a writer posts into the same room:

| Posts/s | Reads/s | CPU per read | Cache hit rate | Post p50 / p99 |
| --- | --- | --- | --- | --- |
| 0 | 11,388 | 0.33 ms | 100% | - |
| 1 | 11,183 | 0.35 ms | 99.7% | 7.9 / 74 ms |
| 5 | 10,082 | 0.38 ms | 98.4% | 4.4 / 57 ms |
| 20 | 8,364 | 0.46 ms | 94.7% | 4.4 / 19 ms |
| 50 | 4,729 | 0.79 ms | 87.4% | 3.4 / 19 ms |

Every read and post succeeded. A commit drops only the fragments it touched, so even at 50 messages a second into the room being read, the page serves about three times its uncached rate. The readers fetch whole pages; live clients would fetch only the changed fragments, which this doesn't measure.
