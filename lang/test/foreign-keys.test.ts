// Foreign keys: every reference to a stored entity is one in the table the compiler defines
// (lang/runtime/store-sqlite.ts tableSql), checked when a write commits; the app turns them on
// (rt.Open). The app's own on delete restrict / cascade still run first, in the app. An upgrade
// from storage format 4 rebuilds the tables with them, after checking every reference.
//   node lang/test/foreign-keys.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "../parser.ts";
import { specMeta, Store } from "../rows.ts";
import { SqliteStore } from "../runtime/store-sqlite.ts";
import { upgrade } from "../runtime/upgrade.ts";
import { schemaOf, schemaHash } from "../schema.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app shop { name "Shop" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
policy all_users: true for rows of User
data Sound { name: Text } rows [ { name: "bell" } ]
entity Room { name: Text  creator: User?  sound: Sound? }
entity Message { room: Room on delete cascade  author: User  body: RichText }
policy all_rooms: true for rows of Room
policy all_messages: true for rows of Message
action close(r: Room) { callers people  delete r }
action leave(u: User) { callers people  delete u }
`;

// the tables the compiler defines
const store = new SqliteStore(":memory:", specMeta(parse(SPEC)));
store.migrate();
const sql = (t: string) => (store.db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t) as any)?.sql ?? "";
ok("a reference to a stored entity is a foreign key, checked at commit", sql("Message").includes(`"room" INTEGER REFERENCES "Room" (id) DEFERRABLE INITIALLY DEFERRED`) && sql("Message").includes(`"author" INTEGER REFERENCES "User" (id)`) && sql("Room").includes(`"creator" INTEGER REFERENCES "User" (id)`), [sql("Message"), sql("Room")]);
ok("a reference to data in the spec (no table) is no foreign key", /"sound" INTEGER[,)]/.test(sql("Room")) && !sql("Room").includes(`REFERENCES "Sound"`), sql("Room"));
ok("a rich text's mentions table (rows of any entity) has none", !sql("Message__body__mentions").includes("REFERENCES"), sql("Message__body__mentions"));
store.db.close();

// the compiled app
const dir = mkdtempSync(join(tmpdir(), "fk-app-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13998);
const row = (id: number, f: any) => ({ id, seq: id, created: 0, updated: 0, fields: f });
const ref = (e: string, id: number) => ({ ref: e, id });
const dump = async () => (await app.post("/_test/dump", {})).rows;
try {
  // rows load in any order within one write: a message before its room is fine
  const load = (rows: any) => app.post("/_test/load", { clock: 0, rows });
  await load({ User: [row(1, { name: "A", token: null })], Room: [row(1, { name: "R", creator: ref("User", 1), sound: null })], Message: [row(1, { room: ref("Room", 1), author: ref("User", 1), body: "hi" })] });
  let d = await dump();
  ok("rows that refer to each other load", d.Message?.length === 1 && d.Room?.length === 1, d);
  let r = await app.post("/_test/run", { call: "close", args: { r: ref("Room", 1) }, actor: null, now: 0 });
  d = await dump();
  ok("on delete cascade still runs in the app: the room and its message go, and the commit's foreign keys hold", r.outcome === "ok" && !d.Room?.length && !d.Message?.length, { r, d });
  await load({ User: [row(1, { name: "A", token: null })], Room: [row(1, { name: "R", creator: ref("User", 1), sound: null })], Message: [row(1, { room: ref("Room", 1), author: ref("User", 1), body: "hi" })] });
  r = await app.post("/_test/run", { call: "leave", args: { u: ref("User", 1) }, actor: null, now: 0 });
  ok("on delete restrict (the default) still refuses in the app, with its own message", r.outcome === "invalid" && /restricts deleting User/.test(JSON.stringify(r)), r);
  // a reference to a row that isn't there is refused by SQLite itself
  const bad = await fetch(`${app.base}/_test/load`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clock: 0, rows: { User: [row(1, { name: "A", token: null })], Message: [row(1, { room: ref("Room", 7), author: ref("User", 1), body: "x" })] } }) });
  ok("loading a row that refers to a room that isn't there fails, and loads nothing", !bad.ok || /refer to rows that aren't there|FOREIGN KEY/i.test(await bad.text()), bad.status);
  d = await dump();
  ok("... the store is as it was before that load (the write rolled back)", d.Message?.length === 1 && d.Room?.length === 1, d);
  r = await app.post("/_test/run", { call: "close", args: { r: ref("Room", 1) }, actor: null, now: 0 });
  ok("... and the app writes on after it", r.outcome === "ok", r);
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }

// an upgrade from storage format 4: the tables are rebuilt with their foreign keys
{
  const d = mkdtempSync(join(tmpdir(), "fk-upgrade-"));
  const path = join(d, "app.sqlite");
  const OLD = `entity Person { name: Text }\nentity Task { title: Text  owner: Person }\n`;
  const spec = parse(OLD);
  upgrade(path, spec, { apply: true, now: 1000 });
  // make it a format 4 database: tables without foreign keys, and the version that says so
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec(`DROP TABLE "Task"; CREATE TABLE "Task" (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, "title" TEXT, "owner" INTEGER) STRICT`);
  db.exec(`INSERT INTO "Person" (id, seq, created, updated, name) VALUES (1, 1, 0, 0, 'Ada'); INSERT INTO "Task" (id, seq, created, updated, title, owner) VALUES (1, 2, 0, 0, 'Write', 1)`);
  const s4 = { ...schemaOf(spec), format: 4 };
  db.prepare(`UPDATE crudspec_versions SET schema_hash = ?, schema = ?`).run(schemaHash(s4), JSON.stringify(s4));
  db.close();
  const plan = upgrade(path, spec, { apply: true, now: 2000 });
  const after = new DatabaseSync(path, { readOnly: true });
  const taskSql = (after.prepare(`SELECT sql FROM sqlite_master WHERE name = 'Task'`).get() as any).sql;
  const rowsAfter = after.prepare(`SELECT title, owner FROM "Task"`).all();
  after.close();
  ok("an upgrade from format 4 says so, and rebuilds the table with its foreign key, rows kept", plan.status === "applied" && plan.steps.some((s: any) => s.op === "storage_format" && /foreign key/.test(s.detail)) && taskSql.includes(`REFERENCES "Person"`) && rowsAfter.length === 1, { plan, taskSql, rowsAfter });

  // a reference to a row that isn't there blocks it, and says where
  const d2 = mkdtempSync(join(tmpdir(), "fk-upgrade2-")), p2 = join(d2, "app.sqlite");
  upgrade(p2, spec, { apply: true, now: 1000 });
  const db2 = new DatabaseSync(p2, { enableForeignKeyConstraints: false });
  db2.exec(`DROP TABLE "Task"; CREATE TABLE "Task" (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, "title" TEXT, "owner" INTEGER) STRICT`);
  db2.exec(`INSERT INTO "Task" (id, seq, created, updated, title, owner) VALUES (1, 2, 0, 0, 'Lost', 9)`);
  db2.prepare(`UPDATE crudspec_versions SET schema_hash = ?, schema = ?`).run(schemaHash(s4), JSON.stringify(s4));
  db2.close();
  const p2plan = upgrade(p2, spec, { apply: true, now: 2000 });
  ok("a reference to a row that isn't there blocks the upgrade, naming the field and row", p2plan.status === "blocked" && p2plan.checks.some((c: any) => c.check === "reference" && c.entity === "Task" && c.field === "owner" && c.sample.includes(1)), p2plan);
  void Store;
  rmSync(d, { recursive: true, force: true }); rmSync(d2, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
