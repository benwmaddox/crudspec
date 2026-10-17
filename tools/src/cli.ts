import { readFileSync } from "node:fs";
import { parse, SpecError } from "./parser.ts";
import { runAll, runOnly } from "./scenario.ts";
import { check } from "./check/index.ts";

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "parse") {
  try {
    const spec = parse(readFileSync(args[0], "utf8"));
    const counts: Record<string, number> = {};
    for (const d of spec.decls) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
    console.log(JSON.stringify(counts));
  } catch (e) {
    if (e instanceof SpecError) { console.error(e.message); process.exit(2); }
    throw e;
  }
} else if (cmd === "scenarios") {
  const [specPath, scenarioDir, goldenDir] = args;
  const spec = parse(readFileSync(specPath, "utf8"));
  const r = runAll(spec, scenarioDir, goldenDir);
  for (const d of r.diffs) console.log(`DIFF ${d.scenario} — ${d.where}
  expected ${JSON.stringify(d.expected)}
  actual   ${JSON.stringify(d.actual)}`);
  console.log(`${r.total - r.failed}/${r.total} scenarios match the oracle`);
  process.exit(r.failed ? 1 : 0);
} else if (cmd === "run") {
  // run <spec.crud> <scenario.json>: prints each action's outcome and the final state.
  let spec;
  try { spec = parse(readFileSync(args[0], "utf8")); }
  catch (e) { if (e instanceof SpecError) { console.error(e.message); process.exit(2); } throw e; }
  console.log(JSON.stringify(runOnly(spec, JSON.parse(readFileSync(args[1], "utf8"))), null, 2));
} else if (cmd === "check") {
  // check <spec.crud> [--scope <scope.json>] [--json]: exit 0 when there are no errors, 1 when there are.
  const specPath = args[0];
  const scopePath = args.includes("--scope") ? args[args.indexOf("--scope") + 1] : specPath.replace(/\.crud$/, ".scope.json");
  let spec;
  try { spec = parse(readFileSync(specPath, "utf8")); }
  catch (e) {
    if (e instanceof SpecError) { console.log(`error PARSE: ${e.message}`); console.log("1 errors, 0 warnings"); process.exit(1); }
    throw e;
  }
  const t0 = Date.now();
  const r = check(spec, JSON.parse(readFileSync(scopePath, "utf8")));
  if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    for (const f of r.findings) {
      console.log(`${f.severity} ${f.code} [${f.where}]: ${f.message}`);
      if (f.trace?.length) for (const step of f.trace) console.log(`    ${step}`);
    }
    console.log(`${r.errors} errors, ${r.warnings} warnings (${r.stats.states ?? 0} states, ${r.stats.runs ?? 0} runs, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  process.exit(r.errors ? 1 : 0);
} else {
  console.error("usage: cli.ts parse <spec.crud> | scenarios <spec.crud> <scenario-dir> <golden-dir> | run <spec.crud> <scenario.json> | check <spec.crud> [--scope <scope.json>] [--json]");
  process.exit(1);
}
