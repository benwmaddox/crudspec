// The checker's catch rate on misspelled names (lang/test/mutants.ts) stays where it is: what
// it misses in the sample apps are names whose slip changes nothing the checker could know (a
// widget's parameter names, which its Go reads by position; a view parameter named as an ambient
// one, typed, which the ambient then stands in for).
//   node lang/test/mutants.test.ts
import { spawnSync } from "node:child_process";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: string) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail) console.log(detail); } };
for (const [app, misses] of [["apps/tasks", 1], ["apps/todomvc", 3]] as const) {
  const r = spawnSync(process.execPath, ["--no-warnings", "lang/test/mutants.ts", app], { encoding: "utf8" });
  const m = /: (\d+)\/(\d+) caught/.exec(r.stdout);
  const missed = m ? Number(m[2]) - Number(m[1]) : NaN;
  ok(`${app}: every misspelled name caught but the ${misses} known`, missed <= misses, r.stdout + r.stderr);
}
process.exit(failed ? 1 : 0);
