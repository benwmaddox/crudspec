// The SQL-first rule (docs/design/sql-first.md): a part of a query the database can't do is an
// error, QUERY_IN_APP, from check --deep and from build; in_app(…) around that part says it runs in the
// app, and then the rest is still SQL (only the rows it leaves are read), and the answer is the same.
//   node lang/test/in-app.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, inApp } from "../gogen/gen.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const HEAD = `app t { name "T" actor User }
entity User { name: Text  token: Text?  unique (token) }
identity login: User.token from cookie "login"
entity Shop { name: Text }
entity Item { shop: Shop  name: Text  n: Int }
policy ps: true for rows of Shop
policy pi: true for rows of Item
`;
const spec = (body: string) => { const d = mkdtempSync(join(tmpdir(), "in-app-")); writeFileSync(join(d, "app.crud"), HEAD + body); return d; };
const check = (d: string) => { const r = spawnSync(process.execPath, ["lang/cli.ts", "check", join(d, "app.crud"), "--deep"], { encoding: "utf8" }); return r.stdout + r.stderr; };

// n % 2 isn't SQL the planner writes: a part the app would test, row by row
const bare = spec(`action odd(s: Shop) { callers people  set actor.name = text(count(Item where .shop == s and .n % 2 == 1)) }
action by_mod(s: Shop) { callers people  set actor.name = join(list(.name for Item where .shop == s order by .n % 3), ",") }
`);
generate(join(bare, "app.crud"));
ok("the generator lists both parts it would leave to the app", inApp().map((x) => x.kind).sort().join(",") === "order,where", inApp());
const out = check(bare);
ok("check: QUERY_IN_APP for the condition, naming it", /error QUERY_IN_APP[^\n]*\.n % 2 == 1 can't be SQL/.test(out), out.slice(0, 1500));
ok("... and for the order", /error QUERY_IN_APP[^\n]*order by \.n % 3 can't be SQL/.test(out), out.slice(0, 1500));
const b = spawnSync(process.execPath, ["lang/cli.ts", "build", join(bare, "app.crud"), "--out", join(bare, "build")], { encoding: "utf8" });
ok("build refuses it", b.status !== 0 && /QUERY_IN_APP/.test(b.stdout + b.stderr), (b.stdout + b.stderr).slice(0, 800));

// said in_app: allowed, and the rest is still SQL
const marked = spec(`action odd(s: Shop) { callers people  set actor.name = text(count(Item where .shop == s and in_app(.n % 2 == 1))) }
action by_mod(s: Shop) { callers people  set actor.name = join(list(.name for Item where .shop == s order by in_app(.n % 3)), ",") }
`);
const go = generate(join(marked, "app.crud"))["app.go"];
ok("in_app(…): nothing left unsaid", inApp().length === 0, inApp());
ok("... the shop is still SQL's (only that shop's rows are read)", /SQL: "\(t0\.\\"shop\\" = \?\)"/.test(go) || go.includes(`(t0.\\"shop\\" = ?)`), go.match(/SQL: "[^"\n]*"/g)?.slice(0, 4));
ok("check: no QUERY_IN_APP", !/QUERY_IN_APP/.test(check(marked)));
const app = await startApp(join(marked, "app.crud"), 14012);
try {
  const row = (id: number, fields: any) => ({ id, seq: id, created: id, updated: id, fields });
  const ref = (e: string, id: number) => ({ ref: e, id });
  await app.post("/_test/load", { clock: 1000, rows: { User: [row(1, { name: "", token: "t" })], Shop: [row(1, { name: "one" }), row(2, { name: "two" })], Item: [
    row(1, { shop: ref("Shop", 1), name: "a", n: 5 }), row(2, { shop: ref("Shop", 1), name: "b", n: 4 }), row(3, { shop: ref("Shop", 1), name: "c", n: 3 }), row(4, { shop: ref("Shop", 2), name: "d", n: 7 }),
  ] } });
  const run = async (call: string) => { const r = await app.post("/_test/run", { call, args: { s: ref("Shop", 1) }, actor: ref("User", 1), now: 0 }); return r.outcome === "ok" ? (await app.post("/_test/dump", {})).rows.User[0].fields.name : `(${r.outcome})`; };
  ok("in_app(.n % 2 == 1): the shop's odd ones, 5 and 3 (not the other shop's 7)", (await run("odd")) === "2");
  ok("order by in_app(.n % 3): 3 (0), 4 (1), 5 (2)", (await run("by_mod")) === "c,b,a");
} finally { app.stop(); for (const d of [bare, marked]) rmSync(d, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
