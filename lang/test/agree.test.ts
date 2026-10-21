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
const head = `app d { name "D"  actor User }\nentity User { name: Text }\nentity Note { title: Text  owner: User }\npermission read Note: true\nlayout l { <Main><Slot name=main /></Main> }\n`;
const exprs = ["actor", "request", "request.ip", "query", "query.x", "client", "app", "theme", "result", "back", "home", "input", "typed", "now", "none", "true", "1", '"x"', "Note", "User", "it", ".title",
  ...Object.entries(BUILTINS).map(([n, [lo]]) => `${n}(${Array(lo).fill('"x"').join(", ")})`)];
const places: Record<string, (e: string) => string> = {
  action: (e) => `action a() { let v = ${e}  create Note { title: text(v), owner: actor } }\n`,
  view: (e) => `view v() { rows Note where .title == text(${e}) }\n`,
  fn: (e) => `fn f(): Text = text(${e})\nview v() { rows Note where .title == f() }\n`,
  predicate: (e) => `predicate p(n: Note) = n.title == text(${e})\nview v() { rows Note where p(it) }\n`,
  permission: (e) => `entity Tag { name: Text }\npermission read Tag: tag.name == text(${e})\nview v() { rows Tag }\n`,
  display: (e) => `display Note: text(${e})\n`,
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
process.exit(failed ? 1 : 0);
