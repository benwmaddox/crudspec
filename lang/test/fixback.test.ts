// Each misspelling (an attribute, a keyword) in the sample apps, then the fix its error names, as
// check --fix makes it: the spec is back as it was, for every attribute and nearly every keyword.
//   node lang/test/fixback.test.ts
import { readFileSync } from "node:fs";
import { parse, SpecError } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { withGenerated } from "../scaffold.ts";
import { readSpec } from "../source.ts";
import { createRequire } from "node:module";
const { tokens } = createRequire(import.meta.url)("../../editors/vscode/highlight.js");
let failed = 0;
for (const app of ["apps/tasks", "app3", "apps/todomvc"]) {
const src = readSpec(app);
// the findings with a place, as check --deep reports them
const findings = (s) => {
  try { const sp = parse(s); const f = check(sp, { source: s }); return f.some((x) => x.severity === "error") ? f : [...f, ...typecheck(withGenerated(parse(s), parse)).findings]; }
  catch (e) { if (e instanceof SpecError) return [e, ...(e.more ?? [])].map((x) => ({ severity: "error", message: x.message, line: x.pos.line, col: x.pos.col })); throw e; }
};
// the fix a finding names, applied to the source (as cli.ts placed() and applyFixes do)
const fixOf = (s, f) => {
  const m = /did you mean \{?([A-Za-z_]\w*)(?: …\})?\?/.exec(f.message ?? ""); if (!m || !f.col) return null;
  const lines = s.split("\n"), text = lines[f.line - 1] ?? "", word = /^[<.]?[A-Za-z_][\w-]*/.exec(text.slice(f.col - 1))?.[0];
  if (!word) return null;
  const lead = /^[<.]/.test(word) ? 1 : 0;
  lines[f.line - 1] = text.slice(0, f.col - 1 + lead) + m[1] + text.slice(f.col - 1 + word.length);
  return lines.join("\n");
};
const kinds = { attr: [], keyword: [] };
for (const t of tokens(src)) if (t.kind === "attr" || t.kind === "kw" || t.kind === "ctl") (t.kind === "attr" ? kinds.attr : kinds.keyword).push(t);
for (const [kind, ts] of Object.entries(kinds)) {
  let back = 0, n = 0;
  for (const t of ts) {
    const s = src.slice(0, t.end) + "q" + src.slice(t.end);
    const fs = findings(s).filter((f) => f.severity === "error" && f.line === src.slice(0, t.start).split("\n").length);
    n++;
    for (const f of fs) { const fixed = fixOf(s, f); if (fixed === src) { back++; break; } }
  }
  const pass = kind === "attr" ? back === n : back >= n * 0.95;
  if (!pass) failed++;
  console.log(`${pass ? "ok  " : "FAIL"} ${app} ${kind}: ${back} of ${n} misspellings put back exactly by the fix their error names`);
}
}
process.exit(failed ? 1 : 0);
