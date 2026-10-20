// A loop that only ensures a row for each of its rows runs as one batch (gen.ts ensureLoop):
// the rows already there found in one query, the rest inserted many per statement. It keeps
// ensure's meaning: a row already there is kept, not doubled; defaults are worked out per row;
// running it again adds nothing.
//   node lang/test/batch.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";
import { generate } from "../gogen/gen.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };
const SPEC = `
app t { name "T" actor User }
entity User { name: Text  token: Text?  active: Bool }
identity login: User.token from cookie "login"
entity Group { name: Text  kind: Text }
entity Member { group: Group on delete cascade  user: User on delete cascade  role: Text = if .group.kind == "staff" { "admin" } else { "member" }  unique (group, user) }
action add_all(g: Group) { for each u in User where .active == true { ensure Member { group: g, user: u } } }
`;
const dir = mkdtempSync(join(tmpdir(), "batch-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const go = Object.values(generate(join(dir, "app.crud"))).join("\n");
ok("the loop is one batched ensure", /CTE_Member_\d+\(c, recs\d+\)/.test(go) && !/C_Member\(c, f/.test(go));
const app = await startApp(join(dir, "app.crud"), 13909);
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  const R = (e: string, id: number) => ({ ref: e, id });
  // 40 active people (more than one insert statement's rows) and one who isn't; one already a member
  const users = Array.from({ length: 41 }, (_, i) => row(i + 1, { name: `u${i + 1}`, token: null, active: i < 40 }));
  await app.post("/_test/load", { clock: 1000, rows: { User: users, Group: [row(1, { name: "g", kind: "staff" })], Member: [row(1, { group: R("Group", 1), user: R("User", 3), role: "kept" })] } });
  const call = async () => (await fetch(app.base + "/_do/add_all", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test-Actor": "User:1" }, body: new URLSearchParams({ g: "1" }), redirect: "manual" })).headers.get("X-Crudspec-Outcome");
  const members = async () => ((await app.post("/_test/dump", {})).rows.Member as any[]);
  ok("ran", (await call()) === "ok");
  const m = await members();
  const byUser = new Map<number, any[]>();
  for (const x of m) byUser.set(x.fields.user.id, [...(byUser.get(x.fields.user.id) ?? []), x]);
  ok("every active person is a member once", byUser.size === 40 && [...byUser.values()].every((l) => l.length === 1), [...byUser].filter(([, l]) => l.length !== 1));
  ok("... not the inactive one", !byUser.has(41));
  ok("... the member already there is kept as it was", byUser.get(3)?.[0].id === 1 && byUser.get(3)?.[0].fields.role === "kept", byUser.get(3));
  ok("... the new ones have their default", [...byUser].filter(([u]) => u !== 3).every(([, l]) => l[0].fields.role === "admin"));
  ok("... with ids of their own", new Set(m.map((x) => x.id)).size === m.length);
  ok("again", (await call()) === "ok");
  ok("... adds nothing", (await members()).length === 40);
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
