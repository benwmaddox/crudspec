// The standard library: its native elements (lang/std/ui.crud) every app has, and its
// components (lang/std/components.crud), which join an app, and are compiled, only when its UI
// uses them, directly or through another of its components.
//   node lang/test/std.test.ts
process.removeAllListeners("warning");
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, STD_COMPONENTS, SpecError } from "../parser.ts";
import { check } from "../check.ts";
import { generate } from "../gogen/gen.ts";

let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(typeof info === "string" ? info : JSON.stringify(info, null, 2)); } };
const base = `app t { name "T"  actor User }
entity User { name: Text }
entity Session { user: User  token: Text }
identity session: Session.token from cookie "s"
permission read User: true
layout l { <Main><Slot name=main /></Main> }
`;
const screen = (body: string) => `${base}screen s { route "/"  layout l <Main>${body}</Main> }\n`;
const dir = mkdtempSync(join(tmpdir(), "std-test-"));
let n = 0;
const go = (src: string) => { const d = join(dir, `a${n++}`); mkdirSync(d); writeFileSync(join(d, "app.crud"), src); return Object.values(generate(join(d, "app.crud"))).join("\n"); };

ok("the standard library has Separator", STD_COMPONENTS.has("Separator"));
const without = parse(screen(`<p>x</p>`)), withIt = parse(screen(`<p>x</p><Separator />`));
ok("an app that doesn't use a std component doesn't have it", !without.decls.some((d) => d.name === "Separator"));
ok("one that does has it, as a component of its own", withIt.decls.some((d) => d.kind === "component" && d.name === "Separator" && d.std));
ok("... and it checks", !check(withIt).some((f) => f.severity === "error"), check(withIt).filter((f) => f.severity === "error"));
const usedThrough = parse(`${base}component Bar() { <Separator /> }\nscreen s { route "/"  layout l <Main><Bar /></Main> }\n`);
ok("reached through the app's own component: there too", usedThrough.decls.some((d) => d.name === "Separator"));
ok("only what's used is compiled", !/UI_Separator\b/.test(go(screen(`<p>x</p>`))) && /UI_Separator\b/.test(go(screen(`<Separator />`))));
let clash = "";
try { parse(`${base}component Separator() { <hr> }\n`); } catch (e) { clash = (e as SpecError).code; }
ok("an app's component can't take a std component's name", clash === "UI_TAG_CLASH", clash);

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
