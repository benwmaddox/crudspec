// check and the compiler agree: each ambient name, builtin and kind of value, in each place an
// expression goes (an action, a view, a function, a predicate, a permission, a display, a trigger,
// a workflow step, an API route, a screen), is either an error to check or compiles. One that
// passes check and stops the compiler is a rule check is missing (query, back and home in an
// action were found so).
//   node lang/test/agree.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, SpecError } from "../parser.ts";
import { check, BUILTINS } from "../check.ts";
import { typecheck } from "../types.ts";
import { withGenerated } from "../scaffold.ts";
import { generate } from "../gogen/gen.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2)); } };
const dir = mkdtempSync(join(tmpdir(), "agree-"));
const head = `app d { name "D"  actor User }\nentity User { name: Text }\nentity Note { title: Text  owner: User }\npolicy note_rows: true for rows of Note\nlayout l { <Main><Slot name=main /></Main> }\n`;
const exprs = ["actor", "request", "request.ip", "query", "query.x", "client", "app", "theme", "result", "back", "home", "input", "typed", "now", "none", "true", "1", '"x"', "Note", "User", "it", ".title",
  ...Object.entries(BUILTINS).map(([n, [lo]]) => `${n}(${Array(lo).fill('"x"').join(", ")})`)];
const places: Record<string, (e: string) => string> = {
  action: (e) => `action a() { let v = ${e}  create Note { title: text(v), owner: actor } }\n`,
  view: (e) => `view v() { rows Note where .title == text(${e}) }\n`,
  fn: (e) => `fn f(): Text = text(${e})\nview v() { rows Note where .title == f() }\n`,
  predicate: (e) => `fn p(n: Note): Bool = n.title == text(${e})\nview v() { rows Note where p(it) }\n`,
  permission: (e) => `entity Tag { name: Text }\npolicy tag_rows: tag.name == text(${e}) for rows of Tag\nview v() { rows Tag }\n`,
  display: (e) => `show Note { label: text(${e}) }\n`,
  trigger: (e) => `trigger on create Note as n { set n.title = text(${e}) }\naction a() { create Note { title: "x", owner: actor } }\n`,
  workflow: (e) => `action a() { create Note { title: "x", owner: actor } as n  emit Made(n) }\nworkflow on Made(n) { step s: set n.title = text(${e}) }\n`,
  api: (e) => `identity key: User from param key as "{id}"\naction add(t: Text) { create Note { title: t, owner: actor } }\napi x {\n  route "/api/:key"\n  identity key\n  post "" -> add(t: text(${e}))\n}\n`,
  screen: (e) => `screen s {\n  route "/"\n  layout l\n  <Main><Text>{text(${e})}</Text></Main>\n}\n`,
};
const disagree: string[] = [], clean: Record<string, number> = {};
for (const [place, mk] of Object.entries(places)) for (const e of exprs) {
  const src = head + mk(e);
  let errors: string[];
  try {
    errors = check(parse(src), { source: src }).filter((f) => f.severity === "error").map((f) => f.code);
    if (!errors.length) errors = typecheck(withGenerated(parse(src), parse)).findings.filter((f) => f.severity === "error").map((f) => f.code);
  } catch (err) { if (err instanceof SpecError) continue; throw err; }
  if (errors.length) continue;
  clean[place] = (clean[place] ?? 0) + 1;
  writeFileSync(join(dir, "app.crud"), src);
  try { generate(join(dir, "app.crud")); } catch (err) { disagree.push(`${place}: ${e}: ${String((err as Error).message).split("\n")[0]}`); }
}
ok("each place takes most of them (the test isn't empty)", Object.keys(places).every((p) => (clean[p] ?? 0) > 40), clean);
ok("what passes check compiles, in every place", disagree.length === 0, disagree);

// the same for statements, in each kind of body, and for each built-in element, bare and with content
const compiles = (src: string, what: string, into: string[]) => {
  try {
    if (check(parse(src), { source: src }).some((f) => f.severity === "error")) return false;
    if (typecheck(withGenerated(parse(src), parse)).findings.some((f) => f.severity === "error")) return false;
  } catch (err) { if (err instanceof SpecError) return false; throw err; }
  writeFileSync(join(dir, "app.crud"), src);
  try { generate(join(dir, "app.crud")); } catch (err) { into.push(`${what}: ${String((err as Error).message).split("\n")[0]}`); }
  return true;
};
const sHead = head + `extern fn opengraph(url: Url): OpenGraph? effect fetch\nscreen home {\n  route "/"\n  layout l\n  <Main><p>x</p></Main>\n}\nworkflow on Poked(p) { step w: set p.title = "w" }\n`;
const stmts = [`create Note { title: "x", owner: actor }`, `ensure Note { title: "x", owner: actor }`, `set n.title = "y"`, `delete n`, `delete Note where .title == "x"`, `touch n`,
  `require n.title != "" else invalid`, `reject invalid "no"`, `rate_limit 3 per 1 min by actor else blocked`, `let k = n.title`, `for each m in Note where .owner == n.owner { set m.title = "z" }`,
  `if n.title == "x" { set n.title = "y" }`, `emit Poked(n)`, `result n`, `send mail { to: "a@b.c", subject: "s", body: "b" }`, `let r = call opengraph("https://x")`];
const bodies: Record<string, (s: string) => string> = {
  action: (s) => `action a(n: Note) {\n  ${s}\n}\n`,
  trigger: (s) => `trigger on create Note as n { ${s} }\naction a() { create Note { title: "q", owner: actor } }\n`,
  migration: (s) => `migration "m" { for each n in Note where true { ${s} } }\n`,
  schedule: (s) => `schedule sweep { every 15 min  for each n in Note where true { ${s} } }\n`,
};
const sBad: string[] = []; let sClean = 0;
for (const [b, mk] of Object.entries(bodies)) for (const st of stmts) if (compiles(sHead + mk(st), `${b}: ${st}`, sBad)) sClean++;
ok(`statements: what passes check compiles (${sClean} passed check)`, sClean > 40 && sBad.length === 0, sBad);
const { ELEMENTS, TAG_OF } = await import("../parser.ts");
const eBad: string[] = []; let eClean = 0;
for (const t of Object.keys(ELEMENTS).map((k) => TAG_OF[k]).filter(Boolean)) for (const m of [`<${t} />`, `<${t}>x</${t}>`, `<${t}>{actor.name}</${t}>`, `<${t}>{actor}</${t}>`])
  if (compiles(head + `view notes() { rows Note }\naction go() { }\nscreen s {\n  route "/"\n  layout l\n  <Main><Button action={go()} label="g" />${m}</Main>\n}\n`, m, eBad)) eClean++;
ok(`elements: what passes check compiles (${eClean} passed check)`, eClean > 40 && eBad.length === 0, eBad);
process.exit(failed ? 1 : 0);
