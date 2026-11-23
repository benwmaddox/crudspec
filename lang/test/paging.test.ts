// A view with page n gives one page of its rows at a time, from a cursor (rt/paging.go): a screen's
// list shows a page and links to the next (the cursor in its address), an agent sends the cursor
// back. Pages follow the order through ties, either way; each is cached on its own; a cursor the
// view didn't give is the first page on a screen and invalid for an agent. A paged view must order
// by an always-set field SQLite orders (PAGE_ORDER), and can't update live yet (PAGE_LIVE).
//   node lang/test/paging.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../gogen/gen.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app t { name "T"  actor User  agents_anonymous true  indexes auto }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
identity agent: User from token
entity Item { name: Text  note: Text? }
policy item_rows: true for rows of Item
// items by name, a page at a time
view items() { rows Item where true  order by .name  page 3 }
// items by name, last first, a page at a time
view items_back() { rows Item where true  order by .name desc  page 3 }
layout l { <main><Slot name=main /></main> }
screen list { route "/items"  layout l  require public
  <Fill name=main>
    <List of={items()} as=i><span class="i">{i.name}</span></List>
  </Fill>
}
screen back { route "/back"  layout l  require public
  <Fill name=main>
    <List of={items_back()} as=i><span class="i">{i.name}</span></List>
  </Fill>
}
`;
const dir = mkdtempSync(join(tmpdir(), "paging-"));
const build = (src: string) => { writeFileSync(join(dir, "app.crud"), src); try { generate(join(dir, "app.crud")); return ""; } catch (e) { return String((e as Error).message ?? e); } };
ok("a paged view by an optional field: PAGE_ORDER", /PAGE_ORDER/.test(build(SPEC.replace("order by .name  page 3 }", "order by .note  page 3 }"))));
ok("a paged view that updates live: PAGE_LIVE", /PAGE_LIVE/.test(build(SPEC.replace("view items() { rows", "view items() { updates live  rows"))));
writeFileSync(join(dir, "app.crud"), SPEC);

const app = await startApp(join(dir, "app.crud"), 14101);
try {
  const row = (id: number, name: string) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields: { name, note: null } });
  // three rows tie on b: a page boundary falls among them
  await app.post("/_test/load", { clock: 1000, rows: { Item: [row(1, "a"), row(2, "b"), row(3, "b"), row(4, "b"), row(5, "c"), row(6, "d"), row(7, "e")] } });
  const get = async (path: string) => await (await fetch(app.base + path)).text();
  const names = (html: string) => [...html.matchAll(/<span class="i">([^<]*)<\/span>/g)].map((m) => m[1]).join(",");
  const next = (html: string) => html.match(/<a href="([^"]+)" rel="next">/)?.[1]?.replace(/&amp;/g, "&");
  const first = (html: string) => /rel="first"/.test(html);
  // every page, following Next
  const walk = async (start: string) => { const pages: string[] = []; let path: string | undefined = start, html = ""; while (path && pages.length < 10) { html = await get(path); pages.push(names(html)); path = next(html); } return { pages, last: html }; };
  const up = await walk("/items");
  ok("pages of three, through the ties, none skipped or shown twice", up.pages.join(" | ") === "a,b,b | b,c,d | e", up.pages);
  const p1 = await get("/items");
  ok("the first page links to the next, not back to the start", !!next(p1) && !first(p1));
  ok("the last links back to the start, and to no next", first(up.last) && !next(up.last));
  const down = await walk("/back");
  ok("desc: the same, last first", down.pages.join(" | ") === "e,d,c | b,b,b | a", down.pages);

  // each page is kept on its own
  const hits = async () => (await app.post("/_test/cache-check", {})).page_hits as number;
  const p2path = next(p1)!;
  await get(p2path);
  const h0 = await hits();
  const again = await get(p2path);
  ok("a page asked again is sent from the cache, and is still that page", (await hits()) === h0 + 1 && names(again) === "b,c,d", { h0, now: await hits(), names: names(again) });

  ok("a cursor the view didn't give: the first page", names(await get("/items?after.items=nonsense")) === "a,b,b");

  // an agent pages with cursor, and is told the next one
  const call = async (body: unknown) => await (await fetch(app.base + "/_agent/call/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const a1 = await call({ args: {} });
  const a2 = a1.next ? await call({ args: {}, cursor: a1.next }) : {};
  const a3 = a2.next ? await call({ args: {}, cursor: a2.next }) : {};
  const nm = (r: any) => (r.rows ?? []).map((x: any) => x.name ?? x.fields?.name).join(",");
  ok("an agent's pages, each with next until the last", nm(a1) === "a,b,b" && nm(a2) === "b,c,d" && nm(a3) === "e" && !a3.next, [a1, a2, a3].map((r: any) => ({ rows: nm(r), next: !!r.next, outcome: r.outcome })));
  const bad = await call({ args: {}, cursor: "nonsense" });
  ok("... and a cursor the view didn't give is invalid", bad.outcome === "invalid", bad);
  const desc = await (await fetch(app.base + "/_agent/describe")).json();
  const d = (desc.callables ?? desc.tools ?? []).find((c: any) => c.name === "items");
  ok("describe says the view pages, and how", /A page of 3 at a time/.test(d?.description ?? ""), d?.description);
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
