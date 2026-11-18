// Two generator bugs the Go-versus-Lean differential check found (tools/lean-crosscheck/diff-go.ts),
// run in a compiled app:
// - a singleton has no row until something makes it: its fields read as none then (the typed
//   code read a required Text field as "", so `code == Settings.code` passed for an empty code),
//   and a set on it is refused (not_found) rather than a crash;
// - batched ensure loops that give the same fields but vary different ones (over rooms, over
//   users) each get a function of their own (they shared one, so a new user joined one room).
//   node lang/test/singleton-ensure.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };

const SRC = `app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
singleton Settings { code: Text  open: Bool = true }
entity Room { name: Text  open: Bool = true }
entity Member { room: Room on delete cascade  user: User on delete cascade  unique (room, user) }
on create User as u { for each r in Room where .open { ensure Member { room: r, user: u } } }
action setup(code: Text) { callers people  create Settings { code: code } }
action join(code: Text, name: Text) { callers people  require code == Settings.code else not_found  create User { name: name } }
action recode(code: Text) { callers people  set Settings.code = code }
action add_room(name: Text) { callers people  create Room { name: name } as r  for each u in User where true { ensure Member { room: r, user: u } } }
`;
const dir = mkdtempSync(join(tmpdir(), "singleton-ensure-"));
writeFileSync(join(dir, "app.crud"), SRC);
const app = await startApp(join(dir, "app.crud"), 13971);
const run = (call: string, args: unknown) => app.post("/_test/run", { call, args, actor: null, now: 10_000 });
const rows = async (e: string) => (await app.post("/_test/dump", {})).rows[e] ?? [];
try {
  await app.post("/_test/load", { clock: 1000, rows: {} });
  const j = await run("join", { code: "", name: "a" });
  ok("before setup, join with an empty code is refused (Settings.code is none, not \"\")", j.outcome === "not_found", j);
  ok("... and makes no user", (await rows("User")).length === 0);
  const rc = await run("recode", { code: "x" });
  ok("before setup, a set on the singleton is refused (not_found), not a crash", rc.outcome === "not_found" && rc.status === 200, rc);
  await run("setup", { code: "k" });
  ok("after setup, the right code joins", (await run("join", { code: "k", name: "b" })).outcome === "ok");
  ok("... and an empty code doesn't", (await run("join", { code: "", name: "c" })).outcome === "not_found");

  const row = (id: number, fields: any) => ({ id, seq: id, created: 1, updated: 1, fields });
  await app.post("/_test/load", { clock: 1000, rows: {
    Settings: [row(1, { code: "k", open: true })],
    Room: [row(1, { name: "one", open: true }), row(2, { name: "two", open: true }), row(3, { name: "shut", open: false })],
    User: [row(1, { name: "old" })],
  } });
  await run("join", { code: "k", name: "new" });
  const ms = (await rows("Member")).map((m: any) => `${m.fields.room.id}/${m.fields.user.id}`).sort();
  ok("a new user joins every open room (the loop over rooms has its own batch function)", JSON.stringify(ms) === JSON.stringify(["1/2", "2/2"]), ms);
  await run("add_room", { name: "three" });
  const ms2 = (await rows("Member")).map((m: any) => `${m.fields.room.id}/${m.fields.user.id}`).sort();
  ok("a new room gets every user (the loop over users, in the same app)", ms2.includes("4/1") && ms2.includes("4/2"), ms2);
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
