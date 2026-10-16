import { readFileSync } from "node:fs";
import { parse, SpecError } from "./parser.ts";
import { runAll } from "./scenario.ts";

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
} else {
  console.error("usage: cli.ts parse <spec.crud> | scenarios <spec.crud> <scenario-dir> <golden-dir>");
  process.exit(1);
}
