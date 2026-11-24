# Storage backends: keeping another database possible

crudspec stores an app's data in SQLite, and nothing else is planned. This note keeps a second
backend (Postgres, most likely) possible at a known cost. It says what such a backend would
replace, in what order, and how we'd know it works.
`lang/test/sqlite-confined.test.ts` keeps the SQLite-specific code in the files listed there,
so this note stays true.

## Why SQLite now

- One process writes and many read (WAL): no server to run, and a backup is a file.
- The runtime calls SQLite's C API directly (`rt/lite.go`), typed, without `database/sql`. Pages
  are fast because of it.
- Single-server capacity has held up against Rails Campfire in the benchmarks.

A second backend is for running several app servers, or for fitting into an existing managed
database. It isn't for speed.

## What's tied to SQLite (as of 2026-11-18)

**The easy part: SQL only SQLite speaks.** There are about 60 uses in 13 files:
- `json_each` passes a set of ids as one parameter (statements, live keys, batched ensures);
- `PRAGMA` and `sqlite_master` cover settings, WAL and version checks;
- `INSERT OR REPLACE/IGNORE`;
- `rowid`;
- `VACUUM` in upgrades and backups (`VACUUM INTO`, a copy while the app runs).

Each has a standard or Postgres form (`= ANY($1)`, `ON CONFLICT`, `information_schema`). A
dialect layer in the generator and the store covers them.

**The library.**
- `rt/lite.go` is SQLite's C API, 80 calls.
- The build plans every query with `node:sqlite` (`lang/cost.ts`), to choose indexes automatically.

A second backend needs its own typed driver path (`pgx`, say). The build would either plan
against that database too, or use the indexes the spec declares.

**The hard part: the single writer.** The runtime assumes it sees every commit, because it
makes them all:
- **the data version:** `seq`, kept in-process (`rt/store.go`);
- **live pages:** each commit's keys are hashed and sent to open pages (`rt/live.go`);
- **the caches:** the fragment and page caches drop what a commit touches (`rt/cache.go`, `rt/pagecache.go`);
- **request reads:** repeated reads are kept until the request writes.

With two app servers on one database, the other server's commits never reach this one.

## What a second backend would do, in order

1. **A storage interface in `rt`:**
   - typed bind and scan;
   - transactions with savepoints;
   - a source for the data version;
   - a change feed of committed keys.

   SQLite becomes its first implementation, with no change in behavior. This step alone is worth
   doing only when step 2 is about to follow.
2. **Make the data version and the change feed the database's:**
   - a sequence, plus a commit log of each commit's keys;
   - `LISTEN/NOTIFY` (or polling the log) to drive live pages and cache drops on every server.

   This is most of the work, and the riskiest, so it comes before any dialect work.
3. **A dialect layer** for the SQL listed by `sqlite-confined.test.ts`, and DDL and migrations
   generated per backend (`lang/schema.ts`, `rt/migrate.go`).
4. **Indexes:**
   - start from the indexes the spec declares;
   - later, plan against the target database if declared ones fall short.
5. **Data:** move an app's data across with the runtime's export and `import`. Both stores load
   the same neutral rows.

## How we'd know it works

These checks compare what an app does, not the SQL it runs, so they apply to a second backend
unchanged:
- **The Lean reference** (`tools/lean-crosscheck/diff-go.ts`). The compiled app's results must be
  outcomes the Lean interpreter allows, which is independent of where rows live. Run it against
  both backends.
- **Browser tests:**
  - `lang/browser/behaviors.test.ts`;
  - `apps/campfire/test/behaviors.test.ts`;
  - TodoMVC's `e2e.mjs`.
- **Rails parity:** `apps/campfire/test/ui/ui.test.ts`.
- **Live updates across servers:** a new test with two app servers on one database. One page
  must update when the other server commits. Nothing tests this today, because it can't happen
  on SQLite.

## Until then

- **SQLite-specific code:** keep new SQLite-only SQL inside the files `sqlite-confined.test.ts`
  lists. When a new one is really needed, add it there, with a line here on what a second
  backend would do instead.
- **The single-writer assumption:** keep it in `store.go`, `live.go` and the caches. Generated
  code shouldn't depend on it.
