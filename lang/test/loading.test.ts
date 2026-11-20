// No lazy loading (docs/design/explicit-loading.md): a field of a row that wasn't loaded is
// NOT_LOADED, a with naming no reference is WITH_UNKNOWN, a fn or component's parameter says what
// it needs and a call must give it. In the app, with CRUDSPEC_STRICT_LOADS=refuse, a page whose rows
// and parameter say their with renders: every row it reads was loaded, one query per path.
//   node lang/test/loading.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { typecheck } from "../types.ts";
import { withGenerated } from "../scaffold.ts";
import { loadingFindings } from "../loading.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const HEAD = `app t { name "T" actor User }
entity User { name: Text  token: Text?  unique (token) }
identity login: User.token from cookie "login"
entity Room { name: Text  owner: User }
entity Msg { room: Room  by: User  body: Text }
policy pu: true for rows of User
policy pr: true for rows of Room
policy pm: true for rows of Msg
layout l { <main><Slot name=main /></main> }
`;
const findings = (body: string) => { const s = withGenerated(parse(HEAD + body), parse); return loadingFindings(s, typecheck(s)).map((f) => `${f.code} ${f.message}`); };
const has = (body: string, code: string, text: string) => { const f = findings(body); return f.some((x) => x.startsWith(code) && x.includes(text)) ? true : (console.log("      ", JSON.stringify(f)), false); };

ok("a component reading through a reference it wasn't given loaded: NOT_LOADED", has(`component Line(m: Msg) { <li>{m.by.name}</li> }`, "NOT_LOADED", "add with .by"));
ok("... said in its parameter, it's fine", findings(`component Line(m: Msg with .by) { <li>{m.by.name}</li> }`).length === 0);
ok("a call giving rows without what the parameter needs: NOT_LOADED at the call", has(`view msgs(r: Room) { rows Msg where .room == r }
component Line(m: Msg with .by) { <li>{m.by.name}</li> }
screen s(room: Room) { route "/r/:room"  layout l  require public  <Fill name=main><List of={msgs(room)} as=m><Line m={m} /></List></Fill> }`, "NOT_LOADED", "Line needs m with .by"));
ok("a with naming a field that isn't a reference: WITH_UNKNOWN", has(`view msgs(r: Room) { rows Msg where .room == r with .body }`, "WITH_UNKNOWN", "has no reference body"));
ok("an action's parameter is loaded (what it's given); its reference isn't", has(`action a(m: Msg) { callers people  set actor.name = m.body + m.room.name }`, "NOT_LOADED", "m.room.name"));
ok("... unless the parameter says with .room", findings(`action a(m: Msg with .room) { callers people  set actor.name = m.body + m.room.name }`).length === 0);
ok("a {let} in markup holds what its query loaded", findings(`screen s(room: Room) { route "/r/:room"  layout l  require public  <Fill name=main>{let m = the_or_none(Msg where .room == room with .by)}{if m != none { <p>{m.body} {m.by.name}</p> }}</Fill> }`).length === 0);
ok("... and not what it didn't", has(`screen s(room: Room) { route "/r/:room"  layout l  require public  <Fill name=main>{let m = the_or_none(Msg where .room == room)}{if m != none { <p>{m.by.name}</p> }}</Fill> }`, "NOT_LOADED", "by"));
ok("a query function's row has what its the(… with …) loads", findings(`query first_msg(r: Room): Msg? = the_or_none(Msg where .room == r with .by)
screen s(room: Room) { route "/r/:room"  layout l  require public  <Fill name=main>{let m = first_msg(room)}{if m != none { <p>{m.by.name}</p> }}</Fill> }`).length === 0);
ok("a reference's id needs no load: m.room == r, passing m.by on", findings(`action a(m: Msg, r: Room) { callers people  require m.room == r else invalid  set m.by = actor }`).length === 0);
ok("a query function reads queries, not rows lazily: r.owner.name of a parameter needs with .owner", has(`query owner_name(r: Room): Text = r.owner.name`, "NOT_LOADED", "add with .owner"));
ok("inside a query a reference is SQL's: list(.by.name for Msg …) needs no with", findings(`action a(r: Room) { callers people  set actor.name = join(list(.by.name for Msg where .room == r and .by.name != ""), ",") }`).length === 0);

const SPEC = HEAD + `view msgs(r: Room) { rows Msg where .room == r order by created with .by }
component Line(m: Msg with .by) { <li class="m">{m.by.name}: {m.body}</li> }
screen s(room: Room with .owner) { route "/r/:room"  layout l  require public
  <Fill name=main><p class="o">{room.owner.name}</p><ul><List of={msgs(room)} as=m><Line m={m} /></List></ul></Fill>
}
`;
const dir = mkdtempSync(join(tmpdir(), "loading-"));
writeFileSync(join(dir, "app.crud"), SPEC);
ok("the app's spec has nothing unloaded", findings(SPEC.slice(HEAD.length)).length === 0, findings(SPEC.slice(HEAD.length)));
const app = await startApp(join(dir, "app.crud"), 14014, { env: { CRUDSPEC_STRICT_LOADS: "refuse" } });
try {
  const row = (id: number, fields: any) => ({ id, seq: id, created: id, updated: id, fields });
  const ref = (e: string, id: number) => ({ ref: e, id });
  await app.post("/_test/load", { clock: 1000, rows: {
    User: [row(1, { name: "ann", token: null }), row(2, { name: "bo", token: null }), row(3, { name: "cy", token: null })],
    Room: [row(1, { name: "r", owner: ref("User", 3) })],
    Msg: [row(1, { room: ref("Room", 1), by: ref("User", 1), body: "hi" }), row(2, { room: ref("Room", 1), by: ref("User", 2), body: "yo" })],
  } });
  const res = await fetch(app.base + "/r/1"), html = await res.text();
  const lines = [...html.matchAll(/<li class="m">([^<]*)<\/li>/g)].map((m) => m[1]).join("|");
  ok("with lazy reads refused, the page renders: the room's owner (its parameter's with) and each message's author (the view's)", res.status === 200 && /<p class="o">cy<\/p>/.test(html) && lines === "ann: hi|bo: yo", { status: res.status, lines, html: html.slice(0, 400) });
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
