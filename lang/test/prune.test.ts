// Column pruning (gogen/rt/prune.go): every page of every app is the same with pruning on and
// off, and with the text fields it leaves out marked (X-Prune: check), no page shows a mark.
// Each page is rendered three times by one test app, so its signed values are the same.
// A read permission that runs in Go (not in the SQL) reads its row as the page loaded it: a field
// only its predicate reads is still loaded, so the rows it allows still show.
//   node lang/test/prune.test.ts          (needs Go: on Windows, in WSL)
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { readSpec } from "../source.ts";
import { startApp } from "./go-app.ts";
import { loadFixture, screenPaths } from "./fixture.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2).slice(0, 2000)); } };
const APPS: [string, number][] = [["apps/campfire", 13921], ["apps/tasks", 13922], ["apps/todomvc", 13923], ["app3", 13924]];
const MARK = "⟦pruned⟧";
// what differs from one render to the next whatever is read: links signed with the time (a
// session transfer and its QR code), and the fragment markers that hash them
const norm = (s: string) => s.replace(/<!--[^>]*-->/g, "").replace(/\/session\/transfers\/[A-Za-z0-9_.-]*/g, "/session/transfers/(link)").replace(/\/_qr\/[A-Za-z0-9_-]*/g, "/_qr/(qr)");
for (const [dir, port] of APPS) {
  const spec = parse(readSpec(dir));
  const assets = dir === "apps/campfire" && existsSync("/mnt/d/code/crudspec-assets/campfire") ? { assets: "/mnt/d/code/crudspec-assets/campfire" } : {};
  const app = await startApp(dir, port, assets);
  try {
    const headers = await loadFixture(app, spec);
    // (the fragment cache off, so each render reads the database)
    const page = async (path: string, prune: string) => { const r = await fetch(app.base + path, { headers: { ...headers, "X-No-Cache": "1", ...(prune ? { "X-Prune": prune } : {}) }, redirect: "manual" }); return `${r.status} ${r.headers.get("location") ?? ""}\n${await r.text()}`; };
    const differ: string[] = [], marked: string[] = [];
    let shown = 0;
    for (const [name, path] of screenPaths(spec)) {
      const off = await page(path, "0"), on = await page(path, ""), check = await page(path, "check");
      if (off.startsWith("200")) shown++;
      if (norm(on) !== norm(off)) differ.push(name);
      if (check.includes(MARK)) marked.push(name);
    }
    ok(`${dir}: every page (${shown} shown) the same with pruning on and off`, shown > 0 && differ.length === 0, differ);
    ok(`${dir}: no page shows a text field pruning left out`, marked.length === 0, marked);
  } finally { app.stop(); }
}
// a page that shows only tickets' subjects, under a read permission that runs in Go (initials()
// isn't SQL): the permission reads Ticket.customer, which the page itself doesn't
{
  const dir = mkdtempSync(join(tmpdir(), "prune-perm-"));
  const desk = readSpec("app3")
    .replace("fn can_read_ticket(t: Ticket): Bool = t.customer == actor or actor.role == staff", `fn can_read_ticket(t: Ticket): Bool = t.customer == actor or actor.role == staff or initials(t.subject) == "ZZ"`);
  writeFileSync(join(dir, "desk.crud"), desk + `
view open_tickets() {
  require actor != none else unauthenticated
  rows Ticket where .status == open
}

screen ticket_titles {
  route "/titles"
  layout app
  <Title>Titles</Title>
  <Fill name=main>
    <List of={open_tickets()} as=t>
      <span>{t.subject}</span>
    </List>
  </Fill>
}
`);
  const app = await startApp(dir, 13925);
  try {
    const T0 = 1_800_000_000_000;
    const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: T0, updated: T0, fields });
    await app.post("/_test/load", { clock: T0, seq: 100, rows: {
      User: [row(1, { name: "Cara Customer", email: "cara@example.com", password: { password: "secret-pass" }, role: "customer" })],
      Session: [row(2, { user: { ref: "User", id: 1 }, token: "tok-1" })],
      Ticket: [row(3, { customer: { ref: "User", id: 1 }, subject: "Printer is on fire", description: "smoke", status: "open", assigned_to: null })],
      TicketMessage: [],
    } });
    const shows = async (prune: string) => (await (await fetch(app.base + "/titles", { headers: { Cookie: "session_token=tok-1", "X-No-Cache": "1", ...(prune ? { "X-Prune": prune } : {}) } })).text()).includes("Printer is on fire");
    const off = await shows("0"), on = await shows("");
    ok("a read permission in Go sees the field it reads, with pruning on", off && on, { off, on });
  } finally { app.stop(); }
}
process.exit(failed ? 1 : 0);
