// Storage format 3: Time fields are INTEGER milliseconds plus their order (field__seq),
// Duration fields INTEGER milliseconds, Password fields TEXT ("scrypt:<salt>:<key>"); a
// database from before (JSON text) is converted in place, values kept.
//   node lang/test/storage.test.ts
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { specMeta } from "../rows.ts";
import { SqliteStore } from "../runtime/store-sqlite.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };
const spec = parse(`
app t { name "T" actor User }
entity User { name: Text  password: Password?  token: Text?  seen: Time?  grace: Duration? }
identity login: User.token from cookie "login"
`);
const path = join(mkdtempSync(join(tmpdir(), "storage-")), "app.sqlite");
// a format-2 database: the JSON text the store wrote before
const old = new DatabaseSync(path);
old.exec(`CREATE TABLE "User" (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, "name" TEXT, "password" TEXT, "token" TEXT, "seen" TEXT, "grace" TEXT) STRICT`);
old.prepare(`INSERT INTO "User" VALUES (1, 1, 0, 0, 'ada', ?, NULL, ?, ?), (2, 2, 0, 0, 'bob', NULL, NULL, NULL, NULL)`).run(JSON.stringify({ scrypt: "abcd:ef01" }), JSON.stringify({ time: 1767225600123, seq: 7 }), JSON.stringify({ ms: 90000 }));
old.close();

const store = new SqliteStore(path, specMeta(spec));
store.migrate();
const cols = new Map((store.db.prepare(`PRAGMA table_info("User")`).all() as any[]).map((r) => [r.name, r.type]));
ok("a Time field is two INTEGER columns", cols.get("seen") === "INTEGER" && cols.get("seen__seq") === "INTEGER", [...cols]);
ok("a Duration is INTEGER, a Password TEXT", cols.get("grace") === "INTEGER" && cols.get("password") === "TEXT");
const raw = store.db.prepare(`SELECT * FROM "User" WHERE id = 1`).get() as any;
ok("the time's milliseconds and order are kept", raw.seen === 1767225600123 && raw.seen__seq === 7, raw);
ok("the duration's milliseconds are kept", raw.grace === 90000, raw);
ok("the password hash is its text", raw.password === "scrypt:abcd:ef01", raw);
ok("an empty value stays empty", (store.db.prepare(`SELECT seen, seen__seq, grace, password FROM "User" WHERE id = 2`).get() as any).seen === null);
const loaded = store.load()!;
const ada = loaded.rows("User").find((r) => r.id === 1)!;
ok("values load as the language's", ada.fields.seen.time === 1767225600123 && ada.fields.seen.seq === 7 && ada.fields.grace.ms === 90000 && ada.fields.password.scrypt === "abcd:ef01", ada.fields);
ada.fields.seen = { time: 1767225600999, seq: 9 };
store.persist(loaded);
const again = store.db.prepare(`SELECT seen, seen__seq FROM "User" WHERE id = 1`).get() as any;
ok("and persist back to their columns", again.seen === 1767225600999 && again.seen__seq === 9, again);
store.migrate();
ok("converting again changes nothing", (store.db.prepare(`SELECT password FROM "User" WHERE id = 1`).get() as any).password === "scrypt:abcd:ef01");
ok("no JSON text left in typed columns", (store.db.prepare(`SELECT count(*) AS n FROM "User" WHERE typeof(seen) = 'text' OR typeof(grace) = 'text'`).get() as any).n === 0);
process.exit(failed ? 1 : 0);
