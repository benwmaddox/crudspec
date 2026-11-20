// An api's routes as the compiled app serves them: the target's result as JSON (or as text), the status, and
// the headers a route says it sends (headers { … }, location …) when the call succeeds.
//   node lang/test/api.test.ts      (needs Go: run it where `go` is installed)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";
import { parse } from "../parser.ts";
import { check } from "../check.ts";

let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(typeof info === "string" ? info : JSON.stringify(info, null, 2)); } };

// the checks: an API's caller comes from its address; as text is one value
{
  const base = `app t { name "T"  actor Bot }
entity Bot { key: Text }
entity Login { bot: Bot  token: Text }
identity by_key: Bot.key from param key
identity login: Login.token from cookie "login"
policy bot_rows: true for rows of Bot
// The bots.
view bots() { rows Bot order by created }
// How many.
view how_many() { value text(count(Bot where true)) }
`;
  const codes = (src: string) => check(parse(base + src)).map((f) => f.code);
  ok("check: an API with a cookie identity is API_IDENTITY", codes(`api a {
  route "/a"
  identity login
  get "" -> how_many() as text
}`).includes("API_IDENTITY"));
  ok("check: a parameter identity, or none, is fine", !codes(`api a {
  route "/a/:key"
  identity by_key
  get "" -> how_many() as text
}
api b {
  route "/b.txt"
  get "" -> how_many() as text
}`).some((c) => c.startsWith("API_")));
  ok("check: as text of a view's rows is API_TEXT", codes(`api b {
  route "/b.txt"
  get "" -> bots() as text
}`).includes("API_TEXT"));
}

const dir = mkdtempSync(join(tmpdir(), "api-"));
writeFileSync(join(dir, "app.crud"), `app notes { name "Notes"  actor Bot }
entity Bot { name: Text  key: Text }
identity bot_key: Bot from param bot_key as "{id}-{key}"
entity Note { title: Text }
policy note_rows: true for rows of Note
layout l { <main><Slot name=main /></main> }
// The notes.
view notes() { rows Note order by created }
// Adds a note.
action add(title: Text) { require present(title) else invalid  create Note { title: title } as n  result n }
screen home {
  route "/"
  layout l
  <Fill name=main><p>Notes</p></Fill>
}
screen note_screen(n: Note) {
  route "/notes/:n"
  layout l
  <Fill name=main><p>{n.title}</p></Fill>
}
// How many notes there are, as a line of text.
view note_count() { value text(count(Note where true)) + " notes" }
// The calling bot's name.
view my_name() { require actor != none else unauthenticated  value actor.name }
fn note_json(n: Note): Json = json { id: n.id, title: n.title }
api notes_api {
  route "/api/:bot_key/notes"
  identity bot_key
  get "" -> notes() as json note_json
         headers { "X-Total-Count": count(Note where true) }
  get "count" -> note_count() as text
  get "me" -> my_name() as text
  get "count.xml" -> note_count() as text
                     headers { "Content-Type": "application/xml" }
  post "" -> add(title: request.text) status 201
            location url_of(note_screen(result))
}
// a file at a fixed address, for anyone: an API with no identity, whose calls are signed out
api count_file {
  route "/count.txt"
  get "" -> note_count() as text
}
`);
const app = await startApp(join(dir, "app.crud"), 13941);
try {
  await app.post("/_test/load", { clock: 1000, seq: 2, rows: { Bot: [{ id: 1, seq: 1, created: 1, updated: 1, fields: { name: "b", key: "k" } }] } });
  const url = app.base + "/api/1-k/notes";
  const post = await fetch(url, { method: "POST", body: "first", headers: { "Content-Type": "text/plain" } });
  ok("post: the status the route says", post.status === 201, post.status);
  ok("post: its location, the created note's screen (an absolute address, as url_of gives)", /^http:\/\/127\.0\.0\.1:13941\/notes\/\d+$/.test(post.headers.get("location") ?? ""), post.headers.get("location"));
  await fetch(url, { method: "POST", body: "second", headers: { "Content-Type": "text/plain" } });
  const bad = await fetch(url, { method: "POST", body: "", headers: { "Content-Type": "text/plain" } });
  ok("a refused call: its outcome's status, and no location", bad.status === 422 && !bad.headers.get("location"), [bad.status, bad.headers.get("location")]);
  const list = await fetch(url);
  const body = await list.json();
  ok("get: the view's rows as the JSON shape", list.status === 200 && body.length === 2 && body[0].title === "first", body);
  ok("get: the header it says it sends", list.headers.get("x-total-count") === "2", list.headers.get("x-total-count"));
  const count = await fetch(url + "/count");
  ok("as text: the view's value as plain text", count.status === 200 && (count.headers.get("content-type") ?? "").startsWith("text/plain") && (await count.text()) === "2 notes", [count.status, count.headers.get("content-type")]);
  const xml = await fetch(url + "/count.xml");
  ok("as text: the type the route's headers give", (xml.headers.get("content-type") ?? "") === "application/xml" && (await xml.text()) === "2 notes", xml.headers.get("content-type"));
  const file = await fetch(app.base + "/count.txt");
  ok("as text at a fixed address, from an API with no identity (anyone's)", file.status === 200 && (await file.text()) === "2 notes", file.status);
  const me = await fetch(url + "/me");
  ok("as text: a value that reads the caller", me.status === 200 && (await me.text()) === "b", me.status);
  const refused = await fetch(app.base + "/api/1-wrong/notes/me");
  ok("as text: a refusal is its status and outcome, as plain text", refused.status === 401 && (refused.headers.get("content-type") ?? "").startsWith("text/plain") && (await refused.text()) === "unauthenticated\n", refused.status);
} finally { app.stop(); }

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
