// Work done in SQL rather than by reading rows into the app: a Bool field as a condition
// (.completed, not .completed) is SQL (= 1, or IS 1 for one that may be none, so not none is true),
// so count(Todo where .board == b and not .completed) is one SELECT count(*); and a loop that only
// sets fields (for each t in Todo where … { set t.completed = v }) is one UPDATE even when its rows
// touch a parent (on change touch), the parent touched for each row that changed.
//   node lang/test/sql-pushdown.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../gogen/gen.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app t { name "T" actor Board }
entity Board { token: Text  note: Text = ""  unique (token) }
identity v: Board.token from cookie "t"
entity Todo { board: Board on change touch  title: Text  completed: Bool = false  starred: Bool? }
policy own: .board == actor for rows of Todo
fn items_left(b: Board?): Int = count(Todo where .board == b and not .completed)
fn unstarred(b: Board?): Int = count(Todo where .board == b and not .starred)
action toggle_all() {
  require actor != none else not_found
  let all_done = actor.items_left() == 0
  for each t in Todo where .board == actor { set t.completed = not all_done }
}
action counts() { require actor != none else not_found  set actor.note = "{actor.items_left()} {actor.unstarred()}" }
`;
const dir = mkdtempSync(join(tmpdir(), "pushdown-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const go = generate(join(dir, "app.crud"))["app.go"];
const sqlOf = (name: string) => JSON.parse(go.match(new RegExp(`\\b${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")`))?.[1] ?? '""');
const fnBody = (name: string) => go.match(new RegExp(`func ${name}\\([^\\n]*`))?.[0] ?? "";
const countQ = (f: string) => { const qn = /qn\d+/.exec(fnBody(f))?.[0]; const st = qn && go.match(new RegExp(`func ${qn}\\([\\s\\S]*?s\\.Stmt\\((sq\\d+)\\)`))?.[1]; return st ? sqlOf(st) : `(no count query: ${fnBody(f).slice(0, 200)})`; };
ok("not .completed is SQL: items_left is one SELECT count(*), no rows read", /SELECT count\(\*\) FROM "Todo" t0 WHERE \(t0\."board" = \?\) AND \(NOT \(t0\."completed" = 1\)\)/.test(countQ("F_items_left")), countQ("F_items_left"));
ok("a Bool that may be none: IS 1, so not none counts as not starred", /NOT \(t0\."starred" IS 1\)/.test(countQ("F_unstarred")), countQ("F_unstarred"));
ok("the loop is one write (SetWhere), with the parent touch", /c\.SetWhere\(E_Todo, sq\d+, \[\]any\{[^}]*\}, \[\]int\{2\}, \[\]rt\.Val\{[^}]*\}, TP_Todo\)/.test(fnBody("A_toggle_all") + go.slice(go.indexOf("func A_toggle_all"), go.indexOf("func A_toggle_all") + 600)), go.slice(go.indexOf("func A_toggle_all"), go.indexOf("func A_toggle_all") + 600));

const app = await startApp(join(dir, "app.crud"), 14007);
try {
  const row = (id: number, f: any, updated = 0) => ({ id, seq: id, created: 0, updated, fields: f });
  const ref = (e: string, id: number) => ({ ref: e, id });
  await app.post("/_test/load", { clock: 1000, rows: { Board: [row(1, { token: "a", note: "" }), row(2, { token: "b", note: "" })], Todo: [
    row(1, { board: ref("Board", 1), title: "x", completed: false, starred: null }),
    row(2, { board: ref("Board", 1), title: "y", completed: true, starred: true }),
    row(3, { board: ref("Board", 2), title: "z", completed: false, starred: null }),
  ] } });
  const run = (call: string, actor: number, now: number) => app.post("/_test/run", { call, args: {}, actor: ref("Board", actor), now });
  let r = await app.post("/_test/run", { call: "counts", args: {}, actor: ref("Board", 1), now: 0 });
  const note = (await app.post("/_test/dump", {})).rows.Board.find((b: any) => b.id === 1).fields.note;
  ok("counts: 1 left, 1 unstarred (none is not starred)", note === "1 1", { r, note });
  r = await run("toggle_all", 1, 5000);
  let d = (await app.post("/_test/dump", {})).rows;
  const todo = (id: number) => d.Todo.find((t: any) => t.id === id), board = (id: number) => d.Board.find((b: any) => b.id === id);
  ok("toggle_all with one left: every todo of the board done; the other board's untouched", r.outcome === "ok" && todo(1).fields.completed === true && todo(2).fields.completed === true && todo(3).fields.completed === false, d.Todo);
  ok("only the row that changed is written (its updated time), and its board is touched", todo(1).updated === 5000 && todo(2).updated === 0 && board(1).updated === 5000 && board(2).updated === 0, { todos: d.Todo.map((t: any) => [t.id, t.updated]), boards: d.Board.map((b: any) => [b.id, b.updated]) });
  r = await run("toggle_all", 1, 6000);
  d = (await app.post("/_test/dump", {})).rows;
  ok("again, with all done: all active again", todo(1).fields.completed === false && todo(2).fields.completed === false && board(1).updated === 6000, d.Todo);
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
