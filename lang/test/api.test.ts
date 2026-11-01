// An api's routes as the compiled app serves them: the target's result as JSON, the status, and
// the headers a route says it sends (headers { … }, location …) when the call succeeds.
//   node lang/test/api.test.ts      (needs Go: run it where `go` is installed)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(typeof info === "string" ? info : JSON.stringify(info, null, 2)); } };

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
fn note_json(n: Note): Json = json { id: n.id, title: n.title }
api notes_api {
  route "/api/:bot_key/notes"
  identity bot_key
  get "" -> notes() as json note_json
         headers { "X-Total-Count": count(Note where true) }
  post "" -> add(title: request.text) status 201
            location url_of(note_screen(result))
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
} finally { app.stop(); }

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
