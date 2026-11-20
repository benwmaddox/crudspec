// SQLite stays in known places. crudspec runs on SQLite today, and keeps the option of another
// database open (docs/STORAGE-BACKENDS.md). What a second backend would have to replace is listed
// below: SQL only SQLite speaks, its library, and its planner. This fails when one of them shows
// up in a file not listed, or a file uses one it didn't before, so a new feature doesn't spread
// SQLite through the compiler unnoticed.
// - Adding one on purpose: put it in a file already listed if it fits there; otherwise add the
//   file here, and say in docs/STORAGE-BACKENDS.md what a second backend would do instead.
// - Removing one: take it out of the list (the test says when a listed one is gone).
//   node lang/test/sqlite-confined.test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail, null, 1)); } };

// what only SQLite has (each found as a whole word, case as SQLite's docs write it)
const PATTERNS: Record<string, RegExp> = {
  "PRAGMA": /\bPRAGMA\b/,
  "json_each": /\bjson_each\b/,
  "json_extract": /\bjson_extract\b/,
  "sqlite_master": /\bsqlite_master\b/,
  "sqlite_sequence": /\bsqlite_sequence\b/,
  "INSERT OR": /\bINSERT OR (REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\b/,
  "rowid": /\browid\b/i,
  "VACUUM": /\bVACUUM\b/,
  "AUTOINCREMENT": /\bAUTOINCREMENT\b/,
  "GLOB": /\bGLOB\b/,
  "fts5": /\bfts5\b/i,
  "strftime/julianday": /\b(strftime|julianday|unixepoch)\s*\(/,
  "last_insert_rowid": /\blast_insert_rowid\b/,
  // the library: SQLite's C API, its Go driver, Node's SQLite (the build plans queries with it)
  "sqlite3 C API": /\bsqlite3_[a-z_]+\b/,
  "go-sqlite3": /mattn\/go-sqlite3/,
  "node:sqlite": /["']node:sqlite["']/,
};

// where each is allowed, and why there (what a second backend would replace)
const ALLOWED: Record<string, string[]> = {
  // the runtime's storage: the one writer, its readers, WAL, the data version
  "lang/gogen/rt/store.go": ["PRAGMA", "json_each", "go-sqlite3"],
  "lang/gogen/rt/lite.go": ["sqlite3 C API", "go-sqlite3"],                   // SQLite called directly
  "lang/gogen/rt/sqlfuncs.go": ["sqlite3 C API"],                            // the runtime's text functions, registered in SQLite
  "lang/gogen/rt/sqlfuncs_export.go": ["sqlite3 C API"],                     // what SQLite calls for them (cgo: an export in a file of its own)
  "lang/gogen/rt/main.go": ["sqlite_master"],                                // the database's version check
  "lang/gogen/rt/stmts.go": ["json_each", "sqlite_master"],                  // statements on a set of ids
  "lang/gogen/rt/live.go": ["json_each"],                                    // live keys' rows by id
  "lang/gogen/rt/helpers.go": ["json_each"],
  "lang/gogen/rt/codecs.go": ["json_each"],
  "lang/gogen/rt/agents.go": ["INSERT OR"],                                  // a token's last use
  "lang/gogen/rt/schedule.go": ["INSERT OR"],                                // a schedule's run, once
  // the generator: SQL it writes, and the build's query plans (cost pass)
  "lang/gogen/gen.ts": ["json_each", "rowid", "sqlite_master", "node:sqlite", "fts5"],
  "lang/gogen/livekeys.ts": ["json_each"],
  "lang/cost.ts": ["node:sqlite"],
  "lang/cli.ts": ["node:sqlite", "fts5"],                                   // builds with SQLite's FTS5 (the search index)
  "lang/gogen/rt/search.go": ["sqlite_master", "rowid", "fts5"],           // the search index: an FTS5 table and its triggers
  // the TypeScript runtime's store and upgrades (migrations, checks before an upgrade)
  "lang/runtime/store-sqlite.ts": ["PRAGMA", "json_each", "json_extract", "sqlite_master", "node:sqlite"],
  "lang/runtime/upgrade.ts": ["PRAGMA", "VACUUM", "sqlite_master", "node:sqlite"],
};

const root = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const files: string[] = [];
const walk = (d: string): void => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (!["node_modules", "test", "browser"].includes(n)) walk(p); continue; }
    if (/\.(ts|go)$/.test(n) && !n.endsWith("_test.go")) files.push(p);
  }
};
walk(join(root, "lang"));

const found: Record<string, string[]> = {};
for (const f of files) {
  const rel = relative(root, f).replace(/\\/g, "/");
  const src = readFileSync(f, "utf8");
  const hits = Object.entries(PATTERNS).filter(([, re]) => re.test(src)).map(([k]) => k);
  if (hits.length) found[rel] = hits;
}

const outside = Object.entries(found).flatMap(([f, ks]) => ks.filter((k) => !(ALLOWED[f] ?? []).includes(k)).map((k) => `${f}: ${k}`));
ok("SQLite-only SQL and SQLite's library appear only where listed", outside.length === 0, outside.length ? { "not listed (see the top of this file)": outside } : undefined);
const gone = Object.entries(ALLOWED).flatMap(([f, ks]) => ks.filter((k) => !(found[f] ?? []).includes(k)).map((k) => `${f}: ${k}`));
ok("... and every listed one is still there (take out what's gone)", gone.length === 0, gone.length ? { "listed but not found": gone } : undefined);
ok(`it looked at the compiler and runtime (${files.length} files)`, files.length > 40);
process.exit(failed ? 1 : 0);
