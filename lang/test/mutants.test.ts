// The checker's catch rate on misspelled names (lang/test/mutants.ts) stays where it is: what
// it misses in the sample apps are names whose slip changes nothing the checker could know (a
// widget's parameter names, which its Go reads by position; a view parameter named as an ambient
// one, typed, which the ambient then stands in for).
//   node lang/test/mutants.test.ts
import { spawnSync } from "node:child_process";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: string) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail) console.log(detail); } };
// swap: a field read for another of another type; what's left are mostly text-like fields swapped
// (Text, Email, Url, Password), which types can't tell apart; unguard: a require removed, which
// is a finding when the action's siblings make the check (GUARD_MISSING) or nothing else checks the
// actor (WRITE_UNCHECKED); a validation removed is mostly not one
for (const [app, op, misses] of [["apps/tasks", "typo", 1], ["apps/todomvc", "typo", 3], ["apps/tasks", "swap", 10], ["apps/todomvc", "swap", 1], ["apps/tasks", "unguard", 13], ["apps/tasks", "attr", 0], ["apps/todomvc", "attr", 0], ["apps/tasks", "keyword", 0], ["app3", "typo", 0], ["app3", "attr", 0], ["app3", "keyword", 0], ["app3", "unguard", 16]] as const) {
  const r = spawnSync(process.execPath, ["--no-warnings", "lang/test/mutants.ts", app, "--op", op], { encoding: "utf8" });
  const m = /: (\d+)\/(\d+) caught/.exec(r.stdout);
  const missed = m ? Number(m[2]) - Number(m[1]) : NaN;
  ok(`${app} ${op}: every mutant caught but the ${misses} known`, missed <= misses, r.stdout + r.stderr);
  // a misspelled name where it is used: the error says the name meant
  const s = /(\d+) of (\d+) at uses suggest the name meant/.exec(r.stdout);
  // (keyword: but for the one renaming a layout called app, whose uses rightly suggest the new name)
  if (op === "typo" || op === "attr" || op === "keyword") ok(`${app} ${op}: the error suggests the name meant`, !!s && Number(s[2]) - Number(s[1]) <= (op === "keyword" ? 1 : 0), r.stdout);
}
// a } removed: the error names the { it leaves open
for (const app of ["apps/tasks", "apps/todomvc", "app3"]) {
  const r = spawnSync(process.execPath, ["--no-warnings", "lang/test/mutants.ts", app, "--op", "unbrace"], { encoding: "utf8" });
  const m = /: (\d+)\/(\d+) caught.*; (\d+) name the \{ left open/.exec(r.stdout);
  ok(`${app} unbrace: every } removed is an error naming the { left open`, !!m && m[1] === m[2] && m[3] === m[2], r.stdout);
}
process.exit(failed ? 1 : 0);
