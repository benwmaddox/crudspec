// `cli explain` and the table behind it (lang/shapes.ts) are held to the parser: every example checks
// clean, every part the table calls required is refused when left out, every optional part the table
// shows is accepted, and every kind of declaration the parser knows has an entry. Also the three
// rules the table states: an app takes only the settings it lists, a view says what it returns, a
// screen says its address.
//   node lang/test/explain.test.ts
process.removeAllListeners("warning");
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "../parser.ts";
import { readSpec } from "../source.ts";
import { check } from "../check.ts";
import { APP_SETTINGS, EXAMPLE_BASE, SHAPES, explain } from "../shapes.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(typeof detail === "string" ? detail.slice(0, 500) : JSON.stringify(detail)); } };

// what the language says of a declaration: its first parse error, or its check errors
const verdict = (src: string): { parse?: string; errors: string[] } => {
  try { return { errors: check(parse(EXAMPLE_BASE + src)).filter((f) => f.severity === "error").map((f) => `${f.code}: ${f.message}`) }; }
  catch (e) { return { parse: `${(e as any).code}: ${(e as Error).message}`, errors: [] }; }
};
const clean = (v: ReturnType<typeof verdict>) => !v.parse && v.errors.length === 0;

// ---- every example is a valid declaration
for (const s of SHAPES) { const v = verdict(s.example); ok(`${s.kind}: its example checks clean`, clean(v), v); }

// ---- a required part left out is refused (with the error the table names), an optional part shown is accepted
for (const s of SHAPES) for (const part of s.parts) {
  if (part.need === "required" && part.without !== undefined) {
    const v = verdict(part.without), said = v.parse ?? v.errors.join(" ");
    ok(`${s.kind}: ${part.name} is required: left out, the declaration is refused${part.refusal ? ` (${part.refusal})` : ""}`, !clean(v) && (!part.refusal || said.includes(part.refusal)), v);
  }
  if (part.accepts !== undefined) { const v = verdict(part.accepts); ok(`${s.kind}: ${part.name} is optional: written in, it is accepted`, clean(v), v); }
}
ok("every part the table calls required has a test that it is refused (else the table could lie)", SHAPES.every((s) => s.parts.every((p) => p.need !== "required" || p.without !== undefined)), SHAPES.flatMap((s) => s.parts.filter((p) => p.need === "required" && p.without === undefined).map((p) => `${s.kind}.${p.name}`)));

// ---- every kind of declaration the parser starts one with is in the table
{
  const src = readFileSync(new URL("../parser.ts", import.meta.url), "utf8");
  const words = [...(/const DECL_WORDS = new Set\(\[([^\]]*)\]/.exec(src)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  // covered by another entry: singleton and data by entity, internal by action, avatar by display, drop and native are not for an app to explain
  const covered = new Set([...SHAPES.map((s) => s.kind), "display", "permission", "singleton", "data", "internal", "avatar", "drop", "native", "predicate", "gate"]);
  ok("every declaration the parser knows has an entry (or is another's form)", words.length > 20 && words.every((w) => covered.has(w)), words.filter((w) => !covered.has(w)));
  ok("... and every entry is a declaration the parser knows", SHAPES.every((s) => words.includes(s.kind)), SHAPES.filter((s) => !words.includes(s.kind)).map((s) => s.kind));
}

// ---- what the table says of an app
{
  const typo = verdict(`app shop { name "Shop"  actr User }`);
  ok("an app setting that isn't one is refused, with the nearest", typo.errors.some((e) => e.startsWith("APP_SETTING_UNKNOWN") && e.includes("actr") && e.includes("did you mean actor")), typo);
  ok("... any other word too, and the settings are listed", verdict(`app shop { colour "red" }`).errors.some((e) => e.startsWith("APP_SETTING_UNKNOWN") && APP_SETTINGS.every((k) => e.includes(k))));
  ok("each setting the table lists is accepted", APP_SETTINGS.every((k) => !verdict(`app shop { ${k === "indexes" ? "indexes auto" : k === "actor" ? "actor User" : k === "setup_when" ? "setup_when true" : k === "admin" ? "actor User\n admin true" : k === "sign_in_screen" || k === "setup_screen" ? "" : `${k} "x"`} }`).errors.some((e) => e.startsWith("APP_SETTING_UNKNOWN"))));
  ok("every app in the repo uses only those settings", ["apps/campfire", "apps/tasks", "apps/todomvc", "app3"].every((d) => parse(readSpec(d)).decls.filter((x) => x.kind === "app").every((a) => Object.keys(a.props).every((k) => APP_SETTINGS.includes(k)))));
}

// ---- a view says what it returns, a screen its address
ok("a view with neither rows nor a value is refused at parse (it used to crash the type pass)", /PARSE_VIEW.*needs the rows it returns/.test(verdict(`view v() { updates live }`).parse ?? ""));
ok("... with both is refused too", /PARSE_VIEW.*both/.test(verdict(`view v() { rows Note where true  value 1 }`).parse ?? ""));
ok("a screen with no route is refused, naming the screen", /PARSE_SCREEN.*screen s needs its address/.test(verdict(`screen s { layout l  access public  <Main><h1>x</h1></Main> }`).parse ?? ""));

// ---- the command
const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "explain", ...args], { encoding: "utf8" });
{
  const list = cli();
  ok("`explain` lists every kind, one a line", list.status === 0 && SHAPES.every((s) => new RegExp(`^  ${s.kind}\\s`, "m").test(list.stdout)), list.stdout.slice(0, 300));
  const one = cli("view");
  ok("`explain view` shows the form, each part, which are required, and an example", one.status === 0 && /view <name>\(params\)/.test(one.stdout) && /rows or value.*REQUIRED/.test(one.stdout) && /updates.*optional/.test(one.stdout) && /example:/.test(one.stdout), one.stdout);
  ok("`explain screen` says route and layout are required", /layout .*REQUIRED/.test(cli("screen").stdout) && /route .*REQUIRED/.test(cli("screen").stdout));
  const bad = cli("vew");
  ok("an unknown kind exits 1 and names the nearest", bad.status === 1 && /did you mean view/.test(bad.stderr), bad.stderr);
  ok("`explain all` has every kind", SHAPES.every((s) => cli("all").stdout.includes(s.syntax)));
  ok("`--json` is the table as data", (() => { try { return JSON.parse(cli("view", "--json").stdout).kind === "view" && Array.isArray(JSON.parse(cli("--json").stdout)); } catch { return false; } })());
  ok("explain() is what the command prints", cli("action").stdout.trim() === explain(SHAPES.find((s) => s.kind === "action")!).trim());
}
process.exit(failed ? 1 : 0);
