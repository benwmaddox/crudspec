// The compiled app upgrades its own database (rt/upgrade.go), with no Node on the server: as it
// starts, after a backup; refusing what the spec doesn't settle (exit 3, the database as it was);
// refusing a database already upgraded past it (an older release started again); and
// `app migrate` refusing while the app serves the data, its --plan working all the same.
//   node lang/test/app-upgrade.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compiledApp, type Program } from "../gogen/program.ts";

let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(typeof info === "string" ? info : JSON.stringify(info, null, 1)); } };
const wsl = process.platform === "win32";

const V1 = `entity Person { name: Text }
entity Task { title: Text  owner: Person }
policy people: true for rows of Person
policy tasks: true for rows of Task
// Adds a task.
action add(title: Text, owner: Person) { create Task { title: title, owner: owner } }
`;
// a tighter size on a table others refer to (it's rebuilt), a new field with a default, a migration
const V2 = V1.replace("entity Person { name: Text }", "entity Person { name: Text max 40 }")
  .replace("owner: Person }", "owner: Person  done: Bool = false  points: Int = 1 }")
  + `migration "score" { for each t in Task { set t.points = 5 } }\n`;
// a new required field with no default and no migration: the app can't fill it
const V3 = V2.replace("points: Int = 1 }", "points: Int = 1  priority: Text }").replace("owner: owner }", "owner: owner, priority: \"high\" }");

const work = mkdtempSync(join(tmpdir(), "app-upgrade-"));
const program = (name: string, src: string): Program => { const f = join(mkdtempSync(join(work, name + "-")), "app.crud"); writeFileSync(f, src); return compiledApp(f); };
const v1 = program("v1", V1), v2 = program("v2", V2), v3 = program("v3", V3);
const data = join(work, "data"), db = join(data, "app.sqlite");
const rows = (sql: string) => { const d = new DatabaseSync(db, { readOnly: true }); const r = d.prepare(sql).all(); d.close(); return r as any[]; };
const version = () => rows(`select max(version) v from crudspec_versions`)[0].v;

// the app serving the data: until it answers /up, or it exits (its code and what it said)
const port = 13961;
async function serve(p: Program, args: string[] = []): Promise<{ up: boolean; code: number | null; err: string; stop: () => void }> {
  const bin = p.binary(), flags = ["--data", p.path(data), "--port", String(port), ...args];
  const cmd = wsl ? spawn("wsl", ["-e", bin, ...flags]) : spawn(bin, flags);
  let err = "", code: number | null = null, exited = false;
  cmd.stderr.on("data", (b) => (err += b));
  cmd.on("exit", (c) => { code = c; exited = true; });
  const stop = () => { if (wsl) spawnSync("wsl", ["-e", "bash", "-c", `pkill -f -- "--port ${port}" || true`]); cmd.kill(); };
  for (let i = 0; i < 300; i++) {
    if (exited) return { up: false, code, err, stop };
    try { if ((await fetch(`http://127.0.0.1:${port}/up`)).ok) return { up: true, code, err, stop }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  return { up: false, code, err, stop };
}
const stopped = async (s: { stop: () => void }) => { s.stop(); for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/up`); } catch { return; } await new Promise((r) => setTimeout(r, 100)); } };

// v1, with rows
{ const s = await serve(v1, ["--test"]);
  ok("v1 starts on new data", s.up, s.err);
  const load = await fetch(`http://127.0.0.1:${port}/_test/load`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clock: 1000, seq: 4, rows: {
    Person: [{ id: 1, seq: 1, created: 1, updated: 1, fields: { name: "Ada" } }, { id: 2, seq: 2, created: 1, updated: 1, fields: { name: "Bob" } }],
    Task: [{ id: 1, seq: 3, created: 1, updated: 1, fields: { title: "Write", owner: { ref: "Person", id: 1 } } }, { id: 2, seq: 4, created: 1, updated: 1, fields: { title: "Ship", owner: { ref: "Person", id: 2 } } }],
  } }) });
  ok("v1 holds two people and two tasks", load.ok && rows(`select count(*) n from Task`)[0].n === 2, load.status);
  await stopped(s); }

// v2 starts on v1's data: upgraded as it starts, a backup first
{ const s = await serve(v2);
  ok("v2 upgrades v1's data as it starts, and serves", s.up && version() === 2, s.err);
  ok("the upgrade: the default, the migration, the references kept", rows(`select done, points, owner from Task order by id`).map((r) => `${r.done}/${r.points}/${r.owner}`).join() === "0/5/1,0/5/2", rows(`select * from Task`));
  ok("the referenced table was rebuilt with its size check", /length\("name"\) <= 40/.test(rows(`select sql from sqlite_master where name = 'Person'`)[0].sql), rows(`select sql from sqlite_master where name = 'Person'`));
  ok("a backup of the version before", existsSync(join(data, "backups")) && readdirSync(join(data, "backups")).some((f) => /^app-v1-\d+\.sqlite$/.test(f)), existsSync(join(data, "backups")) ? readdirSync(join(data, "backups")) : "no backups");
  // while it serves: app migrate refuses, its plan works
  const apply = v3.run(["migrate", "--data", v3.path(data), "--json"], "");
  const plan = v3.run(["migrate", "--data", v3.path(data), "--plan", "--json"], "");
  const pj = (() => { try { return JSON.parse(plan.stdout); } catch { return null; } })();
  ok("app migrate while the app serves the data: refused (exit 3)", apply.status === 3 && /running/.test(apply.stdout), apply);
  ok("app migrate --plan while it serves: v3's new required field is refused, rows named", plan.status === 3 && pj?.status === "blocked" && pj.checks.some((c: any) => c.check === "required" && c.count === 2), plan);
  await stopped(s); }

// v3 won't start: the database stays at v2
{ const before = version();
  const s = await serve(v3);
  ok("v3 refuses to start (exit 3), the database as it was", !s.up && s.code === 3 && version() === before && /refused/.test(s.err), { code: s.code, err: s.err }); }

// v1 again on v2's data: an older release, refused with how to go back
{ const s = await serve(v1);
  ok("v1 on data upgraded past it: refused (exit 3), pointing at the backups", !s.up && s.code === 3 && /upgraded past this build/.test(s.err) && version() === 2, { code: s.code, err: s.err }); }

// v2 again: current, starts at once
{ const s = await serve(v2);
  ok("v2 again: starts, nothing to upgrade", s.up && version() === 2, s.err);
  await stopped(s); }

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
