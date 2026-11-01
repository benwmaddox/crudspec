// A view's order, window and limit in the compiled app: the rows' own `order by` is kept (it was
// once dropped), and when the database can order and limit the rows itself (gen.ts SQLOrder,
// rt WindowRows) the page shows exactly the rows Go's sort and window would.
//   node lang/test/query-order.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };
const SPEC = `
app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Note { name: Text }
policy note_rows: true for rows of Note
view by_name() { rows Note where true order by lower(.name) }
view by_name_desc() { rows Note where true order by lower(.name) desc }
view newest(more: Bool?) { rows Note where true order by created  page 3 last unless more == true }
view oldest_first() { rows Note where true order by created desc  page 2 last }
view first_two() { rows Note where true limit 2 }
view latest_two() { rows Note where true order by created desc limit 2 }
layout l { <Main><Slot name=main /></Main> }
screen s(more: Bool?) { route "/"  layout l  access public
  <Main>
    <List of={by_name()} as=n><span class="a">{n.name}</span></List>
    <List of={by_name_desc()} as=n><span class="ad">{n.name}</span></List>
    <List of={newest(more)} as=n><span class="b">{n.name}</span></List>
    <List of={oldest_first()} as=n><span class="od">{n.name}</span></List>
    <List of={first_two()} as=n><span class="c">{n.name}</span></List>
    <List of={latest_two()} as=n><span class="d">{n.name}</span></List>
  </Main>
}
`;
const dir = mkdtempSync(join(tmpdir(), "query-order-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13891);
try {
  // created out of step with insertion (seq), so the two orders differ
  const notes = [["c", 300], ["a", 100], ["B", 200], ["d", 400], ["e", 50]].map(([name, created], i) => ({ id: i + 1, seq: i + 1, created, updated: created, fields: { name } }));
  await app.post("/_test/load", { clock: 1000, rows: { User: [], Note: notes } });
  const page = async (q = "") => await (await fetch(app.base + "/" + q)).text();
  const names = (html: string, cls: string) => [...html.matchAll(new RegExp(`<span class="${cls}">([^<]*)</span>`, "g"))].map((m) => m[1]).join(",");
  const html = await page();
  ok("rows ordered by lower(.name)", names(html, "a") === "a,B,c,d,e", names(html, "a"));
  ok("... desc", names(html, "ad") === "e,d,c,B,a", names(html, "ad"));
  ok("page 3 last, by created: the three newest, oldest first", names(html, "b") === "B,c,d", names(html, "b"));
  ok("by created desc, page 2 last", names(html, "od") === "a,e", names(html, "od"));
  ok("limit 2 with no order: the first two inserted", names(html, "c") === "c,a", names(html, "c"));
  ok("by created desc, limit 2", names(html, "d") === "d,c", names(html, "d"));
  const more = await page("?more=true");
  ok("unless more: the window's other end", names(more, "b") === "e,a,B", names(more, "b"));
  // a new row is seen at once (the request's memo and the page's cache don't hide it)
  await app.post("/_test/load", { clock: 2000, rows: { User: [], Note: [...notes, { id: 6, seq: 6, created: 500, updated: 500, fields: { name: "f" } }] } });
  ok("a newer row enters the window", names(await page(), "b") === "c,d,f", names(await page(), "b"));
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
