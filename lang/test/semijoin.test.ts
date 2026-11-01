// exists(E where .f == outer and …) compiled as outer IN (SELECT f FROM E WHERE …) (gen.ts
// semijoin): the same rows as the correlated EXISTS, under not too, with a none in the list.
//   node lang/test/semijoin.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";
import { generate } from "../gogen/gen.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };
const SPEC = `
app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Room { name: Text }
entity Member { room: Room on delete cascade  user: User on delete cascade }
entity Note { name: Text  owner: User? on delete nullify }
entity Pin { note: Note? on delete nullify  user: User on delete cascade }
policy room_rows: true for rows of Room
policy note_rows: true for rows of Note
fn in_room(u: User, r: Room): Bool = exists(Member where .room == r and .user == u)
fn pinned(u: User, n: Note): Bool = exists(Pin where .note == n and .user == u)
view rooms_of(u: User) { rows Room where in_room(u, it) order by .name }
view rooms_not_of(u: User) { rows Room where not in_room(u, it) order by .name }
view pinned_by(u: User) { rows Note where pinned(u, it) order by .name }
view not_pinned_by(u: User) { rows Note where not pinned(u, it) order by .name }
fn owner_in(n: Note, r: Room): Bool = exists(Member where .user == n.owner and .room == r)
view owners_in(r: Room) { rows Note where owner_in(it, r) order by .name }
layout l { <Main><Slot name=main /></Main> }
screen s(u: User, r: Room) { route "/:u/:r"  layout l  access public
  <Main>
    <List of={rooms_of(u)} as=x><Text class="a">{x.name}</Text></List>
    <List of={rooms_not_of(u)} as=x><Text class="b">{x.name}</Text></List>
    <List of={pinned_by(u)} as=x><Text class="c">{x.name}</Text></List>
    <List of={not_pinned_by(u)} as=x><Text class="d">{x.name}</Text></List>
    <List of={owners_in(r)} as=x><Text class="e">{x.name}</Text></List>
  </Main>
}
`;
const dir = mkdtempSync(join(tmpdir(), "semijoin-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const go = Object.values(generate(join(dir, "app.crud"))).join("\n");
ok("in_room is compiled as an IN; room is required, so no NULL test", /IN \(SELECT t\d+\.\\?"room\\?" FROM \\?"Member\\?" t\d+ WHERE \(t\d+\.\\?"user\\?" = \?\)/.test(go), go.match(/[^\n]*Member\\?" t\d+ WHERE[^\n]*/)?.[0]);
ok("pinned's list keeps out a none note (Pin.note is optional)", /IN \(SELECT t\d+\.\\?"note\\?" FROM \\?"Pin\\?" t\d+ WHERE t\d+\.\\?"note\\?" IS NOT NULL AND/.test(go), go.match(/[^\n]*Pin\\?" t\d+ WHERE[^\n]*/)?.[0]);
ok("an outer side that can be none (n.owner) keeps the EXISTS", /EXISTS \(SELECT 1 FROM \\?"Member\\?"/.test(go));
const app = await startApp(join(dir, "app.crud"), 13893);
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  const R = (e: string, id: number | null) => (id === null ? null : { ref: e, id });
  await app.post("/_test/load", { clock: 1000, rows: {
    User: [row(1, { name: "ada" }), row(2, { name: "bob" })],
    Room: [row(1, { name: "r1" }), row(2, { name: "r2" }), row(3, { name: "r3" })],
    Member: [row(1, { room: R("Room", 1), user: R("User", 1) }), row(2, { room: R("Room", 3), user: R("User", 1) }), row(3, { room: R("Room", 2), user: R("User", 2) })],
    Note: [row(1, { name: "n1", owner: R("User", 1) }), row(2, { name: "n2", owner: null }), row(3, { name: "n3", owner: R("User", 2) })],
    Pin: [row(1, { note: R("Note", 1), user: R("User", 1) }), row(2, { note: null, user: R("User", 1) }), row(3, { note: R("Note", 3), user: R("User", 2) })],
  } });
  const names = (html: string, cls: string) => [...html.matchAll(new RegExp(`<span class="${cls}">([^<]*)</span>`, "g"))].map((m) => m[1]).join(",");
  const ada = await (await fetch(app.base + "/1/2")).text();
  ok("ada's rooms", names(ada, "a") === "r1,r3", names(ada, "a"));
  ok("... not ada's: the rest (not of an IN)", names(ada, "b") === "r2", names(ada, "b"));
  ok("ada's pins, though one pin's note is none", names(ada, "c") === "n1", names(ada, "c"));
  ok("... notes ada hasn't pinned: the none in the list hides none of them", names(ada, "d") === "n2,n3", names(ada, "d"));
  ok("notes whose owner is in r2 (the EXISTS kept)", names(ada, "e") === "n3", names(ada, "e"));
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
