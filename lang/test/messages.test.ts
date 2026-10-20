// What a person reads when a spec is wrong: a misspelled name gets "did you mean", a finding
// knows its column, and the CLI shows the line with a caret under it.
//   node lang/test/messages.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse, SpecError } from "../parser.ts";
import { check } from "../check.ts";
import { closest } from "../didyoumean.ts";

let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(typeof info === "string" ? info : JSON.stringify(info, null, 2)); } };

ok("closest: a slip finds its name", closest("colour", ["color", "title"]) === "color" && closest("actr", ["actor", "action"]) === "actor" && closest("tilte", ["title"]) === "title");
ok("closest: nothing close is no suggestion", closest("scren", ["s"]) === undefined && closest("zebra", ["color", "title"]) === undefined);

const base = `app d { name "D"  actor User }
entity User { name: Text }
entity Note { title: Text  color: Text?  owner: User }
permission read Note: true
layout l { <Main><Slot name=main /></Main> }
`;
const find = (src: string, code: string) => check(parse(base + src)).find((f) => f.code === code);
const f1 = find(`action add(t: Text) { create Note { title: t, colour: "red", owner: actor } }\n`, "UNKNOWN_FIELD");
ok("a field that isn't: did you mean, at the field", !!f1 && f1.message.endsWith("did you mean color?") && f1.line === 6 && f1.col === 47, f1);
const f2 = find(`action add(t: Text) { create Note { title: t, owner: actr } }\n`, "UNKNOWN_NAME");
ok("a name that isn't: did you mean, at the name", !!f2 && f2.message.endsWith("did you mean actor?") && f2.col === 54, f2);
const f3 = find(`view mine() { rows Notes where .owner == actor }\n`, "UNKNOWN_ENTITY");
ok("an entity that isn't: did you mean", !!f3 && f3.message.endsWith("did you mean Note?"), f3);
const f4 = find(`screen s {\n  route "/"\n  layout l\n  <Main><Text>{actor.nmae}</Text></Main>\n}\n`, "UNKNOWN_FIELD");
ok("a field read in a screen: did you mean", !!f4 && f4.message.endsWith("did you mean name?"), f4);

const parseErr = (src: string) => { try { parse(base + src); return null; } catch (e) { return e as SpecError; } };
const e1 = parseErr(`screen s {\n  route "/"\n  layout l\n  <Main><Heding>x</Heding></Main>\n}\n`);
ok("an element that isn't: did you mean, without the whole list", !!e1 && e1.message.endsWith("did you mean Heading?"), e1?.message);
const e2 = parseErr(`screen s {\n  route "/"\n  layout l\n  <Main><Heading clas="x">x</Heading></Main>\n}\n`);
ok("an attribute that isn't: did you mean", !!e2 && e2.message.endsWith("did you mean class?"), e2?.message);
const e3 = parseErr(`action a(t: Text) { require t != "" else forbiden }\n`);
ok("an outcome that isn't: did you mean", !!e3 && e3.message.endsWith("did you mean forbidden?"), e3?.message);

// a type that isn't: a slip suggests the type meant; an extern's result names a Go shape, so any goes
const types = check(parse(base + `entity Tag { name: Txt  note: Not? }\nview v(q: Bol) { rows Note }\nextern fn fetch_it(u: Url): Reply effect http\n`)).filter((f) => f.code === "UNKNOWN_TYPE");
ok("unknown types: each, at the type, with did you mean", types.length === 3 && types[0].message.endsWith("did you mean Text?") && types[0].line === 6 && types[0].col === 20 && types[1].message.endsWith("did you mean Note?") && types[2].message.endsWith("did you mean Bool?"), types);

// the CLI: the line, and a caret under the column
const dir = mkdtempSync(join(tmpdir(), "messages-"));
writeFileSync(join(dir, "app.crud"), base + `action add(t: Text) { create Note { title: t, colour: "red", owner: actor } }\n`);
const r = spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "check", dir], { encoding: "utf8" });
const lines = r.stdout.split("\n");
const at = lines.findIndex((l) => l.startsWith("error UNKNOWN_FIELD"));
ok("check prints the line, and a caret under the field", at >= 0 && lines[at + 1] === ` 6 | action add(t: Text) { create Note { title: t, colour: "red", owner: actor } }` && lines[at + 2] === `   | ${" ".repeat(46)}^`, lines.slice(at, at + 3));
const quiet = spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "check", dir], { encoding: "utf8", env: { ...process.env, NO_SNIPPET: "1" } });
ok("NO_SNIPPET=1: the findings alone", !quiet.stdout.includes(" | "), quiet.stdout);

// --json, for editors: each finding's file and its line there, in a many-file app too
const two = mkdtempSync(join(tmpdir(), "messages-"));
writeFileSync(join(two, "a.crud"), base);
writeFileSync(join(two, "b.crud"), `\naction add(t: Text) { create Note { title: t, colour: "red", owner: actor } }\n`);
const j = JSON.parse(spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "check", two, "--json"], { encoding: "utf8" }).stdout);
const jf = j.findings.find((f: any) => f.code === "UNKNOWN_FIELD");
ok("--json: a finding's file, and its line in it", !!jf && jf.file.endsWith("b.crud") && jf.fileLine === 2 && jf.col === 47, j);
writeFileSync(join(two, "b.crud"), `\nscreen s {\n  route "/"\n  <Main></Main>\n}\n`);
const pj = JSON.parse(spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "check", two, "--json"], { encoding: "utf8" }).stdout);
const pf = pj.findings[0];
ok("--json: a parse error has its code and place", pf.code === "PARSE_SCREEN" && pf.file.endsWith("b.crud") && pf.fileLine === 4 && pf.col === 3 && !/^\d/.test(pf.message), pf);

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
