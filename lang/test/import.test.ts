// `app import`: rows from another system into an app's database, kept only if everything fits. The ids and
// times the rows came with are kept; a size, a unique key, a required field or a type that doesn't fit is
// refused with the row named; every reference must name a row that is there and every invariant hold;
// a Password given in plain text is hashed (and signs in). Nothing is kept on a refusal or a dry run, and
// a database that has rows needs --replace.
//   node lang/test/import.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compiledApp } from "../gogen/program.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(typeof detail === "string" ? detail.slice(0, 600) : JSON.stringify(detail)); } };

const SPEC = `
app t { name "T" actor User }
entity User { name: Text max 20  email: Email  password: Password  token: Text?  unique (email) }
entity Login { who: User on delete cascade  token: Text = token(24)  unique (token) }
identity login: Login.token from cookie "login"
entity Project { title: Text max 30  owner: User  due: Time?  points: Int = 0  invariant self.points >= 0 }
entity Task { project: Project on delete cascade  title: Text  done: Bool = false  note: Text? }
permission read User: true
permission read Project: true
permission read Task: true
policy signed_in: actor != none else unauthenticated for every action
action sign_in(email: Email, password: Text) { skip policy signed_in  let u = the_or_none(User where .email == email)  require u != none and authenticates(u.password, password) else unauthenticated  create Login { who: u } as l  result l }
`;
const dir = mkdtempSync(join(tmpdir(), "import-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = compiledApp(join(dir, "app.crud"));
const ref = (r: string, id: number) => ({ ref: r, id });
const GOOD = {
  now: Date.parse("2027-01-05T12:00:00Z"),
  rows: {
    User: [{ id: 41, fields: { name: "Ann", email: "ann@example.test", password: { password: "secret-pw" }, token: null } }, { id: 42, created: 1000, updated: 2000, fields: { name: "Bob", email: "bob@example.test", password: { password: "other-pw" }, token: null } }],
    Project: [{ id: 7, fields: { title: "Garden", owner: ref("User", 41), due: Date.parse("2027-03-01T00:00:00Z"), points: 3 } }, { id: 9, fields: { title: "Roof", owner: ref("User", 42), due: null, points: 0 } }],
    Task: [{ fields: { project: ref("Project", 7), title: "Dig", done: true, note: null } }, { fields: { project: ref("Project", 7), title: "Plant", done: false, note: "tulips" } }],
  },
};
const run = (data: string, body: unknown, ...flags: string[]) => { const r = app.run(["import", "--data", app.path(data), ...flags], JSON.stringify(body)); let j: any = null; try { j = JSON.parse(r.stdout.trim().split("\n").pop() ?? ""); } catch { /* not JSON */ } return { status: r.status, out: j, stderr: r.stderr }; };
const counts = (data: string) => { if (!existsSync(join(data, "app.sqlite"))) return { User: 0, Project: 0, Task: 0 }; const db = new DatabaseSync(join(data, "app.sqlite"), { readOnly: true }); try { return Object.fromEntries(["User", "Project", "Task"].map((t) => [t, Number((db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as any).n)])); } finally { db.close(); } };
const fresh = () => mkdtempSync(join(dir, "data-"));
const empty = { User: 0, Project: 0, Task: 0 };

// ---- a good import
const d1 = fresh();
const good = run(d1, GOOD);
ok("a good import is kept, and says what it loaded", good.status === 0 && good.out?.kept === true && good.out.imported.User === 2 && good.out.imported.Project === 2 && good.out.imported.Task === 2 && good.out.problems.length === 0, good);
ok("... the rows are in the database", JSON.stringify(counts(d1)) === JSON.stringify({ User: 2, Project: 2, Task: 2 }));
{
  const db = new DatabaseSync(join(d1, "app.sqlite"), { readOnly: true });
  const u = db.prepare(`SELECT id, created, updated, name FROM "User" ORDER BY id`).all() as any[];
  const p = db.prepare(`SELECT id, owner, title FROM "Project" ORDER BY id`).all() as any[];
  const t = db.prepare(`SELECT id FROM "Task" ORDER BY id`).all() as any[];
  ok("... ids are kept (41, 42; projects 7, 9), and what has none follows on", u.map((r) => Number(r.id)).join() === "41,42" && p.map((r) => Number(r.id)).join() === "7,9" && t.map((r) => Number(r.id)).join() === "1,2");
  ok("... times are kept where given and are 'now' where not", Number(u[0].created) === GOOD.now && Number(u[1].created) === 1000 && Number(u[1].updated) === 2000, u);
  ok("... references point at the ids that came with the rows", Number(p[0].owner) === 41 && Number(p[1].owner) === 42, p);
  const pw = (db.prepare(`SELECT password FROM "User" WHERE id = 41`).get() as any).password as string;
  ok("... a plain-text password is stored hashed", typeof pw === "string" && pw.startsWith("scrypt:") && !pw.includes("secret-pw"), pw);
  db.close();
}

// ---- a field the rows leave out takes the spec's default, even one worked out for each row
{
  const d = fresh();
  const body: any = JSON.parse(JSON.stringify(GOOD));
  delete body.rows.Task[0].fields.done; delete body.rows.Project[1].fields.points;
  body.rows.Login = [{ fields: { who: ref("User", 41) } }];
  const r = run(d, body);
  const db = new DatabaseSync(join(d, "app.sqlite"), { readOnly: true });
  const done = (db.prepare('SELECT done FROM "Task" ORDER BY id').all() as any[]).map((x) => Number(x.done));
  const points = Number((db.prepare('SELECT points FROM "Project" WHERE id = 9').get() as any).points);
  const token = (db.prepare('SELECT token FROM "Login"').get() as any).token as string;
  db.close();
  ok("a default fills what is left out (done false, points 0), and a computed one (token(24)) is made for the row", r.status === 0 && done[0] === 0 && points === 0 && typeof token === "string" && token.length >= 24, { r, done, points, token });
}

// ---- refusals, each leaving nothing behind
const refused = (name: string, body: unknown, pattern: RegExp, flags: string[] = []) => {
  const d = fresh();
  const r = run(d, body, ...flags);
  const said = JSON.stringify(r.out ?? r.stderr);
  ok(`${name}: refused, and nothing kept`, r.status !== 0 && pattern.test(said) && JSON.stringify(counts(d)) === JSON.stringify(empty), { r, counts: counts(d) });
};
const rows = (patch: (r: any) => void) => { const b: any = JSON.parse(JSON.stringify(GOOD)); patch(b.rows); return b; };
refused("a reference to a row that isn't there", rows((r) => { r.Project[0].fields.owner = ref("User", 99); }), /reference.*Project\.owner names User 99/);
refused("an invariant that doesn't hold (negative points)", rows((r) => { r.Project[0].fields.points = -2; }), /invariant/);
refused("a value past its size (a title over 30 characters)", rows((r) => { r.Project[0].fields.title = "x".repeat(31); }), /Project row 1.*(CHECK|constraint|length|size)/i);
refused("a unique key twice (the same email)", rows((r) => { r.User[1].fields.email = "ann@example.test"; }), /User row 2.*(UNIQUE|unique)/);
refused("a required field left out", rows((r) => { delete r.User[0].fields.name; }), /User row 1.*(NOT NULL|required|name)/i);
refused("a field the entity doesn't have", rows((r) => { r.User[0].fields.nickname = "A"; }), /User has no field nickname/);
refused("an entity the app doesn't have", rows((r) => { r.Comment = [{ fields: { body: "x" } }]; }), /Comment is no entity/);
refused("the same id twice", rows((r) => { r.User[1].id = 41; }), /User row 2/);

// ---- a dry run, a database that has rows, --replace
const d2 = fresh();
const dry = run(d2, GOOD, "--dry-run");
ok("a dry run loads and checks, and keeps nothing", dry.status === 0 && dry.out?.kept !== true && dry.out?.imported.User === 2 && JSON.stringify(counts(d2)) === JSON.stringify(empty), dry);
const d3 = fresh();
run(d3, GOOD);
const again = run(d3, GOOD);
ok("a database that has rows is not imported into", again.status !== 0 && /already has 6 rows/.test(JSON.stringify(again.out)) && JSON.stringify(counts(d3)) === JSON.stringify({ User: 2, Project: 2, Task: 2 }), again);
const smaller = rows((r) => { r.Task = []; r.Project = [r.Project[0]]; });
const replaced = run(d3, smaller, "--replace");
ok("--replace swaps what is there for the new rows", replaced.status === 0 && JSON.stringify(counts(d3)) === JSON.stringify({ User: 2, Project: 1, Task: 0 }), { replaced, counts: counts(d3) });
const badReplace = run(d3, rows((r) => { r.Project[0].fields.owner = ref("User", 99); }), "--replace");
ok("... and a refused --replace leaves what was there", badReplace.status !== 0 && JSON.stringify(counts(d3)) === JSON.stringify({ User: 2, Project: 1, Task: 0 }), { badReplace, counts: counts(d3) });
ok("a Time may be given as ms alone, or as {time, seq}", run(fresh(), rows((r) => { r.Project[0].fields.due = { time: Date.parse("2027-03-01T00:00:00Z"), seq: 0 }; })).status === 0);
process.exit(failed ? 1 : 0);
