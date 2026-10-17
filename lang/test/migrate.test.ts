// Upgrades between spec versions on seeded data: what is applied, what is refused, and that
// the data comes out right. Each case starts from the same base spec and rows.
process.removeAllListeners("warning");
import { mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { Interpreter } from "../interp.ts";
import { SqliteStore } from "../runtime/store-sqlite.ts";
import { upgrade, type Plan } from "../runtime/upgrade.ts";

const BASE = `
enum Status { open, closed }
entity Person { name: Text  email: Text?  unique (email) }
entity Task { title: Text  owner: Person  status: Status = open  points: Int = 1 }
action add_task(title: Text, owner: Person) { create Task { title: title, owner: owner } }
`;
let failed = 0, n = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { n++; console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; if (info) console.log(JSON.stringify(info, null, 2)); } };

// a database at the base version with: Ada, Bob (same email as Ada's null: fine), three tasks
function seeded(): string {
  const dir = mkdtempSync(join(tmpdir(), "crudspec-mig-"));
  const path = join(dir, "app.sqlite");
  const spec = parse(BASE);
  upgrade(path, spec, { apply: true, now: 1000 });
  const it = new Interpreter(spec);
  const store = new SqliteStore(path, it);
  it.store = store.load() ?? it.store;
  const ada = it.store.insert("Person", { name: "Ada", email: "ada@x.test" }, 1);
  const bob = it.store.insert("Person", { name: "Bob", email: null }, 2);
  for (const [t, who, st] of [["Write", ada, "open"], ["Ship", ada, "closed"], ["Fix", bob, "open"]] as const)
    it.store.insert("Task", { title: t, owner: { ref: "Person", id: who.id }, status: st, points: 1 }, 3);
  store.persist(it.store);
  store.db.close();
  return path;
}
const rows = (path: string, sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); const r = db.prepare(sql).all(); db.close(); return r as any[]; };
const run = (path: string, src: string, apply = true): Plan => {
  const spec = parse(src);
  const errors = check(spec).filter((f) => f.severity === "error");
  if (errors.length) throw new Error(`spec errors: ${JSON.stringify(errors)}`);
  return upgrade(path, spec, { apply, now: 5000 });
};
const has = (p: Plan, op: string, cls?: string) => p.steps.some((s) => s.op === op && (!cls || s.class === cls));

// 1. new optional field
{ const db = seeded(); const p = run(db, BASE.replace("email: Text?", "email: Text?  bio: Text?"));
  ok("optional field: applied, empty", p.status === "applied" && has(p, "add_field", "safe") && rows(db, `select bio from Person`).every((r) => r.bio === null), p); }
// 2. new field whose default reads the row
{ const db = seeded(); const p = run(db, BASE.replace("email: Text?", "email: Text?  display: Text = upper(.name)"));
  ok("default from the row's own fields", p.status === "applied" && rows(db, `select display from Person order by id`).map((r) => r.display).join() === "ADA,BOB", p); }
// 3. new required field, no default: refused while rows exist
{ const db = seeded(); const p = run(db, BASE.replace("email: Text?", "email: Text?  city: Text"));
  ok("required field without default: blocked, data untouched", p.status === "blocked" && p.checks.some((c) => c.check === "required" && c.count === 2) && !rows(db, `pragma table_info(Person)`).some((c) => c.name === "city"), p); }
// 4. ... and accepted with a migration that fills it
{ const db = seeded(); const p = run(db, BASE.replace("email: Text?", "email: Text?  city: Text") + `migration "cities" { for each p in Person { set p.city = "Leeds" } }`);
  ok("required field filled by a migration", p.status === "applied" && p.migrations[0]?.changed.Person?.updated === 2 && rows(db, `select city from Person`).every((r) => r.city === "Leeds"), p); }
// 5. rename with was
{ const db = seeded(); const p = run(db, BASE.replace("name: Text", "full_name: Text was name"));
  ok("field rename keeps values", p.status === "applied" && has(p, "rename_field") && rows(db, `select full_name from Person order by id`).map((r) => r.full_name).join() === "Ada,Bob", p); }
