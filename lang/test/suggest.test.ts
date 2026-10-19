// Suggested invariants: what the data holds (the compiled app mines it: rt/suggest.go), proven
// against the spec's actions (cli suggest-invariants). A fact no action can break is put forward;
// one an action can break comes with the counterexample.
//   node lang/test/suggest.test.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { upgrade } from "../runtime/upgrade.ts";
import { SqliteStore } from "../runtime/store-sqlite.ts";
import { specMeta, Store } from "../rows.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)); } };
const SPEC = `app t { name "T" actor User }
enum Kind { task, bug }
enum State { open, done }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Ticket { title: Text  kind: Kind = task  state: State = open  closed_note: Text?  owner: User on delete cascade }
action add(title: Text, kind: Kind) { require actor != none else forbidden  create Ticket { title: title, kind: kind, owner: actor } }
action close(t: Ticket, note: Text) { require actor != none and t.owner == actor else forbidden  set t.state = done  set t.closed_note = note }
action reopen(t: Ticket) { require actor != none and t.owner == actor else forbidden  set t.state = open }
`;
const dir = mkdtempSync(join(tmpdir(), "suggest-"));
const specPath = join(dir, "app.crud"); writeFileSync(specPath, SPEC);
const data = join(dir, "data"); const dbPath = join(data, "app.sqlite");
const { mkdirSync } = await import("node:fs"); mkdirSync(data);
const spec = parse(SPEC);
upgrade(dbPath, spec, { apply: true, now: 1000 });
const store = new SqliteStore(dbPath, specMeta(spec));
const it = { store: store.load() ?? new Store() };
const ada = it.store.insert("User", { name: "Ada", token: null }, 1);
for (let i = 0; i < 12; i++) {
  const done = i % 2 === 0;
  it.store.insert("Ticket", { title: `t${i}`, kind: i < 6 ? "task" : "bug", state: done ? "done" : "open", closed_note: done ? "fixed" : null, owner: { ref: "User", id: ada.id } }, 2);
}
store.persist(it.store); store.db.close();
const r = spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "suggest-invariants", specPath, "--data", data, "--json"], { encoding: "utf8" });
let out: any;
try { out = JSON.parse(r.stdout); } catch { ok("suggest-invariants ran", false, r.stdout + r.stderr); process.exit(1); }
const proven = out.proven.map((c: any) => c.invariant), dropped = out.dropped.map((c: any) => c.invariant);
ok("closed tickets have a note: proven (close sets both)", proven.includes("all(.closed_note != none for Ticket where .state == done)"), out);
ok("open tickets have none: the data holds it, but reopen breaks it, with the counterexample", dropped.includes("all(.closed_note == none for Ticket where .state == open)") && out.dropped.some((c: any) => /reopen breaks it/.test(c.why)), out.dropped);
ok("a fact about one row's value that doesn't vary isn't put forward as a split", !proven.some((c: string) => /where \.kind == task\)$/.test(c) && /\.state/.test(c)), proven);
process.exit(failed ? 1 : 0);
