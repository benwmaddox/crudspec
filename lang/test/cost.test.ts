// Cost analysis tests: query cost model, index detection, and warnings.
//   node lang/test/cost.test.ts
import { readFileSync } from "node:fs";
import { parse } from "../parser.ts";
import { costCheck, getQueries } from "../cost.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => {
  console.log(`${pass ? "ok  " : "FAIL"} ${what}`);
  if (!pass) {
    failed++;
    if (detail) console.log(JSON.stringify(detail, null, 2));
  }
};

// Parse the test spec
const campfire = readFileSync("apps/campfire/campfire.crud", "utf8");
const spec = parse(campfire);

// Basic cost check - should not throw
try {
  const findings = costCheck(spec);
  ok("costCheck runs without error", true);
  ok("costCheck returns findings array", Array.isArray(findings), findings);
} catch (e) {
  ok("costCheck runs without error", false, e);
}

// Test with empty queries (no generation)
try {
  const emptyQueries = getQueries();
  ok("getQueries returns empty initially", emptyQueries.length === 0);
} catch (e) {
  ok("getQueries returns empty initially", false, e);
}

if (failed) {
  console.log(`${failed} tests failed`);
  process.exit(1);
}
console.log("all passed");
process.exit(0);