// 6. removed and added with the same type, no was: ambiguous
{ const db = seeded(); const p = run(db, BASE.replace("name: Text", "full_name: Text = \"?\""));
  ok("remove + add same type without was: blocked as ambiguous", p.status === "blocked" && has(p, "ambiguous_field", "blocked") && p.steps.find((s) => s.op === "ambiguous_field")!.hint!.includes("was name"), p); }
// 7. removing a field keeps its data
{ const db = seeded(); const p = run(db, BASE.replace("email: Text?  unique (email)", ""));
  ok("removed field: values kept until drop", p.status === "applied" && has(p, "keep_field") && rows(db, `select email from Person where id = 1`)[0].email === "ada@x.test", p); }
// 8. drop deletes it, says how much, and leaves a backup
{ const db = seeded(); run(db, BASE.replace("email: Text?  unique (email)", "")); const p = run(db, BASE.replace("email: Text?  unique (email)", "") + "drop Person.email");
  ok("drop field: destructive, counted, backed up", p.status === "applied" && p.steps.some((s) => s.op === "drop_field" && s.detail.includes("1 non-empty")) && !rows(db, `pragma table_info(Person)`).some((c) => c.name === "email") && !!p.backup && existsSync(p.backup!), p); }
// 9. new unique key with duplicates: refused with the rows named
{ const db = seeded(); const p = run(db, BASE.replace("status: Status = open", "status: Status = open  unique (owner)"));
  ok("new unique key with duplicates: blocked, rows named", p.status === "blocked" && p.checks.some((c) => c.check === "unique" && c.count === 1), p); }
// 10. new invariant that some rows break
{ const db = seeded(); const p = run(db, BASE.replace("points: Int = 1 }", "points: Int = 1  invariant .title != \"Ship\" }"));
  ok("new invariant: blocked with the breaking row", p.status === "blocked" && p.checks.some((c) => c.check === "invariant" && c.sample[0] === 2), p); }
// 11. enum value renamed
{ const db = seeded(); const p = run(db, BASE.replace("enum Status { open, closed }", "enum Status { open, done was closed }").replace("status: Status = open", "status: Status = open"));
  ok("enum value rename rewrites rows", p.status === "applied" && rows(db, `select status from Task where id = 2`)[0].status === "done", p); }
// 12. enum value removed while rows use it
{ const db = seeded(); const p = run(db, BASE.replace("enum Status { open, closed }", "enum Status { open, archived }"));
  ok("enum value removed while used: blocked", p.status === "blocked" && p.checks.some((c) => c.check === "enum" && c.count === 1), p); }
// 13. entity renamed; references follow
{ const db = seeded(); const src = BASE.replace("entity Person {", "entity Member was Person {").replace("owner: Person", "owner: Member").replace("owner: Person)", "owner: Member)");
  const p = run(db, src);
  ok("entity rename keeps rows and references", p.status === "applied" && rows(db, `select count(*) n from Member`)[0].n === 2 && rows(db, `select owner from Task where id = 3`)[0].owner === 2, p); }
// 14. a type change that can't convert
{ const db = seeded(); const p = run(db, BASE.replace("title: Text", "title: Int"));
  ok("Text to Int: blocked with an expand/contract hint", p.status === "blocked" && p.steps.some((s) => s.op === "change_type" && s.class === "blocked" && s.hint!.includes("migration")), p); }
// 15. a migration that fails leaves everything as it was
{ const db = seeded(); const p = run(db, BASE + `migration "bad" { for each t in Task { require t.points > 5 else invalid } }`);
  ok("failing migration: blocked, original untouched, no temp files", p.status === "blocked" && !!p.migrations[0]?.error && rows(db, `select count(*) n from Task`)[0].n === 3 && !readdirSync(join(db, "..")).some((f) => f.includes(".upgrade-")), p); }
// 16. plan without apply changes nothing
{ const db = seeded(); const p = run(db, BASE.replace("email: Text?", "email: Text?  bio: Text?"), false);
  ok("plan is a rehearsal only", p.status === "ready" && !rows(db, `pragma table_info(Person)`).some((c) => c.name === "bio") && !readdirSync(join(db, "..")).some((f) => f.includes(".upgrade-")), p); }
