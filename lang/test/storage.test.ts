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
import { check } from "../check.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };
const spec = parse(`
app t { name "T" actor User }
entity User { name: Text  password: Password?  token: Text?  seen: Time?  grace: Duration?  avatar: File?  bio: RichText? }
identity login: User.token from cookie "login"
`);
const path = join(mkdtempSync(join(tmpdir(), "storage-")), "app.sqlite");
// a format-2 database: the JSON text the store wrote before
const old = new DatabaseSync(path);
old.exec(`CREATE TABLE "User" (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, "name" TEXT, "password" TEXT, "token" TEXT, "seen" TEXT, "grace" TEXT, "avatar" TEXT, "bio" TEXT) STRICT`);
old.prepare(`INSERT INTO "User" VALUES (1, 1, 0, 0, 'ada', ?, NULL, ?, ?, ?, ?), (2, 2, 0, 0, 'bob', NULL, NULL, NULL, NULL, NULL, ?)`).run(JSON.stringify({ scrypt: "abcd:ef01" }), JSON.stringify({ time: 1767225600123, seq: 7 }), JSON.stringify({ ms: 90000 }),
  JSON.stringify({ file: "me.png", stored: "k123.png", content_type: "image/png", size: 2048 }),
  JSON.stringify({ rich: "hi @bob see https://x.test", mentions: [2], entity: "User", embeds: [{ title: "X", url: "https://x.test", description: "d", image: null }] }),
  JSON.stringify({ rich: "{\"rich\": \"not json\"}", mentions: [] }));
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
ok("a File is four columns", raw.avatar === "k123.png" && raw.avatar__name === "me.png" && raw.avatar__type === "image/png" && raw.avatar__size === 2048, raw);
ok("a RichText is its text", raw.bio === "hi @bob see https://x.test", raw.bio);
ok("its mentions are rows", JSON.stringify(store.db.prepare(`SELECT row, pos, entity, ref FROM "User__bio__mentions"`).all()) === JSON.stringify([{ row: 1, pos: 0, entity: "User", ref: 2 }]));
ok("its previews are rows", (store.db.prepare(`SELECT url, title FROM "User__bio__embeds" WHERE row = 1`).get() as any)?.title === "X");
ok("text that looks like JSON is kept as text", (store.db.prepare(`SELECT bio FROM "User" WHERE id = 2`).get() as any).bio === '{"rich": "not json"}');
ok("file and rich text load as before", ada.fields.avatar.stored === "k123.png" && ada.fields.avatar.size === 2048 && ada.fields.bio.rich === "hi @bob see https://x.test" && ada.fields.bio.mentions[0] === 2 && ada.fields.bio.embeds[0].url === "https://x.test", ada.fields);
ada.fields.seen = { time: 1767225600999, seq: 9 };
ada.fields.bio = { rich: "now @bob and @ada", mentions: [2, 1], entity: "User" };
store.persist(loaded);
const again = store.db.prepare(`SELECT seen, seen__seq FROM "User" WHERE id = 1`).get() as any;
ok("and persist back to their columns", again.seen === 1767225600999 && again.seen__seq === 9, again);
ok("a changed rich text rewrites its rows", JSON.stringify((store.db.prepare(`SELECT ref FROM "User__bio__mentions" WHERE row = 1 ORDER BY pos`).all() as any[]).map((r) => r.ref)) === "[2,1]" && !store.db.prepare(`SELECT 1 FROM "User__bio__embeds" WHERE row = 1`).get());
store.migrate();
ok("converting again changes nothing", (store.db.prepare(`SELECT password FROM "User" WHERE id = 1`).get() as any).password === "scrypt:abcd:ef01");
ok("no JSON text left in typed columns", (store.db.prepare(`SELECT count(*) AS n FROM "User" WHERE typeof(seen) = 'text' OR typeof(grace) = 'text'`).get() as any).n === 0);
// nothing is JSON by default: a collection is kept as rows
const coll = check(parse(`app t { name "T" actor User }
entity User { name: Text  token: Text?  friends: set of User }
identity login: User.token from cookie "login"`));
ok("a stored collection field is refused", coll.some((f) => f.code === "STORED_COLLECTION"));
process.exit(failed ? 1 : 0);
