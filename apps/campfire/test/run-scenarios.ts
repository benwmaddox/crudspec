// Runs Campfire oracle scenarios through the interpreter and compares with Rails goldens.
//   node apps/campfire/test/run-scenarios.ts <spec.crud> <scenario-dir> <golden-dir>
import { readFileSync } from "node:fs";
import { parse } from "../../../lang/parser.ts";
import { runAll } from "./scenario.ts";

const [specPath, scenDir, goldenDir] = process.argv.slice(2);
const r = runAll(parse(readFileSync(specPath, "utf8")), scenDir, goldenDir);
for (const d of r.diffs) console.log(`DIFF ${d.scenario} — ${d.where}\n  expected ${JSON.stringify(d.expected)}\n  actual   ${JSON.stringify(d.actual)}`);
console.log(`${r.total - r.failed}/${r.total} scenarios match the oracle`);
process.exit(r.failed ? 1 : 0);
