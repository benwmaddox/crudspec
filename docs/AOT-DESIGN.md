# Ahead-of-time compilation: design sketch

*17 Oct 2026. A design to decide on, not a build plan yet. It refines H6 ("generated code is
efficient") and H9 ("the loop is fast") in `docs/HYPOTHESES.md`.*

## Requirements (the owner's, 17 Oct 2026)

| | Requirement | Notes |
| --- | --- | --- |
| Compile | under **15 s** for a modest project | Campfire, about 1,350 spec lines, is the yardstick. This is a full build: spec to running binary. |
| Startup | under **5 s** | A plain start. An upgrade start is reported separately (see Limits). |
| Speed | at least **25% of a reasonable C-based app** | Measured as throughput per core at saturation, on the same workloads and pinned cores. |

H6's own proposed thresholds were success at **≥ 0.8×** a hand-written service, and kill below 0.5×. The owner's 25% is a floor. The proposal: **25% is the requirement, 0.8× the aspiration.** Decision 4 below.

## Where the time goes today

The interpreter's costs are mostly **algorithmic, not about the language it runs on**. A native backend copying these patterns would still miss the target:

| Today | Cost | Where |
| --- | --- | --- |
| Every action copies the whole store, so it can roll back | O(all rows) per write | `interp.ts` `run()`: `this.store.clone()` |
| Every `where` scans its whole table, then sorts it | O(table) per query, including `count(…)` inside per-row expressions, which is quadratic | `interp.ts` `select()` |
| Every action rechecks every invariant on every row | O(all rows) per write | `interp.ts` `checkInvariants()` |
| Every save compares every row as JSON | O(all rows) per write | `store-sqlite.ts` `persist()` |
| Any change makes every open page refetch itself in full | O(clients × page) per write | `server.ts`, the live script |
| Read permissions are evaluated row by row after the scan | O(rows) per view | `interp.ts` `viewRows()` |

So the first part of the design is **shared, not native**. The second part is the native backend.

## Architecture

```
spec ──parse/check──▶ typed AST ──lower──▶ IR (plans) ──┬──▶ interpreter (dev: instant reload, the reference)
                                                         └──▶ codegen ──▶ app code ──link──▶ binary (+ prebuilt runtime)
```

### 1. Lowering to an IR with plans (shared by both backends)

- **Typed records:** one struct per entity, with typed fields. References are row ids.
- **Indexes the spec implies:**
  - a hash index per unique key;
  - a multimap per reference field;
  - insertion order (`seq`) per table.
- **Query plans.**
  - A `where` whose conjuncts include equality on an indexed field becomes an index lookup. `.room == room` becomes a lookup in the `Message.room` index, then the remaining filter.
  - `order by created` with `window 40 last` becomes the last 40 of an ordered index.
  - `count(…)` over an index becomes a size.
  - Actor-only parts of a read permission are hoisted. For example, `member(actor, room)` is checked once per view, not once per message.
- **Transactions:** an undo log (old values of rows written) instead of copying the store. A refused action replays the log backwards.
- **Incremental invariants:**
  - Each invariant's reads are found statically. `Session: self.user.status == active` reads `Session.user` and `User.status`.
  - A write rechecks only the touched rows, and rows that reach them through reverse indexes: a change to `User.status` rechecks that user's sessions.
- **Dirty tracking:** the touched rows are exactly what the transaction writes to SQLite.
- **Live updates by dependency:**
  - Each view records which tables, and which indexed keys, it read.
  - A commit notifies only the pages whose views it touched.
  - Partial re-rendering can come later.

These help the interpreter as much as the compiler. Built first, they show how much of the gap is algorithmic, and they give the compiler a finished plan to emit.

### 2. A prebuilt runtime, and generated app code only

To build in 15 s, only the app's code may be compiled per project. The runtime is built once per runtime version and linked in:
- HTTP/1.1 and server-sent events;
- the typed table and index library;
- SQLite;
- crypto, from a library;
- JSON;
- HTML escaping and string building;
- the outbound HTTP client with the network guard;
- the test endpoints;
- the agent interface and MCP.

Generated code is:
- structs and index declarations;
- one function per action, view and fn;
- compiled templates for screens;
- tables of static strings.

### 3. Concurrency

The runtime today handles requests one at a time. If the C-based baseline uses several cores, 25% per machine needs parallel reads.
- **Version 1:** one writer thread runs actions in order, which gives the same semantics as now. Reader threads render views from a consistent snapshot, using an epoch or copy-on-write per row.
- **Measure per core first.** If one thread already reaches 25% per core, parallelism is a later step.

## Choosing the target language

| | Go | C (clang) | Rust | Generated JavaScript on V8 |
| --- | --- | --- | --- | --- |
| Per-project compile, app code only | fast: Go compiles large generated packages in seconds | fast at `-O1`, and parallel across files. `-O2` on very large files is slower | **too slow**. The Rust Campfire port's builds are the evidence, to be timed | instant |
| Startup | milliseconds, plus loading data | milliseconds, plus loading data | milliseconds | about a second |
| Likely speed against C | about 0.5–0.9× for this kind of work (GC, bounds checks) | about 1× | about 1× | about 0.2–0.5×; at risk against the 25% floor |
| Runtime to build ourselves | little: HTTP, TLS client, JSON, crypto (P-256, AES-GCM, HKDF, scrypt) are in its standard and `x/` libraries | a lot: HTTP server, a TLS client for webhooks, push and previews, JSON, and memory safety | medium | none |
| Memory safety | yes | no: generated code and runtime need ASan runs and fuzzing | yes | yes |
| On this machine | not installed | clang 18, gcc 13 | cargo 1.93 | Node 24 |

**Recommendation: Go**, unless native C is a requirement.
- Go meets all three numbers with the most margin per unit of work. Its standard library covers what the runtime needs, so the effort goes into the planner and codegen rather than an HTTP server and TLS client.
- C gives the most speed headroom, at the cost of owning much more runtime and memory safety.
- The "native C only" and "no own crypto" rules in my notes come from the archived AgentLang project. Whether they bind crudspec is decision 1. Either way, crypto comes from a library.

## What doesn't port as it is

| Today (TypeScript) | In a compiled app |
| --- | --- |
| `--widgets` modules (Campfire's four widgets) | Widgets become **declarative templates**: HTML with placeholders for the arguments, kept in the app folder and compiled in. They're no longer code |
| `--harness` modules (Campfire's scenario setup) | Unchanged: the harness keeps driving the binary over HTTP. `/_test/fixture`, which is generic, is built into the binary |
| Externs `post_json`, `opengraph`, `web_push` | Reimplemented natively against the same tests. The RFC 8291 vector test and the QR decode test move with them |
| Page scripts (live refresh, pickers, paste previews, push) | Unchanged: they are static assets served by the binary |
| `plan` / `migrate` (Node) | They stay in the CLI. The binary checks that the schema hash matches and refuses to start otherwise; deploying is compile, then migrate, then start |
| `describe`, `review`, `scaffold`, `screens` | They stay in the CLI, working from the spec. The binary embeds the generated descriptor |

## Correctness: the same behaviour, shown over HTTP

The interpreter stays the reference. A compiled build counts as correct only if, over HTTP, it passes:
- the 42 Rails-oracle replay scenarios;
- the screens baselines (every screen's structure the same);
- `agent.mjs` and the MCP SDK client check;
- the annotation check, and the review probes replayed against the binary.

All of these already drive HTTP, which makes them the biggest de-risking available. Each compiled build is also checked differentially: the interpreter and the binary run the same scenarios and must agree on every response.

## Limits to state

- **The whole dataset lives in memory.** Startup reads it from SQLite at about 1–2 million rows per second (to be measured), so the 5-second start holds up to a few million rows. Beyond that, tables would page from SQLite: a later design, and decision 3.
- **An upgrade start is slower than a plain start.** It copies the database (`VACUUM INTO`) and rehearses the whole upgrade, so it takes time in proportion to the database size. It is reported separately from the 5-second plain start.

## Measurement plan

1. **The baseline.**
   - No C Campfire exists. The closest native implementation is the **Rust port** (`baseline/`, `6dae2fd`), and "reasonable C-based app" is read as that.
   - The protocol is the fair-benchmark one: Linux/WSL2, pinned and equal cores, interleaved runs, with and without cache, every response validated, CPU, throughput, p99 and memory.
   - Workloads:
     - a room page render;
     - a message post with unread fan-out;
     - a search;
     - a bot API post.
   - Recorded Rust numbers from earlier work are reused if they match these workloads; otherwise the port is run once.
2. **Today's gap:** the current runtime on the same workloads. Then again after the shared planner (step 1 of the plan), which shows how much of the gap was algorithmic.
3. **A compile-time spike:**
   - generate a C file and a Go package of realistic size: Campfire's expansion, estimated from a hand-sketched slice;
   - time `clang -O1`/`-O2` across 22 cores, and `go build`, both with a prebuilt runtime;
   - time the Rust port's build, as evidence for ruling Rust out.
4. **Decision rule:**
   - the target language is the one that meets 15 s with the most speed margin in the spike;
   - H6 is scored on the compiled build against the Rust baseline.

## Phases

1. The shared planner in the interpreter: indexes, query plans, undo log, incremental invariants, dirty tracking, live updates by dependency. Equity must stay 42/42. Benchmark after.
2. The compile-time spike, and choose the target language.
3. The runtime library in that language, with HTTP, SQLite, the test endpoints and the agent surface. Port the externs and their tests.
4. Codegen from the IR. The differential tests against the interpreter must pass.
5. Benchmarks for H6 and H9, and the report.

## Decisions for the owner

1. **The target language:** Go (recommended), or C if native C is required.
2. **The baseline:** the Rust port, as the reasonable native app, on the four workloads above. Or name another.
3. **The data limit:** is an in-memory dataset, a few million rows for a 5-second start, acceptable for now?
4. **Thresholds:** 25% of the baseline per core as the requirement, H6's 0.8× as the aspiration, and H9's compile requirement replaced by 15 s for the full build. Agree or adjust.
