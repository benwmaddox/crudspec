// Every write can set a column back to NULL: a set to none, a set-based loop's set to none
// (c.SetWhere), and a create that leaves an optional field out; read back from the database
// itself, not the app's copy.
//   node lang/test/nulls.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };
const SPEC = `
app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Task { title: Text  note: Text?  due: Time?  points: Int?  done: Bool?  owner: User? on delete cascade }
action fill(t: Task, u: User) { set t.note = "n"  set t.due = now  set t.points = 3  set t.done = true  set t.owner = u }
action clear(t: Task) { set t.note = none  set t.due = none  set t.points = none  set t.done = none  set t.owner = none }
action clear_all() { for each t in Task where .title != "" { set t.note = none } }
action add(title: Text) { create Task { title: title } }
`;
const dir = mkdtempSync(join(tmpdir(), "nulls-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13907);
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  await app.post("/_test/load", { clock: 1000, rows: { User: [row(1, { name: "ada", token: null })], Task: [row(1, { title: "a", note: null, due: null, points: null, done: null, owner: null }), row(2, { title: "b", note: "x", due: null, points: null, done: null, owner: null })] } });
  const call = async (action: string, args: Record<string, string>) => (await fetch(app.base + "/_do/" + action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test-Actor": "User:1" }, body: new URLSearchParams(args), redirect: "manual" })).headers.get("X-Crudspec-Outcome");
  const dump = async () => ((await app.post("/_test/dump", {})).rows.Task as any[]);
  const task = async (id: number) => (await dump()).find((t: any) => t.id === id).fields;
  ok("filled", (await call("fill", { t: "1", u: "1" })) === "ok");
  const f = await task(1);
  ok("... every field has a value", f.note === "n" && f.due !== null && f.points === 3 && f.done === true && f.owner !== null, f);
  ok("cleared", (await call("clear", { t: "1" })) === "ok");
  const c = await task(1);
  ok("... every field is NULL again", c.note === null && c.due === null && c.points === null && c.done === null && c.owner === null, c);
  ok("a loop's set to none", (await call("clear_all", {})) === "ok" && (await task(2)).note === null, await task(2));
  ok("a create leaving the optional fields out", (await call("add", { title: "c" })) === "ok");
  const n = (await dump()).find((t: any) => t.fields.title === "c")?.fields;
  ok("... they are NULL", n && n.note === null && n.due === null && n.points === null && n.done === null && n.owner === null, n);
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
