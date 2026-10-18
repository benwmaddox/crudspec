// Go bindings: an extern declared `= go "pkg".Func` or `= go Func` (the app's ext.go) calls that Go
// function; the checker refuses types a binding can't carry, and the compiled app checks each
// signature when it starts.
//   node lang/test/gobind.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { compiledApp } from "../gogen/program.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail) console.log(String(detail).slice(0, 600)); } };
const errors = (src: string) => check(parse(src)).filter((f) => f.severity === "error");
const BASE = `
app t { name "T" actor User }
entity User { name: Text  token: Text? }
entity Note { title: Text  count: Int? }
identity login: User.token from cookie "login"
`;
const SPEC = BASE + `
extern fn shout(t: Text): Text effect pure = go "strings".ToUpper
extern fn repeat(t: Text, n: Int): Text effect pure = go "strings".Repeat
extern fn parse_int(t: Text): Int? effect pure = go "strconv".Atoi
extern fn slug(t: Text): Text effect pure = go Slug
extern fn notify(to: Email, body: Text): Text? effect mail = go Notify
action add(title: Text) { create Note { title: call shout(title), count: call parse_int(title) } }
action twice(title: Text) { create Note { title: call slug(call repeat(title, 2)) } }
// each answers ok when the binding gives what's expected, invalid when not
action is_shout(t: Text, want: Text) { require call shout(t) == want else invalid }
action is_int(t: Text, want: Int) { require call parse_int(t) == want else invalid }
action no_int(t: Text) { require call parse_int(t) == none else invalid }
action is_slug(t: Text, want: Text) { require call slug(call repeat(t, 2)) == want else invalid }
`;
const EXT = `package main

import "strings"

// Slug and Notify are the app's own Go functions the spec binds to.
func Slug(s string) string { return strings.ReplaceAll(strings.ToLower(s), " ", "-") }
func Notify(to string, body string) error { return nil }
`;

ok("bindings parse: package, function, effect", (() => { const d: any = parse(SPEC).decls.find((d: any) => d.name === "repeat"); return d.go.pkg === "strings" && d.go.fn === "Repeat" && d.effect === "pure"; })());
ok("an app function binds with no package", (parse(SPEC).decls.find((d: any) => d.name === "slug") as any).go.pkg === undefined);
ok("the spec checks; a pure extern may be called in an action", !errors(SPEC).length, JSON.stringify(errors(SPEC)));
ok("an effect extern still may not be called in an action", errors(BASE + `extern fn notify(to: Email, b: Text): Text? effect mail = go Notify\naction a() { let x = call notify("a@b.c", "hi") }`).some((f) => f.code === "EXTERN_OUTSIDE_WORKFLOW"));
const typeErr = errors(BASE + `extern fn f(n: Note): Text effect pure = go F`);
ok("a type a binding can't carry is refused, listing the ones it can", typeErr.some((f) => f.code === "GO_TYPE" && f.message.includes("Text, Email, Url, Int, Bool, Time, Duration")), JSON.stringify(typeErr));
ok("a module outside the standard library needs a pinned import", errors(BASE + `extern fn f(t: Text): Text effect pure = go "github.com/x/y".F`).some((f) => f.code === "GO_IMPORT"));
ok("an import covers its module's packages", !errors(BASE + `import go "github.com/x/y@v1.2.3"\nextern fn f(t: Text): Text effect pure = go "github.com/x/y/z".F`).some((f) => f.code === "GO_IMPORT"));
let unpinned = "";
try { parse(BASE + `import go "github.com/x/y"`); } catch (e) { unpinned = (e as Error).message; }
ok("an import without a version is refused", unpinned.includes("needs a version"), unpinned);

// the compiled app: the bindings run in actions
const dir = mkdtempSync(join(tmpdir(), "gobind-"));
writeFileSync(join(dir, "app.crud"), SPEC);
writeFileSync(join(dir, "ext.go"), EXT);
const CALLS: [string, any][] = [["is_shout", { t: "hi", want: "HI" }], ["no_int", { t: "x" }], ["is_int", { t: "42", want: 42 }], ["is_slug", { t: "A b ", want: "a-b-a-b-" }],
  ["is_shout", { t: "hi", want: "hi" }], ["add", { title: "7" }], ["twice", { title: "x" }]];
let ran: any[] = [];
try {
  const out = compiledApp(join(dir, "app.crud")).run(["probe"], JSON.stringify({ states: [{ clock: 1000, seq: 1, rows: {}, defaults: [] }],
    calls: CALLS.map(([name, args]) => ({ state: 0, name, args, actor: null, request: { ip: "", method: "write", identity: "" }, skips: [], changes: true })), reads: [] }));
  ran = JSON.parse(out.stdout).calls;
} catch (e) { ok("the app builds and probes", false, e); }
const outcome = (i: number) => ran[i]?.outcome;
ok("a standard-library function runs in an action", outcome(0) === "ok" && outcome(4) === "invalid", JSON.stringify(ran));
ok("a (value, error) function gives none when it fails", outcome(1) === "ok");
ok("and the value when it works", outcome(2) === "ok");
ok("an app function runs, nested in another call", outcome(3) === "ok");
ok("bindings work in creates", outcome(5) === "ok" && outcome(6) === "ok");

// a signature that doesn't match stops the program at start, naming the spec line
const bad = mkdtempSync(join(tmpdir(), "gobind-bad-"));
writeFileSync(join(bad, "app.crud"), BASE + `extern fn shout(t: Int): Text effect pure = go "strings".ToUpper\naction add(n: Int) { create Note { title: call shout(n) } }\n`);
const r = compiledApp(join(bad, "app.crud")).run(["probe"], "{}");
ok("a mismatched binding stops the app at start, with the spec line", r.status !== 0 && /app\.crud:\d+: extern shout: parameter 1 is Int in the spec but string in Go/.test(r.stderr), r.stderr);
process.exit(failed ? 1 : 0);
