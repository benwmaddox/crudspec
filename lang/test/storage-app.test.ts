// Rich text and files in the compiled app over HTTP: a post's mentions and link previews go to
// their tables and come back on a later request (a new session reads them from the database);
// an upload's key, name, type and size are its columns; deleting the row deletes its mentions.
//   node lang/test/storage-app.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail).slice(0, 800)); } };
const SPEC = `
app t { name "T" actor User }
entity User { name: Text  token: Text? }
display User: .name
entity Note { body: RichText  pic: File? }
identity login: User.token from cookie "login"
action post(body: RichText, pic: File?) { create Note { body: body, pic: pic } }
action edit(n: Note, body: RichText) { set n.body = body }
action remove(n: Note) { delete n }
`;
const dir = mkdtempSync(join(tmpdir(), "storage-app-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const port = 13881;
const app = await startApp(join(dir, "app.crud"), port);
// the app's database, read with sqlite3 where the app runs (WSL on Windows)
const sql = (q: string) => process.platform === "win32"
  ? spawnSync("wsl", ["-e", "bash", "-c", `sqlite3 -json ${app.dir}/data/app.sqlite "$1"`, "sql", q], { encoding: "utf8" }).stdout
  : spawnSync("sqlite3", ["-json", join(app.dir, "data", "app.sqlite"), q], { encoding: "utf8" }).stdout;
try {
  await app.post("/_test/load", { clock: Date.UTC(2026, 0, 5), rows: { User: [{ id: 1, seq: 1, created: 0, updated: 0, fields: { name: "ada", token: null } }, { id: 2, seq: 2, created: 0, updated: 0, fields: { name: "bob", token: null } }] } });
  const form = new FormData();
  form.set("body", "hi @bob and @ada, see https://example.test");
  form.set("body__mentions", "2,1");
  form.set("body__mentions_entity", "User");
  form.set("body__embeds", JSON.stringify([{ title: "Example", url: "https://example.test", description: "a page", image: null }]));
  form.set("pic", new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: "image/png" }), "dot.png");
  const r = await fetch(app.base + "/_do/post", { method: "POST", body: form, redirect: "manual" });
  ok("a post with mentions, a preview and a file", r.headers.get("X-Crudspec-Outcome") === "ok", r.headers.get("X-Crudspec-Outcome"));
  const d = (await app.post("/_test/dump", {})).rows;
  const n = d.Note?.[0]?.fields;
  ok("its mentions come back from their table", JSON.stringify(n?.body?.mentions) === "[2,1]" && n?.body?.entity === "User", n?.body);
  ok("its preview comes back", n?.body?.embeds?.[0]?.title === "Example" && n?.body?.embeds?.[0]?.url === "https://example.test", n?.body);
  ok("its file comes back", n?.pic?.file === "dot.png" && n?.pic?.content_type === "image/png" && n?.pic?.size === 7 && !!n?.pic?.stored, n?.pic);
  const rows = sql(`SELECT n.body, n.pic__name, n.pic__type, n.pic__size, (SELECT group_concat(ref) FROM Note__body__mentions WHERE row = n.id) AS refs, (SELECT title FROM Note__body__embeds WHERE row = n.id) AS title FROM Note n`);
  const row = JSON.parse(rows || "[]")[0];
  ok("in the database: plain columns and rows, no JSON", row?.body === "hi @bob and @ada, see https://example.test" && row?.pic__name === "dot.png" && row?.pic__size === 7 && row?.refs === "2,1" && row?.title === "Example", rows);
  const id = d.Note[0].id;
  const e = await fetch(app.base + "/_do/edit", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ n: String(id), body: "only @ada now", body__mentions: "1", body__mentions_entity: "User", body__embeds: "[]" }), redirect: "manual" });
  ok("an edit", e.headers.get("X-Crudspec-Outcome") === "ok");
  const after = (await app.post("/_test/dump", {})).rows.Note[0].fields.body;
  ok("rewrites its mentions and previews", JSON.stringify(after.mentions) === "[1]" && !(after.embeds?.length), after);
  await fetch(app.base + "/_do/remove", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ n: String(id) }), redirect: "manual" });
  ok("a delete removes its mentions", sql(`SELECT count(*) AS n FROM Note__body__mentions`).includes('"n":0'), sql(`SELECT count(*) AS n FROM Note__body__mentions`));
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
