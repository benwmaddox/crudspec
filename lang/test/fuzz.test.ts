// Random token edits to the sample apps (a token deleted, doubled, or replaced by another), each
// parsed and checked as check --deep does: an edit may be an error, never a crash. (The edits that
// pass every check also compile: lang/gogen/gen.ts on each, here.)
//   node lang/test/fuzz.test.ts
process.removeAllListeners("warning");
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, SpecError } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { deepCheck } from "../deep.ts";
import { withGenerated } from "../scaffold.ts";
import { readSpec } from "../source.ts";
import { generate } from "../gogen/gen.ts";

const { tokens } = createRequire(import.meta.url)("../../editors/vscode/highlight.js");
let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2)); } };
const dir = mkdtempSync(join(tmpdir(), "fuzz-"));
for (const [app, n, start] of [["apps/tasks", 500, 11], ["apps/todomvc", 300, 13], ["app3", 300, 17]] as const) {
  let seed: number = start;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const src = readSpec(app), toks = tokens(src);
  const crashes: string[] = [];
  let compiled = 0;
  for (let i = 0; i < n; i++) {
    const t = toks[Math.floor(rand() * toks.length)], u = toks[Math.floor(rand() * toks.length)], op = Math.floor(rand() * 3);
    const s = op === 0 ? src.slice(0, t.start) + src.slice(t.end) : op === 1 ? src.slice(0, t.end) + " " + src.slice(t.start, t.end) + src.slice(t.end) : src.slice(0, t.start) + src.slice(u.start, u.end) + src.slice(t.end);
    try {
      const sp = parse(s);
      if (check(sp, { source: s }).some((f) => f.severity === "error")) continue;
      const ty = typecheck(withGenerated(parse(s), parse)); deepCheck(sp);
      if (!ty.findings.some((f) => f.severity === "error")) { writeFileSync(join(dir, "app.crud"), s); generate(join(dir, "app.crud")); compiled++; }
    } catch (e) {
      if (!(e instanceof SpecError)) crashes.push(`line ${src.slice(0, t.start).split("\n").length}: ${String((e as Error).stack ?? e).split("\n").slice(0, 2).join(" | ")}`);
    }
  }
  ok(`${app}: ${n} edits (${compiled} compiled), no crash`, crashes.length === 0, crashes.slice(0, 5));
}
process.exit(failed ? 1 : 0);
