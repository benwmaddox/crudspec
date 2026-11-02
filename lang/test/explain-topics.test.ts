// `explain statements | expressions | elements | outcomes` (lang/topics.ts): every example parses and the spec around it checks clean;
// the outcome statuses are the runtime's; the command lists and prints the topics.
//   node lang/test/explain-topics.test.ts
process.removeAllListeners("warning");
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { STATEMENTS, EXPRESSIONS, OUTCOMES, TOPICS, wrap, explainElements } from "../topics.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)); } };

for (const [topic, items] of [["statements", STATEMENTS], ["expressions", EXPRESSIONS]] as const) {
  for (const it of items) {
    if (!it.example) continue;
    let verdict = "";
    try { const f = check(parse(wrap(topic, it))).filter((x) => x.severity === "error"); if (f.length) verdict = f.map((x) => `${x.code}: ${x.message}`).join("; "); }
    catch (e: any) { verdict = `${e.code ?? ""} ${e.message}`; }
    ok(`${topic}: ${it.head.slice(0, 40)}: its example checks clean`, verdict === "", verdict);
  }
}
// every statement the parser knows has a row
{
  const src = readFileSync(new URL("../parser.ts", import.meta.url), "utf8");
  const heads = STATEMENTS.map((s) => s.head.split(/[ <]/)[0]);
  for (const w of ["require", "reject", "rate_limit", "create", "ensure", "set", "touch", "delete", "for", "if", "match", "let", "result", "emit", "send"]) {
    ok(`statements: ${w} is covered (and the parser reads it)`, heads.includes(w) && src.includes(`"${w}"`), heads);
  }
}
// outcomes are the six the language has, with the statuses the runtime uses
{
  const rt = readFileSync(new URL("../gogen/rt/agents.go", import.meta.url), "utf8");
  const m = /var kindStatus = map\[string\]int\{([^}]*)\}/.exec(rt)?.[1] ?? "";
  const status: Record<string, number> = Object.fromEntries([...m.matchAll(/"(\w+)": (\d+)/g)].map((x) => [x[1], Number(x[2])]));
  for (const o of OUTCOMES) {
    const st = status[o.head];
    ok(`outcomes: ${o.head} says its status (${st})`, st === undefined || o.head === "ok" || o.text.includes(String(st)), [o.head, st, o.text]);
  }
  ok("outcomes: the six", OUTCOMES.map((o) => o.head).sort().join() === ["blocked", "forbidden", "invalid", "not_found", "ok", "unauthenticated"].join());
}
ok("elements: built from the standard library", ["<Form>", "<List>", "<Link>", "<Slot>"].every((t) => explainElements().includes(t)) && !explainElements().includes("<Row>"));
// the command
const cli = (...a: string[]) => spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "explain", ...a], { encoding: "utf8" });
for (const t of TOPICS) ok(`explain ${t.name} prints the topic`, cli(t.name).status === 0 && cli(t.name).stdout.startsWith(t.name), cli(t.name).stderr);
ok("explain elements prints the elements", cli("elements").status === 0 && cli("elements").stdout.includes("<Form>"));
ok("bare explain lists the topics too", ["statements", "expressions", "elements", "outcomes"].every((n) => new RegExp("^  " + n + " ", "m").test(cli().stdout)), cli().stdout.slice(0, 200));
ok("a near miss is suggested", /did you mean statements/.test(cli("statments").stderr), cli("statments").stderr);
process.exit(failed ? 1 : 0);
