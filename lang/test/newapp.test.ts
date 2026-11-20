// node lang/cli.ts new: the app it makes checks clean, has tests for its actions, and its files
// are all there (building and running it is the same as any app's; the release's check covers it)
//   node lang/test/newapp.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { readSpec } from "../source.ts";
import { newApp } from "../newapp.ts";
import { testPlan, planSummary } from "../testplan.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };
const dir = join(mkdtempSync(join(tmpdir(), "crudspec-new-")), "my-app");
try {
  const made = newApp(dir, "My App");
  ok("it makes the app, its tests, AGENTS.md, the fetch scripts and the check", ["app/app.crud", "app/tests.crud", "AGENTS.md", "get-crudspec.sh", "get-crudspec.ps1", ".github/workflows/check.yml", ".crudspec-version"].every((f) => made.includes(f) && existsSync(join(dir, f))), made);
  const spec = parse(readSpec(join(dir, "app")));
  const findings = [...check(spec, { dir: join(dir, "app") }), ...typecheck(spec).findings];
  ok("the app checks clean, with no warnings", findings.length === 0, findings.map((f) => `${f.code} ${f.message}`));
  const s = planSummary(testPlan(spec));
  ok("its tests cover most of its outcomes", s.covered >= 8 && s.untested === 0, s);
  let refused = false; try { newApp(dir, "Again"); } catch { refused = true; }
  ok("a folder with files in it is refused", refused);
} finally { rmSync(join(dir, ".."), { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