// 17. contract changes are reported
{ const db = seeded(); const p = run(db, BASE.replace("action add_task(title: Text, owner: Person)", "action add_task(title: Text, owner: Person, due: Text)").replace("create Task { title: title, owner: owner }", "create Task { title: title + due, owner: owner }"));
  ok("new required action parameter reported as a contract break", has(p, "add_param", "contract"), p); }
// 18. a removed unique key is no longer enforced
{ const db = seeded(); const p = run(db, BASE.replace("unique (email)", ""));
  const d = new DatabaseSync(db); let dup = true; try { d.prepare(`insert into Person (id, seq, created, updated, name, email) values (9, 9, 9, 9, 'Cy', 'ada@x.test')`).run(); } catch { dup = false; } d.close();
  ok("removed unique key: index dropped", p.status === "applied" && has(p, "remove_unique") && dup, p); }
// 19. an applied migration doesn't run again
{ const db = seeded(); const src = BASE + `migration "bump" { for each t in Task { set t.points = t.points + 1 } }`;
  run(db, src); const p = run(db, src);
  ok("migrations run once; the spec is told it can drop them", p.status === "current" && rows(db, `select points from Task where id = 1`)[0].points === 2 && p.notes.some((x) => x.includes("bump")), p); }
// 20. triggers don't fire during migrations
{ const db = seeded(); const p = run(db, BASE.replace("points: Int = 1 }", "points: Int = 1  touched: Bool = false }") + `trigger on update Task.points as t { set t.touched = true }
migration "bump" { for each t in Task { set t.points = 3 } }`);
  ok("migrations change rows as written (no triggers)", p.status === "applied" && rows(db, `select touched from Task`).every((r) => r.touched === 0), p); }

// 21. no migrate while the app runs on the data (plan is fine)
{ const db = seeded(); writeFileSync(join(db, "..", "app.lock"), String(process.ppid));
  const src = BASE.replace("email: Text?", "email: Text?  bio: Text?");
  const p = run(db, src), q = run(db, src, false);
  ok("migrate refused while the app holds the lock; plan still works", p.status === "blocked" && p.notes[0].includes("running") && q.status === "ready" && !rows(db, `pragma table_info(Person)`).some((c) => c.name === "bio"), p); }
// 22. a missing database with backups is not replaced by an empty one
{ const db = seeded(); run(db, BASE.replace("email: Text?", "email: Text?  bio: Text?")); rmSync(db);
  const p = run(db, BASE);
  ok("missing database with backups: blocked, nothing created", p.status === "blocked" && p.notes[0].includes("restore") && !existsSync(db), p); }
// 23. an entity rename reaches the entity names inside stored sets
{ const db = seeded(); const v2 = BASE.replace("points: Int = 1 }", `points: Int = 1  helpers: set of Person = set(Person where .name == "Ada") }`);
  run(db, v2);
  const p = run(db, v2.replace("entity Person {", "entity Member was Person {").replace(/Person/g, "Member").replace("entity Member was Member {", "entity Member was Person {"));
  const h = JSON.parse(rows(db, `select helpers from Task where id = 1`)[0].helpers);
  ok("entity rename rewrites entity names in sets", p.status === "applied" && h.entity === "Member" && h.set[0] === 1, { p, h }); }
// 24. a kept column declared again comes back checked against its new type
{ const db = seeded(); run(db, BASE.replace("email: Text?  unique (email)", ""));
  const p = run(db, BASE.replace("email: Text?  unique (email)", "email: Int?"));
  ok("restored column with a new type: values checked, blocked", p.status === "blocked" && has(p, "restore_field", "checked") && p.checks.some((c) => c.check === "type"), p); }
// 25. if the database can't be replaced, nothing changes
if (process.platform === "win32") {
  const db = seeded(); const hold = new DatabaseSync(db); hold.prepare("select 1").get();
  const p = run(db, BASE.replace("email: Text?", "email: Text?  bio: Text?")); hold.close();
  ok("swap that can't replace the file: blocked, original intact, no leftovers", p.status === "blocked" && p.notes.some((x) => x.includes("nothing changed")) && !rows(db, `pragma table_info(Person)`).some((c) => c.name === "bio") && !readdirSync(join(db, "..")).some((f) => f.includes(".upgrade-")), p);
}

console.log(`${n - failed}/${n} migration cases pass`);
process.exit(failed ? 1 : 0);
