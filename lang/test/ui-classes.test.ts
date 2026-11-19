// Class names: a list (class={["todo", when(done, "completed")]}, joined, the empty ones left
// out), and the names a spec writes checked against the app's stylesheets (UI_CLASS_UNKNOWN, a
// warning: a typo, or a rule missing), when every stylesheet is beside the spec in assets/.
//   node lang/test/ui-classes.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check, cssClasses } from "../check.ts";
import { typecheck } from "../types.ts";
import { withGenerated } from "../scaffold.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const CSS = `/* the app's look */\n.todo { color: red }\n.todo.completed, .selected:hover { x: y }\n.btn-primary { background: url(logo.png) }\n@media (min-width: 0.5em) { .wide { } }\n`;
const SPEC = `app t { name "T" actor User }
entity User { name: Text  token: Text?  unique (token) }
identity v: User.token from cookie "t"
policy pu: true for rows of User
entity Item { title: Text  done: Bool = false }
policy pi: true for rows of Item
theme t { stylesheets ["app.css"]  classes { button: "btn-primary" } }
layout l { <main><Slot name=main /></main> }
view items() { rows Item order by created }
screen home(pick: Item?) {
  route "/"
  layout l
  require public
  <Fill name=main>
    <List of={items()} as=i>
      <div class={["todo", when(i.done, "completed"), when(pick == i, "selected")]}>{i.title}</div>
    </List>
    <p class="todo wide">x</p>
  </Fill>
}
`;
const app = (spec: string, css: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), "classes-"));
  writeFileSync(join(dir, "app.crud"), spec);
  if (css !== null) { mkdirSync(join(dir, "assets")); writeFileSync(join(dir, "assets", "app.css"), css); }
  return dir;
};
const warnings = (dir: string, spec: string) => check(parse(spec), { dir }).filter((f: any) => f.code === "UI_CLASS_UNKNOWN");

ok("a stylesheet's classes: each .name, comments left out", (() => { const c = cssClasses(CSS); return ["todo", "completed", "selected", "btn-primary", "wide"].every((x) => c.has(x)) && !c.has("the") && !c.has("5em"); })(), [...cssClasses(CSS)]);
ok("every class written is in the stylesheet: no warnings", warnings(app(SPEC, CSS), SPEC).length === 0, warnings(app(SPEC, CSS), SPEC));
const typo = SPEC.replace(`when(pick == i, "selected")`, `when(pick == i, "seleted")`).replace(`class="todo wide"`, `class="todo wdie"`);
const w = warnings(app(typo, CSS), typo);
ok("a misspelled class, in a list's when or in text: UI_CLASS_UNKNOWN, with the one meant", w.length === 2 && w.some((f: any) => /class seleted isn't in the app's stylesheets \(app\.css\); did you mean selected\?/.test(f.message)) && w.some((f: any) => /wdie.*did you mean wide/.test(f.message)), w);
const themeTypo = SPEC.replace(`button: "btn-primary"`, `button: "btn-primray"`);
ok("a theme class no stylesheet has: UI_CLASS_UNKNOWN", warnings(app(themeTypo, CSS), themeTypo).some((f: any) => /the theme's button class btn-primray/.test(f.message)));
ok("a stylesheet that isn't beside the spec: nothing is said (it can't be read)", warnings(app(typo, null), typo).length === 0);
ok("a class from a function's result isn't checked (only what is written)", warnings(app(SPEC.replace(`class="todo wide"`, `class={upper("x")}`), CSS), SPEC.replace(`class="todo wide"`, `class={upper("x")}`)).length === 0);

const types = (spec: string) => typecheck(withGenerated(parse(spec), parse)).findings.filter((f: any) => f.severity === "error");
ok("when takes a Bool and text", types(SPEC.replace(`when(i.done, "completed")`, `when(i.title, "completed")`)).some((f: any) => /when\(\)'s first argument is a Bool/.test(f.message)));
ok("when gives Text? (none when false): + with it is an error, its text can't be none", types(SPEC.replace(`<p class="todo wide">x</p>`, `<p class={when(true, "a") + "b"}>x</p>`)).some((f: any) => f.code === "TYPE_MAYBE_NONE") && types(SPEC.replace(`when(i.done, "completed")`, `when(i.done, upper(i.title).default("x"))`)).length === 0 && types(SPEC.replace("entity Item { title: Text", "entity Item { note: Text?  title: Text").replace(`when(i.done, "completed")`, `when(i.done, i.note)`)).some((f: any) => /when\(\)'s text may be none/.test(f.message)));
ok("a class list holds class names", types(SPEC.replace(`when(i.done, "completed")`, `i.done`)).some((f: any) => /a class list holds class names/.test(f.message)));

// the page: the names joined, the empty ones left out
const dir = app(SPEC, CSS);
const a = await startApp(join(dir, "app.crud"), 14005, { assets: join(dir, "assets") });
try {
  const row = (id: number, f: any) => ({ id, seq: id, created: id, updated: 0, fields: f });
  await a.post("/_test/load", { clock: 0, rows: { Item: [row(1, { title: "one", done: false }), row(2, { title: "two", done: true })] } });
  const html = await (await fetch(`${a.base}/?pick=2`)).text();
  ok("the page: class=\"todo\" for one, class=\"todo completed selected\" for the picked done one", html.includes(`class="todo">one<`) && html.includes(`class="todo completed selected">two<`), html.slice(html.indexOf("<main"), html.indexOf("</main>")));
} finally { a.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
