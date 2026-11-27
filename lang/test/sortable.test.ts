// Sortable views (view … { sortable a, b }): a list sorts by any field named, either way, chosen by
// the view's sort parameter ("a" A to Z, "-a" Z to A), each order a statement SQLite runs, so a
// paged view pages in that order. toggle_sort(sort, "a") is what a column's heading links to.
//   node lang/test/sortable.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { withGenerated } from "../scaffold.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", typeof detail === "string" ? detail.slice(0, 600) : JSON.stringify(detail)?.slice(0, 600)); } };

const SPEC = `
app t { name "T" }
entity Task { title: Text max 40  priority: Int = 0  done: Bool = false }
policy task_rows: true for rows of Task
// The tasks, a page at a time, found by their title and sorted by a column.
view tasks(q: Text?, sort: Text?) {
  rows Task where q == none or contains(lower(.title), lower(q))
  order by created desc
  sortable title, priority
  page 3
}
layout l { <main><Slot name=main /></main> }
screen home(q: Text?, sort: Text?) {
  route "/"
  layout l
  require public
  <Fill name=main>
    <nav>
      <Link to={home(q, toggle_sort(sort, "title"))} class="col"><span>Title</span></Link>
      <Link to={home(q, toggle_sort(sort, "priority"))} class="col"><span>Priority</span></Link>
    </nav>
    <List of={tasks(q, sort)} as=t class="list"><div class="row"><span class="t">{t.title}</span></div></List>
  </Fill>
}
`;
const findings = (src: string) => { const s = parse(src); const f = check(s, { source: src }); return f.some((x) => x.severity === "error") ? f : [...f, ...typecheck(withGenerated(parse(src), parse)).findings]; };
const errs = (src: string) => findings(src).filter((f: any) => f.severity === "error").map((f: any) => f.code);
ok("the spec checks clean", errs(SPEC).length === 0, findings(SPEC).filter((f: any) => f.severity === "error"));
ok("a sortable view says sort: Text? as a parameter", errs(SPEC.replace("view tasks(q: Text?, sort: Text?)", "view tasks(q: Text?)").replace("tasks(q, sort)", "tasks(q)")).includes("SORTABLE"));
ok("it sorts by fields the rows have", errs(SPEC.replace("sortable title, priority", "sortable title, priorty")).includes("SORTABLE"));

const dir = mkdtempSync(join(tmpdir(), "sortable-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 14001);
try {
  const rows = ["Banana 3", "apple 5", "Cherry 1", "date 4", "Elder 2"].map((x, i) => ({ id: i + 1, seq: i + 1, created: (i + 1) * 1000, updated: 0, fields: { title: x.split(" ")[0], priority: Number(x.split(" ")[1]), done: false } }));
  await app.post("/_test/load", { clock: 10_000, rows: { Task: rows } });
  const page = async (qs: string) => await (await fetch(`${app.base}/${qs}`, { headers: { "X-No-Cache": "1" } })).text();
  const titles = (html: string) => [...html.matchAll(/<span class="t">([^<]*)<\/span>/g)].map((m) => m[1]);
  const next = (html: string) => /href="([^"]*after[^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  ok("no sort: the view's own order (newest first), a page of 3", titles(await page("")).join() === "Elder,date,Cherry", titles(await page("")));
  const az = await page("?sort=title");
  ok("sort=title: A to Z (as SQLite orders text)", titles(az).length === 3 && titles(az)[0] === "Banana", titles(az));
  const azNext = next(az);
  ok("... the next page goes on in that order, with the sort kept", !!azNext && /sort=title/.test(azNext!) && titles(await page(azNext!.replace(/^\//, ""))).length === 2, { azNext, rest: azNext && titles(await page(azNext.replace(/^\//, ""))) });
  ok("... and the two pages are every row once", azNext ? new Set([...titles(az), ...titles(await page(azNext.replace(/^\//, "")))]).size === 5 : false);
  ok("sort=-priority: highest first", titles(await page("?sort=-priority")).join() === "apple,date,Banana", titles(await page("?sort=-priority")));
  ok("sort=priority: lowest first", titles(await page("?sort=priority")).join() === "Cherry,Elder,Banana", titles(await page("?sort=priority")));
  ok("a sort the view doesn't have is its own order", titles(await page("?sort=done")).join() === "Elder,date,Cherry");
  ok("a search with a sort", titles(await page("?q=e&sort=title")).join() === "Cherry,Elder,apple", titles(await page("?q=e&sort=title")));
  const head = await page("?sort=title");
  ok("a heading links to the other way when sorted by it, and A to Z for another", /href="\/\?sort=-title"/.test(head) && /href="\/\?sort=priority"/.test(head), head.slice(0, 600));
} finally { app.stop(); }
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all passed");
