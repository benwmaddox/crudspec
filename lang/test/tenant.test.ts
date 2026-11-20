// Moving one tenant between installs: `app export --tenant` writes a row and everything a cascade
// from it reaches, with the rows outside it they refer to matched by a unique field (--match), and
// `app import --add` elsewhere adds them beside what's there, using a matched row the other
// install already has.
//   node lang/test/tenant.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compiledApp } from "../gogen/program.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail).slice(0, 1500)); } };

const SPEC = `
app t { name "T" actor User }
entity User { name: Text  email: Email private  password: Password  unique (email) }
entity Login { who: User on delete cascade  token: Text = token(24)  unique (token) }
identity login: Login.token from cookie "login"
entity Team { name: Text  owner: User on delete restrict  logo: File? }
entity Project { team: Team on delete cascade  title: Text  owner: User }
entity Task { project: Project on delete cascade  title: Text  by: User? on delete nullify }
entity Pin { team: Team on delete cascade  task: Task? on delete nullify }
policy rows: true for rows of Team
`;
const dir = mkdtempSync(join(tmpdir(), "tenant-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = compiledApp(join(dir, "app.crud"));
const ref = (r: string, id: number) => ({ ref: r, id });
const file = { stored: "k1.png", file: "logo.png", content_type: "image/png", size: 3 };
const A = { now: 1000, rows: {
  User: [{ id: 1, fields: { name: "Ann", email: "ann@example.test", password: { password: "secret-pw" } } }, { id: 2, fields: { name: "Bo", email: "bo@example.test", password: { password: "secret-pw" } } }, { id: 3, fields: { name: "Cy", email: "cy@example.test", password: { password: "secret-pw" } } }],
  Login: [{ id: 1, fields: { who: ref("User", 1), token: "t-ann" } }],
  Team: [{ id: 1, fields: { name: "Garden", owner: ref("User", 1), logo: file } }, { id: 2, fields: { name: "Roof", owner: ref("User", 3), logo: null } }],
  Project: [{ id: 1, fields: { team: ref("Team", 1), title: "Beds", owner: ref("User", 2) } }, { id: 2, fields: { team: ref("Team", 2), title: "Tiles", owner: ref("User", 3) } }],
  Task: [{ id: 1, fields: { project: ref("Project", 1), title: "Dig", by: ref("User", 1) } }, { id: 2, fields: { project: ref("Project", 2), title: "Lay", by: null } }],
  Pin: [{ id: 1, fields: { team: ref("Team", 1), task: ref("Task", 1) } }],
} };
const run = (data: string, args: string[], input?: string) => { const r = app.run([args[0], "--data", app.path(data), ...args.slice(1)], input); let j: any = null; try { j = JSON.parse(r.stdout.trim().split("\n").pop() ?? ""); } catch {} return { ...r, j }; };
const a = mkdtempSync(join(dir, "a-")), b = mkdtempSync(join(dir, "b-"));
ok("install A is loaded", run(a, ["import"], JSON.stringify(A)).status === 0);

// ---- export: the team and what's inside it, its users matched by email
const bad = run(a, ["export", "--tenant", "Team:1"]);
ok("a reference outside the tenant, with no --match: an error naming it", bad.status !== 0 && /Team 1's owner is User 1, outside the tenant: say --match User/.test(bad.j?.error ?? ""), bad.j);
ok("--match must be a unique field", run(a, ["export", "--tenant", "Team:1", "--match", "User:name"]).status !== 0);
const ex = run(a, ["export", "--tenant", "Team:1", "--match", "User:email"]);
const rows = ex.j?.rows ?? {};
const ids = (e: string) => (rows[e] ?? []).map((r: any) => r.id).join();
ok("export: the team, and every row a cascade from it reaches (projects, their tasks, its pins)", ex.status === 0 && ids("Team") === "1" && ids("Project") === "1" && ids("Task") === "1" && ids("Pin") === "1", ex.j ?? ex.stderr);
ok("... the users its rows name, matched by email, with their password hashes; not the others, nor sessions", ids("User") === "1,2" && rows.User.every((u: any) => u.match === "email" && /\S/.test(u.fields.password) && u.fields.password !== "secret-pw") && !rows.Login, rows.User);
ok("... and the files its rows hold", JSON.stringify(ex.j?.files) === JSON.stringify(["k1.png"]), ex.j?.files);

// ---- import --add into install B, which has Bo's account (another id) and rows of its own
const B = { now: 2000, rows: {
  User: [{ id: 1, fields: { name: "Dee", email: "dee@example.test", password: { password: "secret-pw" } } }, { id: 2, fields: { name: "Bo (B)", email: "bo@example.test", password: { password: "other-pw" } } }],
  Team: [{ id: 1, fields: { name: "Shed", owner: ref("User", 1), logo: null } }],
} };
ok("install B is loaded", run(b, ["import"], JSON.stringify(B)).status === 0);
const added = run(b, ["import", "--add"], JSON.stringify(ex.j));
ok("import --add: the team comes, Bo matched to B's own account, Ann added", added.status === 0 && added.j?.kept === true && added.j.matched?.User === 1 && added.j.imported?.User === 1 && added.j.imported?.Team === 1, added.j ?? added.stderr);
{
  const db = new DatabaseSync(join(b, "app.sqlite"), { readOnly: true });
  const q = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any;
  const team = Number(added.j.ids.Team["1"]), project = Number(added.j.ids.Project["1"]);
  const boB = Number(q(`SELECT id FROM "User" WHERE email = 'bo@example.test'`).id);
  const ann = Number(q(`SELECT id FROM "User" WHERE email = 'ann@example.test'`).id);
  ok("... the project's owner is B's Bo; the team's owner is the Ann who came", Number(q(`SELECT owner FROM "Project" WHERE id = ?`, project).owner) === boB && Number(q(`SELECT owner FROM "Team" WHERE id = ?`, team).owner) === ann && boB === 2);
  ok("... B's Bo keeps his own name and password", q(`SELECT name FROM "User" WHERE id = 2`).name === "Bo (B)");
  const da = new DatabaseSync(join(a, "app.sqlite"), { readOnly: true });
  const hashA = (da.prepare(`SELECT password FROM "User" WHERE email = 'ann@example.test'`).get() as any).password;
  da.close();
  ok("... Ann's password hash came as it was, so her password still signs her in", q(`SELECT password FROM "User" WHERE id = ?`, ann).password === hashA && /\S{20,}/.test(hashA));
  ok("... and B's own rows are as they were", q(`SELECT count(*) AS n FROM "Team"`).n === 2 && q(`SELECT name FROM "Team" WHERE id = 1`).name === "Shed");
  db.close();
}
process.exit(failed ? 1 : 0);
