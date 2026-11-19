// Builtins over a query's list, done by SQL rather than by reading every row into the app
// (docs/design/sql-first.md): any(list(…)) and count(list(…)) are a count, first(…) and last(…)
// read one row, distinct(list(.f …)) reads the first row of each value, count(distinct(…)) is
// SQL's count of distinct values (none is one), and all(p for E where q) outside a where is "no row
// of q where not p". Each answers exactly as the app's own reduction would.
//   node lang/test/sql-reduce.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, inApp } from "../gogen/gen.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app t { name "T" actor User }
entity User { name: Text  token: Text?  unique (token) }
identity login: User.token from cookie "login"
entity Shop { name: Text }
entity Item { shop: Shop  name: Text  kind: Text  tag: Text?  n: Int }
policy ps: true for rows of Shop
policy pi: true for rows of Item
action any_of(s: Shop) { callers people  set actor.name = if any(list(.name for Item where .shop == s)) { "yes" } else { "no" } }
action first_of(s: Shop) { callers people  set actor.name = default(first(list(.name for Item where .shop == s order by .name)), "-") }
action last_of(s: Shop) { callers people  set actor.name = default(last(list(.name for Item where .shop == s order by .name)), "-") }
action kinds(s: Shop) { callers people  set actor.name = join(distinct(list(.kind for Item where .shop == s)), ",") }
action ntags(s: Shop) { callers people  set actor.name = text(count(distinct(list(.tag for Item where .shop == s)))) }
action all_pos(s: Shop) { callers people  set actor.name = if all(.n > 0 for Item where .shop == s) { "yes" } else { "no" } }
`;
const dir = mkdtempSync(join(tmpdir(), "sql-reduce-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const go = generate(join(dir, "app.crud"))["app.go"];
ok("nothing is reduced in the app", inApp().length === 0, inApp());
ok("no rows read to reduce: no AllRows, any or count of a read list", !go.includes("c.AllRows(") && !go.includes("rt.B_any(") && !go.includes("rt.B_count("), go.match(/rt\.B_(any|count)\([^\n]{0,80}|c\.AllRows\([^\n]{0,80}/g));
ok("distinct by SQL (DistinctRows), count of distinct by SQL (CountDistinct)", go.includes("c.DistinctRows(") && go.includes("c.CountDistinct("));

const app = await startApp(join(dir, "app.crud"), 14011);
try {
  const row = (id: number, fields: any) => ({ id, seq: id, created: id, updated: id, fields });
  const ref = (e: string, id: number) => ({ ref: e, id });
  await app.post("/_test/load", { clock: 1000, rows: {
    User: [row(1, { name: "", token: "t" })],
    Shop: [row(1, { name: "one" }), row(2, { name: "empty" })],
    Item: [
      row(1, { shop: ref("Shop", 1), name: "b", kind: "x", tag: null, n: 1 }),
      row(2, { shop: ref("Shop", 1), name: "a", kind: "y", tag: "t", n: 2 }),
      row(3, { shop: ref("Shop", 1), name: "c", kind: "x", tag: "t", n: 3 }),
      row(4, { shop: ref("Shop", 1), name: "d", kind: "x", tag: null, n: -1 }),
    ] } });
  const run = async (call: string, shop: number) => { const r = await app.post("/_test/run", { call, args: { s: ref("Shop", shop) }, actor: ref("User", 1), now: 0 }); return r.outcome === "ok" ? (await app.post("/_test/dump", {})).rows.User[0].fields.name : `(${r.outcome})`; };
  ok("any(list(…)): rows there", (await run("any_of", 1)) === "yes");
  ok("... none there", (await run("any_of", 2)) === "no");
  ok("first(list(… order by .name)): a", (await run("first_of", 1)) === "a");
  ok("last(list(… order by .name)): d", (await run("last_of", 1)) === "d");
  ok("first of no rows: none", (await run("first_of", 2)) === "-");
  ok("distinct(list(.kind …)): each value once, in the order first seen", (await run("kinds", 1)) === "x,y");
  ok("count(distinct(list(.tag …))): t and none, so 2", (await run("ntags", 1)) === "2");
  ok("... of no rows: 0", (await run("ntags", 2)) === "0");
  ok("all(.n > 0 …): one isn't", (await run("all_pos", 1)) === "no");
  ok("... of no rows: all is true", (await run("all_pos", 2)) === "yes");
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
