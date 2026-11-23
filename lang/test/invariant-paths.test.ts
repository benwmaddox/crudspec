// An entity invariant that reads along a chain of references (self.field.template.wiki) checks
// again only the rows a change reaches back along that chain, not every row on any write: a
// changed template, the fields that point at it, then the values that point at those. A change
// the invariant doesn't read leaves its rows unchecked; one that breaks it is still refused.
//   node lang/test/invariant-paths.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generate } from "../gogen/gen.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app t { name "T" }
entity Wiki { name: Text }
entity Template { wiki: Wiki  name: Text }
entity Field { template: Template  name: Text }
entity Page { wiki: Wiki  title: Text }
entity Note { body: Text }
entity Value {
  page: Page
  field: Field
  text: Text
  invariant self.field.template.wiki == self.page.wiki
}
policy all_rows: true for rows of Wiki, Template, Field, Page, Note, Value
action move_template(t: Template, w: Wiki) { set t.wiki = w }
action move_field(f: Field, t: Template) { set f.template = t }
action move_page(p: Page, w: Wiki) { set p.wiki = w }
action retitle(p: Page, title: Text) { set p.title = title }
action note(body: Text) { create Note { body: body } }
`;
const dir = mkdtempSync(join(tmpdir(), "invariant-paths-"));
writeFileSync(join(dir, "app.crud"), SPEC);

// the generated checks: each entity on the chain found back by it, none of them every row
const go = Object.values(generate(join(dir, "app.crud"))).join("\n");
const block = go.slice(go.indexOf("func invariants("), go.indexOf("var migrate"));
ok("no change checks every Value", !/all = true/.test(block), block);
ok("a changed Template: its Fields, then their Values", /range t\["Template"\] \{ for _, r1 := range c\.S\.Select\(E_Field, [^,]+, id\) \{ for _, r0 := range c\.S\.Select\(E_Value, [^,]+, r1\.ID\)/.test(block), block);
ok("a changed Field or Page: the Values that point at it", /range t\["Field"\] \{ for _, r0 := range c\.S\.Select\(E_Value/.test(block) && /range t\["Page"\] \{ for _, r0 := range c\.S\.Select\(E_Value/.test(block), block);

// an invariant that reads past self's references would check every row on a write: an error, and no build
const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", ...args], { encoding: "utf8" });
const good = cli("check", dir, "--deep");
ok("a chain of references from self is no INVARIANT_SCANS", good.status === 0 && !/INVARIANT_SCANS/.test(good.stdout + good.stderr), good.stdout);
const bad = mkdtempSync(join(tmpdir(), "invariant-scans-"));
writeFileSync(join(bad, "app.crud"), SPEC.replace("invariant self.field.template.wiki == self.page.wiki", "invariant self.field.template.wiki == self.page.wiki\n  invariant not exists(Note where .body == self.text)"));
const scans = cli("check", bad, "--deep");
ok("a query in an entity invariant is INVARIANT_SCANS, an error", scans.status !== 0 && /error.*INVARIANT_SCANS|INVARIANT_SCANS.*error/i.test(scans.stdout + scans.stderr) && /every Value after any write to Note/.test(scans.stdout + scans.stderr), scans.stdout + scans.stderr);
const built = cli("build", bad, "--out", join(bad, "out"));
ok("and it isn't built", built.status !== 0 && /INVARIANT_SCANS/.test(built.stdout + built.stderr), (built.stdout + built.stderr).slice(0, 400));

// and the compiled app still refuses what breaks it, at each step of the chain
const app = await startApp(join(dir, "app.crud"), 14081);
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  const ref = (e: string, id: number) => ({ ref: e, id });
  await app.post("/_test/load", { clock: 1000, rows: {
    Wiki: [row(1, { name: "a" }), row(2, { name: "b" })],
    Template: [row(1, { wiki: ref("Wiki", 1), name: "t" }), row(2, { wiki: ref("Wiki", 2), name: "u" })],
    Field: [row(1, { template: ref("Template", 1), name: "f" })],
    Page: [row(1, { wiki: ref("Wiki", 1), title: "p" })],
    Value: [row(1, { page: ref("Page", 1), field: ref("Field", 1), text: "v" })],
  } });
  const call = async (action: string, args: Record<string, string>) =>
    (await fetch(`${app.base}/_do/${action}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(args), redirect: "manual" })).headers.get("X-Crudspec-Outcome");
  const o1 = await call("move_template", { t: "1", w: "2" }); ok("moving the template to another wiki is refused (two steps back)", o1 === "invalid", o1);
  ok("moving the field to the other wiki's template is refused (one step back)", await call("move_field", { f: "1", t: "2" }) === "invalid");
  ok("moving the page is refused", await call("move_page", { p: "1", w: "2" }) === "invalid");
  ok("moving a template no field uses is fine", await call("move_template", { t: "2", w: "1" }) === "ok");
  ok("a change the invariant doesn't read is fine", await call("retitle", { p: "1", title: "q" }) === "ok" && await call("note", { body: "n" }) === "ok");
  ok("then moving the field to that template is fine", await call("move_field", { f: "1", t: "2" }) === "ok");
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
