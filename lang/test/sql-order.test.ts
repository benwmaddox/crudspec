// Orders the database works out (docs/design/sql-first.md): an order by an expression of the row
// (lower(.name)), a field of a referenced row (lower(.room.name), .room.created), updated, a Date
// or a Decimal is SQL's ORDER BY, so a window (page 2 first) reads only the rows it keeps, in
// exactly the order Go's sort gives (none first, ties by insertion). A page showing one is told
// when an order key changes, a referenced row's included: it is read again, not served stale.
//   node lang/test/sql-order.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, inApp } from "../gogen/gen.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app t { name "T" actor User }
entity User { name: Text  token: Text?  unique (token) }
identity login: User.token from cookie "login"
entity Room { name: Text }
entity Note { name: Text  room: Room?  due: Date?  price: Decimal = 0 }
policy pr: true for rows of Room
policy pn: true for rows of Note
view by_lower() { rows Note where true order by lower(.name)  page 3 first }
view by_room() { rows Note where true order by lower(.room.name)  page 3 first }
view by_room_made() { rows Note where true order by .room.created desc  page 2 first }
view by_updated() { rows Note where true order by updated desc  page 2 first }
view by_due() { rows Note where true order by .due  page 3 first }
view by_price() { rows Note where true order by .price desc  page 2 first }
view in_room(r: Room) { rows Note where .room == r order by lower(.name)  page 2 first }
action rename(r: Room, n: Text) { callers people  set r.name = n }
action touch(x: Note, n: Text) { callers people  set x.name = n }
layout l { <main><Slot name=main /></main> }
screen s() { route "/"  layout l  require public
  <Fill name=main>
    <List of={by_lower()} as=n><span class="a">{n.name}</span></List>
    <List of={by_room()} as=n><span class="b">{n.name}</span></List>
    <List of={by_room_made()} as=n><span class="c">{n.name}</span></List>
    <List of={by_updated()} as=n><span class="d">{n.name}</span></List>
    <List of={by_due()} as=n><span class="e">{n.name}</span></List>
    <List of={by_price()} as=n><span class="f">{n.name}</span></List>
  </Fill>
}
screen r(room: Room) { route "/r/:room"  layout l  require public
  <Fill name=main><List of={in_room(room)} as=n><span class="g">{n.name}</span></List></Fill>
}
`;
const dir = mkdtempSync(join(tmpdir(), "sql-order-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const go = generate(join(dir, "app.crud"))["app.go"];
ok("no order is left to the app", inApp().filter((x) => x.kind === "order").length === 0, inApp());
ok("lower(.room.name) is SQL's: the runtime's lower of the room's name", go.includes(JSON.stringify(`cs_lower((SELECT "name" FROM "Room" x WHERE x.id = t0."room")), t0.seq`).slice(1, -1)), go.match(/SQLOrder: "[^"\n]*/g));
ok("... and the page reads the room's name (OrderReads)", /OrderReads: \[\]string\{"Room:name", "Note:room"\}|OrderReads: \[\]string\{"Note:room", "Room:name"\}/.test(go), go.match(/OrderReads: [^}]*\}/g));

const app = await startApp(join(dir, "app.crud"), 14010);
try {
  const row = (id: number, fields: any, created = id * 10, updated = id * 10) => ({ id, seq: id, created, updated, fields });
  const ref = (e: string, id: number) => ({ ref: e, id });
  // created and updated out of step with insertion, names of mixed case, a Note with no room
  await app.post("/_test/load", { clock: 1000, rows: {
    User: [row(1, { name: "u", token: "t" })],
    Room: [row(1, { name: "beta" }, 300), row(2, { name: "Alpha" }, 100), row(3, { name: "gamma" }, 200)],
    Note: [
      row(1, { name: "d", room: ref("Room", 1), due: { date: "2026-12-01" }, price: { dec: "2.50" } }, 10, 50),
      row(2, { name: "B", room: ref("Room", 2), due: null, price: { dec: "10.00" } }, 20, 40),
      row(3, { name: "a", room: null, due: { date: "2026-11-01" }, price: { dec: "2.50" } }, 30, 30),
      row(4, { name: "C", room: ref("Room", 3), due: { date: "2026-11-15" }, price: { dec: "0.10" } }, 40, 60),
      row(5, { name: "e", room: ref("Room", 1), due: null, price: { dec: "7.00" } }, 50, 10),
    ] } });
  const call = async (action: string, args: Record<string, string>) => (await fetch(app.base + "/_do/" + action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test-Actor": "User:1" }, body: new URLSearchParams(args), redirect: "manual" })).headers.get("X-Crudspec-Outcome");
  const page = async (path = "/") => {
    const html = await (await fetch(app.base + path)).text();
    const pd = /<script id="crudspec-page" type="application\/json">(.*?)<\/script>/s.exec(html);
    const pv = pd ? JSON.parse(pd[1].replace(/<\\\//g, "</")) : { v: 0, d: [] };
    const keys: string[] = pv.d;
    for (const f of html.matchAll(/<!--\/f:[0-9a-f]+ [0-9a-z]+([^>]*?)-->/g)) keys.push(...f[1].trim().split(" ").filter(Boolean));
    return { html, keys, v: pv.v as number };
  };
  // the keys of the next change after version v (* is every page); whether a change tells a page
  const told = async (v: number) => {
    const ac = new AbortController();
    const res = await fetch(`${app.base}/_events?since=${v}`, { signal: ac.signal });
    const reader = res.body!.getReader(); let buf = "";
    for (;;) {
      const { value } = await reader.read(); buf += new TextDecoder().decode(value);
      const m = /data: (\d+)([^\n]*)\n\n/.exec(buf);
      if (m) { ac.abort(); return m[2].trim().split(" ").filter(Boolean); }
    }
  };
  const tells = async (pg: { keys: string[]; v: number }, change: () => Promise<unknown>) => { await change(); const k = await told(pg.v); return k[0] === "*" || k.some((x) => pg.keys.includes(x)); };
  const names = (html: string, cls: string) => [...html.matchAll(new RegExp(`<span class="${cls}">([^<]*)</span>`, "g"))].map((m) => m[1]).join(",");
  let p = await page();
  ok("lower(.name), page 3 first: a, B, C (not byte order's B, C, a)", names(p.html, "a") === "a,B,C", names(p.html, "a"));
  ok("lower(.room.name): no room first, then alpha, beta (twice, by insertion)", names(p.html, "b") === "a,B,d", names(p.html, "b"));
  ok(".room.created desc, page 2: beta's room (300) first, desc by insertion too; no room last", names(p.html, "c") === "e,d", names(p.html, "c"));
  ok("updated desc, page 2", names(p.html, "d") === "C,d", names(p.html, "d"));
  ok(".due (a Date): none first, then by day", names(p.html, "e") === "B,e,a", names(p.html, "e"));
  ok(".price desc (a Decimal, exact): 10.00, 7.00", names(p.html, "f") === "B,e", names(p.html, "f"));
  // a room renamed: the order by its name changes, and the page is told (not served from its cache)
  ok("renaming a room tells the page (it orders by the room's name)", await tells(p, () => call("rename", { r: "3", n: "aardvark" })));
  p = await page();
  ok("... the order by the room's name is new: a, C (aardvark), B", names(p.html, "b") === "a,C,B", names(p.html, "b"));
  ok("a note renamed: the order by lower(.name) is new", (await call("touch", { x: "5", n: "A0" })) === "ok" && names((await page()).html, "a") === "a,A0,B", names((await page()).html, "a"));
  ok("... and its update moved it to the front of updated desc", names((await page()).html, "d") === "A0,C", names((await page()).html, "d"));
  // a where held to a room's rows: the page is told of any change to them by the room's key, so it
  // needs no key of the whole name column
  const r1 = await page("/r/1");
  ok("in_room(r): lower(.name) of the room's notes", names(r1.html, "g") === "A0,d", names(r1.html, "g"));
  ok("... renaming a note of another room doesn't tell it", !(await tells(r1, () => call("touch", { x: "2", n: "b2" }))));
  ok("... renaming one of its own does", await tells(await page("/r/1"), () => call("touch", { x: "1", n: "z" })));
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
