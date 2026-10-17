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
| `test.go` | The test protocol (`/_test/load`, `dump`, `fixture`, `clock`, `maxid`, `fn`) |
| `main.go` | Flags, and the database version check |

An app's own widgets are Go functions in the app's `widgets.go`; Campfire's is `apps/campfire/widgets.go`.

## Storage and upgrades

- A new database gets the spec's schema and its first recorded version. The DDL and the schema hash come from the TypeScript tools at build time, so both runtimes share databases.
- An existing database must already be at this spec's version, or the app refuses to start and names the fix: `node lang/cli.ts migrate <spec> --data <dir>`. That command plans the upgrade, rehearses it on a copy and keeps a backup.

## Checked

Campfire, 17 Oct 2026, against the compiled binary:

- **Equity:** all 42 scenarios match the Rails oracle over HTTP, through the same generic test protocol the TypeScript runtime uses.
- **Screens:** all 18 match the accepted baseline (`lang/browser/screens.ts`).
- **Agents:** `apps/campfire/e2e/agent.mjs` passes, and so does the official MCP SDK client (`mcp-client.mjs`).
- **Speed:** the room page reaches 1,523 requests/s at 2.54 ms CPU per request, every response validated against the benchmark contract, at the page's exact size (`bench/runs/go-11`).
  - That is 97% of the Rust port's 1,573 requests/s at 2.39 ms. The floor is 25% and the aspiration 0.8×.
  - Memory under load is 156 MB PSS.
  - What got it there:
    - typed Go from the type pass, with typed functions and typed button guards;
    - pages written into pooled buffers;
    - prefetch plans: a list's references and child lists fetched in a few queries;
    - JSON columns decoded on first read;
    - handler tokens and gate checks shared within a page.
- **Start and build:**
  - The app starts in 14 ms.
  - Generating takes about 2 s; a warm `go build` about 3 s.
  - A first build with an empty Go cache takes about 29 s, most of it compiling SQLite through cgo.

## Not yet

- The generator is TypeScript, so building needs Node. A Go port is possible; it would have to reproduce the schema hash existing databases have recorded.
- Typing is partial. Expressions, functions, predicates and guards are typed Go. An action's own variables still live in a map, and rows store `rt.Val` slots.
- Only the columns that are used aren't selected yet (column pruning).
- The test endpoints (`/_test/load`, `dump`, `fixture`) read and write rows by field name. They are test-only.
