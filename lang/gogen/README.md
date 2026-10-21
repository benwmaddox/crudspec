# The Go backend

A spec compiles to a Go program. Nothing in the app is interpreted at run time. Every behaviour is generated Go code, and `rt/` only provides storage, HTTP and formatting helpers that the generated code calls:

- **Logic:** expressions, statements, actions, views, predicates, functions, triggers and workflows become Go functions.
- **Queries:** each query's `where`, and the entity's read permission, is planned as SQL at build time. The rules are the TypeScript runtime's planner's, which this replaced, so the rows are the same. A part that can't be SQL is filtered in Go. Its row-independent subexpressions are worked out once per query, not per row.
- **Rows:** each entity gets generated code: its column codecs and SQL, create (defaults, unique keys), a setter per field, delete (each reference's restrict or cascade), parent touches, and its agent view. Triggers are called directly by the writes and emits that set them off. Invariants are a generated check of the rows an action touched.
- **Arguments:** each action, view, screen and API route has generated code that binds its arguments by type (forms, queries, paths, channels, agent calls). The same goes for its links, its guards, its `on` handlers and the identities' formats.
- **Field access:** where the compiler knows an expression's entity, a field read is a direct slot, not a lookup by name. It knows it for parameters, loop variables, `let`s, query results, typed functions and events, as inferred from their emits. What remains by name is reading record values: `theme`, `client`, `query`, an extern's reply, and a trigger's old row.
- **UI:** each screen and component becomes a Go function that evaluates its expressions and writes its HTML in order. Only `on` handlers and fields with pickers are kept as data, because a form post and a picker look them up by id.

```
node lang/cli.ts build <app.crud> --out <dir> [--widgets <widgets.go>]   # generates, then go build if Go is installed
<dir>/app --data <dir> --assets <dir> [--port 3000] [--test]
```

| Path | What |
| --- | --- |
| `gen.ts` | The generator: a spec to `app.go`, plus `go.mod` and `widgets.go` |
| `rt/` | The runtime library every app links against. It is generic and names no app |

What `rt/` contains:

| File | What |
| --- | --- |
| `val.go` | Values, equality, ordering and JSON (the rules the interpreter had, until it was removed) |
| `store.go` | SQLite: one writer connection with savepoints, a read pool (WAL), an identity map per request, and answers to repeated reads kept for the request until it writes |
| `exec.go`, `ctx.go`, `helpers.go` | Statement semantics, invariants checked on the rows an action touched, workflows |
| `builtins.go` | The builtin functions |
| `server.go`, `uiparts.go`, `render.go` | HTTP, forms, sessions, handler tokens, the bot API, files, live updates, and the pieces compiled screens are built from |
| `agents.go` | The agent API: JSON, MCP, `/_agents`, dry runs, confirmation, audit |
| `externs.go` | `post_json`, `opengraph` (behind the network guard) and `web_push` |
| `live.go` | Live pages: the keys a page reads while it renders (rows, column values from each query's equalities, a table's columns), the keys each commit wrote (old and new values), hashed with the app's secret, and the stream that tells pages when the two meet |
| `frag.go` | Fragments: components, lists, slots and a screen's own ifs, marked with comments that carry a subtree hash and their own keys; a live page refreshes just the fragments a commit meets, and is sent only what it doesn't have |
| `cache.go` | The fragment cache: what the generator finds free of page side effects and clock or random reads is kept by id, viewer, address and ambient values, and dropped by the commit whose keys meet it |
| `where.go` | A failure's spec line, from the `//line` directives the generator writes |
| `migrate.go`, `probe.go` | `app migrate-data` (an upgrade's defaults, migrations and invariants) and `app probe` (the change report's runs) |
| `test.go` | The test protocol (`/_test/load`, `dump`, `fixture`, `clock`, `maxid`, `fn`, `live`, `cache-check`; `X-No-Cache` renders without the cache) |
| `main.go` | Flags, and the database version check |

An app's own widgets are Go functions in the app's `widgets.go`; Campfire's is `apps/campfire/widgets.go`.

## Live pages, fragments and the cache

A page records what it reads while it renders; a commit publishes what it wrote. The stream
sends each commit's keys, hashed; a page refreshes only when they meet its own, and then only
the outermost fragments they meet, asking for them with the fragments it already has, so a new
chat message costs the message. The same keys drop entries from the fragment cache. How sound
this is, is checked in the replay (`REPLAY_LIVE_CHECK=1`): around every action of the 42
scenarios, every room page of every user is refreshed as the live script would, and must equal
a fresh render without the cache.

Known limits: a page that showed only a window of rows ordered by something other than
`updated` isn't told of rows touched outside it; a read the runtime can't name falls back to
the whole table, which refreshes more often than needed.

## Storage and upgrades

- A new database gets the spec's schema and its first recorded version. The DDL and the schema hash come from the TypeScript tools at build time, so both runtimes share databases.
- An existing database must already be at this spec's version, or the app refuses to start and names the fix: `node lang/cli.ts migrate <spec> --data <dir>`. That command plans the upgrade, rehearses it on a copy and keeps a backup.

## Checked

Campfire, 17 Oct 2026, against the compiled binary:

- **Equity:** all 42 scenarios match the Rails oracle over HTTP, through the generic test protocol (`/_test/*`).
- **Screens:** all 18 match the accepted baseline (`lang/browser/screens.ts`).
- **Agents:** `apps/campfire/e2e/agent.mjs` passes, and so does the official MCP SDK client (`mcp-client.mjs`).
- **Speed** (room page, 4 server vCPUs, every response validated against the benchmark contract, at the page's exact size):
  - with the fragment cache, **10,799-11,043 requests/s at 0.36 ms CPU** per request on storage format 4 (`bench/runs/go-24`, 19 Oct 2026; 11,267-11,326 on format 2, `go-23`), against the Rust port's 9,855 at 0.40 ms with its own cache;
  - with the cache turned off (`CRUDSPEC_NO_CACHE=1`), 1,094-1,114 requests/s (`go-26-nocache`); the build before the storage changes gives 1,084, so format 4 costs nothing here (its rich-text queries about 5%, its SQL time comparisons win that back). The cache's bookkeeping runs even when it's off: a build without the cache gave 1,391-1,400 (`go-22`). The Rust port uncached: 1,573 at 2.39 ms;
  - memory under load about 70 MB PSS.
  - What got it there: typed Go from the type pass (functions, guards, action and UI variables); pooled page buffers that survive a collection; prefetch plans; JSON columns decoded on first read; handler tokens and gate checks shared within a page; one row context per query and one scope per loop; and the fragment cache.
- **Live pages:** around every action of the 42 scenarios, every room page refreshed as the live script would equals a fresh render without the cache; 25 of 709 refreshes were whole pages, and 1.26 MB moved against 17.0 MB for whole pages.
- **Start and build:**
  - The app starts in 14 ms.
  - Generating takes about 2 s; a warm `go build` about 3 s.
  - A first build with an empty Go cache takes about 29 s, most of it compiling SQLite through cgo.

## Not yet

- The generator is TypeScript, so building needs Node. A Go port is possible; it would have to reproduce the schema hash existing databases have recorded.
- Typing is partial. Expressions, functions, predicates, guards, actions' scalar parameters and top-level variables, and components' parameters and row loop variables are typed Go; entity parameters (resolved lazily), names bound inside `if`s and loops, and rows (`rt.Val` slots) are not. Typed rows were measured and judged not worth it (`docs/AOT-DESIGN.md`).
- Column pruning covers page renders only: a page selects just the columns it reads (`rt/prune.go`; `CRUDSPEC_PRUNE=0` turns it off, `=check` marks the text fields left out; `lang/test/prune.test.ts` renders every page of every app with it on, off and checking). Actions, the API and agents still read whole rows.
- The test endpoints (`/_test/load`, `dump`, `fixture`) read and write rows by field name. They are test-only.
