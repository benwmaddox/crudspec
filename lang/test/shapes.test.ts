// One statement per request shape (gen.ts queryLit): the conditions a query's SQL would test
// for the request (an optional value given or not, a row-free condition) are worked out first and
// pick SQL planned for exactly that shape: no ? IS NULL, no CASE, and no query at all for a shape
// that can match nothing. Each shape returns what the language says.
//   node lang/test/shapes.test.ts
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
entity Note { title: Text  rank: Int  owner: User? on delete cascade }
entity Pin { note: Note on delete cascade  label: Text }
permission read Note: true
permission read Pin: true
view after(n: Note?) { rows Note where (n == none or .rank > n.rank) order by .title }
view owned(u: User?) { rows Note where .owner == u order by .title }
view pins_of(n: Note?) { rows Pin where .note == n order by .label }
layout l { <main><slot name=main /></main> }
screen s(n: Note?, u: User?) { route "/"  layout l  access public
  <main>
    <list of={after(n)} as=x><text class="a">{x.title}</text></list>
    <list of={owned(u)} as=x><text class="o">{x.title}</text></list>
    <list of={pins_of(n)} as=x><text class="p">{x.label}</text></list>
  </main>
}
`;
const dir = mkdtempSync(join(tmpdir(), "shapes-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const go = Object.values(generate(join(dir, "app.crud"))).join("\n");
const sqls = [...go.matchAll(/\b(sq\d+) = ("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[2]) as string);
ok("no statement tests the request in SQL (no ? IS NULL, no CASE, no (? = 1))", !sqls.some((x) => /\? IS NULL|CASE WHEN|\(\? = 1\)/.test(x)), sqls);
ok("n given: a plain comparison", sqls.some((x) => x.includes(`(t0."rank" > ?)`)), sqls);
ok("u not given: the notes with no owner (owner is optional: IS NULL)", sqls.some((x) => x.includes(`(t0."owner" IS NULL)`)), sqls);
ok("u given: owner = ?", sqls.some((x) => x.includes(`(t0."owner" = ?)`)), sqls);
ok("pins of no note: a required reference never matches none, so no query", /Never: true/.test(go));
const app = await startApp(join(dir, "app.crud"), 13905);
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  const R = (e: string, id: number | null) => (id === null ? null : { ref: e, id });
  await app.post("/_test/load", { clock: 1000, rows: {
    User: [row(1, { name: "ada", token: null })],
    Note: [row(1, { title: "a", rank: 1, owner: R("User", 1) }), row(2, { title: "b", rank: 2, owner: null }), row(3, { title: "c", rank: 3, owner: R("User", 1) })],
    Pin: [row(1, { note: R("Note", 1), label: "p1" }), row(2, { note: R("Note", 2), label: "p2" })],
  } });
  const page = async (q: string) => await (await fetch(app.base + "/" + q)).text();
  const names = (html: string, cls: string) => [...html.matchAll(new RegExp(`<span class="${cls}">([^<]*)</span>`, "g"))].map((m) => m[1]).join(",");
  const none = await page("");
  ok("no n: every note", names(none, "a") === "a,b,c", names(none, "a"));
  ok("no u: the note with no owner", names(none, "o") === "b", names(none, "o"));
  ok("no n: no pins", names(none, "p") === "", names(none, "p"));
  const given = await page("?n=1&u=1");
  ok("n = note 1: the notes ranked above it", names(given, "a") === "b,c", names(given, "a"));
  ok("u = ada: her notes", names(given, "o") === "a,c", names(given, "o"));
  ok("n = note 1: its pin", names(given, "p") === "p1", names(given, "p"));
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
