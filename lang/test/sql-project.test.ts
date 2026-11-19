// A list's value worked out by SQL (rt Project): list(.user.name for Membership where …) is one
// SELECT of the names, not the memberships read and then each user (an N+1). Each kind comes back
// as the app's own value (text, Int, Bool, Date, Decimal, a reference, none), in the query's order,
// and a page showing the names is told when a referenced row's name changes.
//   node lang/test/sql-project.test.ts
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
entity Member { room: Room  user: User?  joined: Date?  paid: Decimal = 0  admin: Bool = false  n: Int = 0 }
policy pu: true for rows of User
policy pr: true for rows of Room
policy pm: true for rows of Member
query names(r: Room): Text = join(list(default(.user.name, "?") for Member where .room == r order by lower(default(.user.name, ""))), ",")
action show(r: Room) { callers people
  set actor.name = "{names(r)}|{join(list(text(.n) for Member where .room == r), ",")}|{count(list(.user for Member where .room == r and .user != none))}|{join(list(format_date(default(.joined, date(2000, 1, 1)), "YYYY-MM-DD") for Member where .room == r), ",")}"
}
action paid(r: Room) { callers people  set actor.name = join(list(text(.paid) for Member where .room == r order by .paid desc), ",") }
action admins(r: Room) { callers people  set actor.name = join(list(if .admin { "y" } else { "n" } for Member where .room == r), ",") }
action rename(u: User, n: Text) { callers people  set u.name = n }
layout l { <main><Slot name=main /></main> }
screen s(room: Room) { route "/r/:room"  layout l  require public
  <Fill name=main><p class="names">{names(room)}</p></Fill>
}
`;
const dir = mkdtempSync(join(tmpdir(), "sql-project-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const go = generate(join(dir, "app.crud"))["app.go"];
const fnBody = go.slice(go.indexOf("func F_names("), go.indexOf("\n", go.indexOf("func F_names(")));
ok("nothing left to the app", inApp().length === 0, inApp());
ok("names(r) is one SELECT of the users' names (Project), no user looked up per row", fnBody.includes("c.Project(") && fnBody.includes(JSON.stringify(`(SELECT "name" FROM "User" x WHERE x.id = t0."user")`).slice(1, -1)), fnBody.slice(0, 600));
ok("... and it reads User:name, for live pages", fnBody.includes(`"User:name"`), fnBody.slice(0, 900));

const app = await startApp(join(dir, "app.crud"), 14013);
try {
  const row = (id: number, fields: any) => ({ id, seq: id, created: id, updated: id, fields });
  const ref = (e: string, id: number) => ({ ref: e, id });
  await app.post("/_test/load", { clock: 1000, rows: {
    User: [row(1, { name: "me", token: "t" }), row(2, { name: "bea", token: null }), row(3, { name: "Al", token: null })],
    Room: [row(1, { name: "r" })],
    Member: [
      row(1, { room: ref("Room", 1), user: ref("User", 2), joined: { date: "2026-01-05" }, paid: { dec: "2.50" }, admin: true, n: 3 }),
      row(2, { room: ref("Room", 1), user: null, joined: null, paid: { dec: "10.00" }, admin: false, n: -1 }),
      row(3, { room: ref("Room", 1), user: ref("User", 3), joined: { date: "2025-12-31" }, paid: { dec: "0.05" }, admin: false, n: 0 }),
    ] } });
  const run = async (call: string, args: any) => { const r = await app.post("/_test/run", { call, args, actor: ref("User", 1), now: 0 }); return r.outcome === "ok" ? (await app.post("/_test/dump", {})).rows.User.find((u: any) => u.id === 1).fields.name : `(${r.outcome})`; };
  ok("text through a reference, none as \"?\", ordered by lower(): ?, Al, bea", (await run("show", { r: ref("Room", 1) })) === "?,Al,bea|3,-1,0|2|2026-01-05,2000-01-01,2025-12-31", await run("show", { r: ref("Room", 1) }));
  ok("Decimals, desc: 10.00, 2.50, 0.05", (await run("paid", { r: ref("Room", 1) })) === "10.00,2.50,0.05", await run("paid", { r: ref("Room", 1) }));
  ok("Bools", (await run("admins", { r: ref("Room", 1) })) === "y,n,n", await run("admins", { r: ref("Room", 1) }));
  // a page showing the names is told when a user is renamed (it read User:name)
  const page = async () => {
    const html = await (await fetch(app.base + "/r/1")).text();
    const pd = /<script id="crudspec-page" type="application\/json">(.*?)<\/script>/s.exec(html);
    const pv = pd ? JSON.parse(pd[1].replace(/<\\\//g, "</")) : { v: 0, d: [] };
    for (const f of html.matchAll(/<!--\/f:[0-9a-f]+ [0-9a-z]+([^>]*?)-->/g)) pv.d.push(...f[1].trim().split(" ").filter(Boolean));
    return { html, keys: pv.d as string[], v: pv.v as number, names: /<p class="names">([^<]*)<\/p>/.exec(html)?.[1] };
  };
  const told = async (v: number) => {
    const ac = new AbortController();
    const res = await fetch(`${app.base}/_events?since=${v}`, { signal: ac.signal });
    const reader = res.body!.getReader(); let buf = "";
    for (;;) { const { value } = await reader.read(); buf += new TextDecoder().decode(value); const m = /data: (\d+)([^\n]*)\n\n/.exec(buf); if (m) { ac.abort(); return m[2].trim().split(" ").filter(Boolean); } }
  };
  const p = await page();
  ok("the page shows the names", p.names === "?,Al,bea", p.names);
  await app.post("/_test/run", { call: "rename", args: { u: ref("User", 3), n: "Zed" }, actor: ref("User", 1), now: 5 });
  const k = await told(p.v);
  ok("renaming a member's user tells the page", k[0] === "*" || k.some((x) => p.keys.includes(x)), { k, keys: p.keys });
  ok("... which then shows the new name, in its place", (await page()).names === "?,bea,Zed");
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
