// The requests' readers (DB.R) are a session's own: a request takes one as its snapshot and holds
// it while its page renders. Anything else that reads beside a request (a row's address, who may
// read a file, an agent's token, /up) takes a lookup reader (DB.A) instead. Taking a second reader
// from DB.R while a request holds one is a wait that can last forever: 32 requests at once each
// held one and waited for another (lang/test/concurrency.test.ts). This fails when DB.R is used
// directly in a file not listed, so a new lookup can't bring it back.
// - Reading beside a request: use DB.A (db.A.QueryRow, .Query), and don't wait on DB.R while
//   holding it.
// - A new place a session reads for itself: list it here, saying why it's the session's own.
//   node lang/test/pool-rule.test.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 1)); } };

// where a reader from DB.R is taken, and why that's the session's own
const ALLOWED: Record<string, string> = {
  "stmts.go": "a session's statements: its snapshot reader, or one per statement for a session without one",
  "store.go": "a session's queries, as stmts.go",
  "search.go": "the search index's set-up, when the app starts, before any request",
};

const dir = join(import.meta.dirname, "..", "gogen", "rt");
const uses: Record<string, number[]> = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))) {
  readFileSync(join(dir, f), "utf8").split(/\r?\n/).forEach((line, i) => {
    // any name ending DB or db (addressDB, sv.App.DB, db): a row's own field R (r.R.Get) isn't one
    if (/(DB|db)\.R\.(Query|QueryRow|Get)\(/.test(line)) (uses[f] ??= []).push(i + 1);
  });
}
const strays = Object.entries(uses).filter(([f]) => !ALLOWED[f]).map(([f, lines]) => `${f}:${lines.join(",")}`);
ok("a request's readers (DB.R) are taken only where a session reads for itself; other lookups use DB.A", strays.length === 0, { "take a lookup reader (DB.A) here instead": strays });
const gone = Object.keys(ALLOWED).filter((f) => !uses[f]);
ok("... and every listed file still takes one (take out what's gone)", gone.length === 0, gone);
ok("it looked at the runtime", Object.keys(uses).length > 0 && readdirSync(dir).length > 20);
process.exit(failed ? 1 : 0);
